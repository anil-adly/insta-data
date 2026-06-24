#!/usr/bin/env node
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { login, searchVideos } from "./instagram.js";
import { downloadAndExtractAudio, fetchVideoMetadata } from "./downloader.js";
import { fetchInstagramViewCount } from "./instagramApi.js";
import { config } from "./config.js";
import {
  closeDb,
  getRecord,
  getRecentFailures,
  getRowsMissingViews,
  getStatusCounts,
  getTopLikedPosts,
  markDownloaded,
  markFailed,
  markProcessing,
  updatePostMetrics,
  upsertDiscoveredPosts,
} from "./db.js";
import fs from "fs";

function getArgsTokens() {
  const direct = process.argv.slice(2);
  if (direct.length > 0) return direct;

  try {
    const raw = process.env.npm_config_argv;
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const original = Array.isArray(parsed?.original) ? parsed.original : [];
    return original.filter(
      (arg) => arg !== "start" && arg !== "run" && arg !== "--",
    );
  } catch {
    return [];
  }
}

function parseCliArgs(tokens) {
  const flags = new Set();
  const topicTokens = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = (tokens[i] || "").trim();
    if (!token) continue;

    if (token === "--fresh-login" || token === "fresh-login") {
      flags.add("fresh-login");
      continue;
    }

    if (
      token === "--report" ||
      token === "report" ||
      token === "--stats" ||
      token === "stats"
    ) {
      flags.add("report");
      continue;
    }

    if (
      token === "--backfill-views" ||
      token === "backfill-views" ||
      token === "--backfill"
    ) {
      flags.add("backfill-views");
      continue;
    }

    topicTokens.push(token);
  }

  return {
    flags,
    topic: topicTokens.join(" ").trim(),
  };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

// Delay between media-info requests during a backfill, to stay gentle on
// Instagram's rate limits. Override with BACKFILL_DELAY_MS.
const BACKFILL_DELAY_MS = Number.parseInt(
  process.env.BACKFILL_DELAY_MS || "1200",
  10,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseReportOptions(tokens) {
  const options = {
    topic: "",
    status: "",
    limit: 5,
    sinceIso: "",
  };

  const readValue = (index) => {
    const value = tokens[index + 1];
    return typeof value === "string" ? value.trim() : "";
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = (tokens[i] || "").trim();
    if (!token) continue;

    const [key, inlineValue] = token.split("=", 2);

    if (key === "--topic" || key === "-t") {
      const value = (inlineValue || readValue(i)).trim();
      if (!inlineValue) i += 1;
      if (value) options.topic = value;
      continue;
    }

    if (key === "--status" || key === "-s") {
      const value = (inlineValue || readValue(i)).trim().toLowerCase();
      if (!inlineValue) i += 1;
      if (value) options.status = value;
      continue;
    }

    if (key === "--limit" || key === "-l") {
      const value = inlineValue || readValue(i);
      if (!inlineValue) i += 1;
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = Math.min(parsed, 100);
      }
      continue;
    }

    if (key === "--days" || key === "-d") {
      const value = inlineValue || readValue(i);
      if (!inlineValue) i += 1;
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        const sinceMs = Date.now() - parsed * 24 * 60 * 60 * 1000;
        options.sinceIso = new Date(sinceMs).toISOString();
      }
      continue;
    }

    if (key === "--since") {
      const value = (inlineValue || readValue(i)).trim();
      if (!inlineValue) i += 1;
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) {
        options.sinceIso = new Date(timestamp).toISOString();
      }
    }
  }

  return options;
}

function hasFreshLoginFlag(tokens) {
  return tokens.some(
    (token) => token === "--fresh-login" || token === "fresh-login",
  );
}

function showDbReport(options = {}) {
  const filters = {
    topic: options.topic || "",
    status: options.status || "",
    sinceIso: options.sinceIso || "",
  };
  const limit = Number.isFinite(options.limit) ? options.limit : 5;

  const counts = getStatusCounts(filters);
  const topLiked = getTopLikedPosts(limit, filters);
  const failures = getRecentFailures(limit, filters);

  const countMap = Object.fromEntries(
    counts.map((row) => [row.status, row.count]),
  );
  const downloaded = countMap.downloaded || 0;
  const total = counts.reduce((sum, row) => sum + row.count, 0);
  const notDownloaded = total - downloaded;

  console.log(chalk.bold.cyan("\n📊 Download Report\n"));
  if (filters.topic || filters.status || filters.sinceIso) {
    const activeFilters = [];
    if (filters.topic) activeFilters.push(`topic=${filters.topic}`);
    if (filters.status) activeFilters.push(`status=${filters.status}`);
    if (filters.sinceIso) activeFilters.push(`since=${filters.sinceIso}`);
    console.log(chalk.dim(`Filters: ${activeFilters.join(", ")}`));
    console.log("");
  }
  console.log(chalk.white(`Total tracked: ${formatNumber(total)}`));
  console.log(chalk.white(`Downloaded: ${formatNumber(downloaded)}`));
  console.log(chalk.white(`Not downloaded: ${formatNumber(notDownloaded)}\n`));

  if (counts.length > 0) {
    console.log(chalk.bold("Status counts"));
    for (const row of counts) {
      console.log(`- ${row.status}: ${formatNumber(row.count)}`);
    }
    console.log("");
  }

  console.log(chalk.bold("Top liked posts"));
  if (topLiked.length === 0) {
    console.log("- No like data found yet.\n");
  } else {
    for (const row of topLiked) {
      console.log(
        `- likes=${formatNumber(row.like_count)} views=${formatNumber(row.view_count)} comments=${formatNumber(row.comment_count)} status=${row.status} url=${row.post_url}`,
      );
    }
    console.log("");
  }

  console.log(chalk.bold("Recent failures"));
  if (failures.length === 0) {
    console.log("- No failed downloads found.\n");
  } else {
    for (const row of failures) {
      console.log(
        `- ${row.updated_at} attempts=${formatNumber(row.attempts)} url=${row.post_url}`,
      );
      console.log(`  error: ${row.last_error || "Unknown error"}`);
    }
    console.log("");
  }

  console.log(chalk.dim(`SQLite DB: ${process.cwd()}/data/downloads.sqlite`));
}

/**
 * Fills in missing view counts on existing rows by querying Instagram's
 * media-info endpoint. yt-dlp never populated these, so this recovers them
 * after the fact. Safe to re-run — it only touches rows where view_count IS NULL.
 */
async function backfillViews(options = {}) {
  const filters = {
    topic: options.topic || "",
    sinceIso: options.sinceIso || "",
  };
  const limit = Number.isFinite(options.limit) ? options.limit : undefined;
  const rows = getRowsMissingViews(filters, limit);

  if (rows.length === 0) {
    console.log(
      chalk.yellow("No rows are missing a view count. Nothing to backfill."),
    );
    return;
  }

  console.log(
    chalk.bold.cyan(`\n👁  Backfilling views for ${rows.length} post(s)…\n`),
  );

  let updated = 0;
  let unavailable = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const label = `[${i + 1}/${rows.length}] ${row.post_url}`;
    const spinner = ora(label).start();

    try {
      const views = await fetchInstagramViewCount(row.post_url);
      if (Number.isFinite(views)) {
        updatePostMetrics(row.post_url, { view_count: views });
        updated += 1;
        spinner.succeed(
          chalk.green(`views=${formatNumber(views)} → ${row.post_url}`),
        );
      } else {
        unavailable += 1;
        spinner.warn(chalk.dim(`no view count available → ${row.post_url}`));
      }
    } catch (err) {
      failed += 1;
      spinner.fail(chalk.red(`error: ${err.message} → ${row.post_url}`));
    }

    if (i < rows.length - 1) await sleep(BACKFILL_DELAY_MS);
  }

  console.log(
    chalk.bold(
      `\nDone. updated=${updated} unavailable=${unavailable} failed=${failed}`,
    ),
  );
}

function getTopicFromArgs() {
  const directArgs = getArgsTokens().join(" ").trim();
  if (directArgs) return directArgs;
  return "";
}

async function main() {
  const tokens = getArgsTokens();
  const parsedArgs = parseCliArgs(tokens);
  const cliArg = parsedArgs.topic;
  const freshLogin = parsedArgs.flags.has("fresh-login");
  const isReportMode = parsedArgs.flags.has("report");
  const isBackfillMode = parsedArgs.flags.has("backfill-views");

  if (isReportMode) {
    try {
      const reportOptions = parseReportOptions(tokens);
      showDbReport(reportOptions);
    } catch (err) {
      console.error(chalk.red(`\nReport failed: ${err.message}`));
      process.exitCode = 1;
    } finally {
      closeDb();
    }
    return;
  }

  if (isBackfillMode) {
    try {
      const options = parseReportOptions(tokens);
      // parseReportOptions defaults limit to 5; for a backfill we process
      // everything unless the user explicitly passed --limit / -l.
      const limitGiven = tokens.some(
        (t) => t === "--limit" || t === "-l" || /^(--limit|-l)=/.test(t),
      );
      if (!limitGiven) options.limit = undefined;
      await backfillViews(options);
    } catch (err) {
      console.error(chalk.red(`\nBackfill failed: ${err.message}`));
      process.exitCode = 1;
    } finally {
      closeDb();
    }
    return;
  }

  console.log(chalk.bold.magenta("\n🎵 Instagram Audio Downloader\n"));

  // ── Step 1: Launch browser & log in ───────────────────────────────────────
  const loginSpinner = ora("Launching browser…").start();
  let browser, page;
  try {
    ({ browser, page } = await login({ freshLogin }));
    loginSpinner.succeed("Browser ready.");
  } catch (err) {
    loginSpinner.fail(`Login failed: ${err.message}`);
    process.exit(1);
  }

  try {
    // ── Step 2: Ask the user what to search ─────────────────────────────────
    let topic = cliArg;
    if (!topic) {
      const answer = await inquirer.prompt([
        {
          type: "input",
          name: "topic",
          message: 'Enter a search topic (e.g. "lofi music"):',
          validate: (v) => v.trim().length > 0 || "Topic cannot be empty.",
        },
      ]);
      topic = answer.topic.trim();
    } else {
      console.log(chalk.dim(`Using search topic from CLI: "${topic}"`));
    }

    // ── Step 3: Search for videos ────────────────────────────────────────────
    // Search the hashtag form first (e.g. "#frequency" → ?q=%23frequency),
    // since that surfaces the most reels. Fall back to the plain keyword.
    const plainTopic = topic.trim().replace(/^#+/, "");
    const hashtagTopic = `#${plainTopic}`;

    const searchSpinner = ora(`Searching for "${hashtagTopic}"…`).start();
    let videos;
    let usedTopic = hashtagTopic;
    try {
      videos = await searchVideos(page, hashtagTopic);

      // If the hashtag search returns nothing, retry with the plain keyword.
      if (videos.length === 0 && plainTopic) {
        searchSpinner.text = `No videos found. Retrying with "${plainTopic}"…`;
        videos = await searchVideos(page, plainTopic);
        usedTopic = plainTopic;
      }

      searchSpinner.succeed(`Found ${videos.length} video(s).`);
    } catch (err) {
      searchSpinner.fail(`Search failed: ${err.message}`);
      await browser.close();
      process.exit(1);
    }

    if (videos.length === 0) {
      console.log(
        chalk.yellow(
          "No videos found for that topic. Try a different keyword.",
        ),
      );
      await browser.close();
      return;
    }

    // Track discovered posts in SQLite immediately.
    upsertDiscoveredPosts(videos, usedTopic);

    // ── Step 4: Auto-select all found videos ─────────────────────────────────
    const selectedUrls = videos.map((v) => v.postUrl);
    console.log(chalk.dim(`Auto-selected ${selectedUrls.length} video(s).`));

    // ── Step 5: Close the browser before running yt-dlp ──────────────────────
    // The session was already saved to auth/session.json at login; yt-dlp reads
    // it via an exported cookies.txt, so the browser is no longer needed.
    console.log(chalk.dim("\nClosing browser…"));
    await browser.close();

    // ── Step 6: Download & extract audio ────────────────────────────────────
    console.log(chalk.cyan(`\nDownloading to: ${config.downloads.dir}\n`));

    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    for (const url of selectedUrls) {
      const dlSpinner = ora(`Processing: ${url}`).start();

      const existing = getRecord(url);
      if (
        existing?.status === "downloaded" &&
        existing?.audio_path &&
        fs.existsSync(existing.audio_path)
      ) {
        skippedCount += 1;
        dlSpinner.info(
          chalk.cyan(`Already downloaded → ${existing.audio_path}`),
        );
        continue;
      }

      try {
        markProcessing(url);

        const metadata = await fetchVideoMetadata(url);
        if (metadata) updatePostMetrics(url, metadata);

        const audioPath = await downloadAndExtractAudio(url);
        markDownloaded(url, audioPath);
        successCount += 1;
        dlSpinner.succeed(chalk.green(`Audio saved → ${audioPath}`));
      } catch (err) {
        failCount += 1;
        markFailed(url, err.message);
        dlSpinner.fail(chalk.red(`Failed: ${err.message}`));
      }
    }

    console.log(
      chalk.dim(
        `Run summary: success=${successCount}, failed=${failCount}, skipped=${skippedCount}`,
      ),
    );
    console.log(chalk.dim(`SQLite DB: ${process.cwd()}/data/downloads.sqlite`));

    console.log(chalk.bold.green("\n✅ Done!\n"));
  } catch (err) {
    console.error(chalk.red(`\nUnexpected error: ${err.message}`));
    await browser.close().catch(() => {});
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
