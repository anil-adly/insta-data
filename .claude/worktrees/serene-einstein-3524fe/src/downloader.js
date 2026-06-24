import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Checks that yt-dlp is installed on the system.
 * yt-dlp is used to download the raw video from an Instagram post URL.
 * Install with: brew install yt-dlp
 */
async function checkYtDlp() {
  try {
    await execFileAsync("yt-dlp", ["--version"]);
  } catch {
    throw new Error(
      "yt-dlp is not installed. Install it with:\n  brew install yt-dlp",
    );
  }
}

/**
 * Converts the Playwright session (auth/session.json) into a Netscape-format
 * cookies.txt file that yt-dlp can consume via `--cookies`.
 *
 * Playwright runs its own bundled Chromium with an isolated user-data dir, so
 * `--cookies-from-browser chromium` cannot find the logged-in session. We
 * instead export the cookies Playwright saved in storageState.
 *
 * @returns {string} Absolute path to the generated cookies.txt
 */
function buildCookieFile() {
  const statePath = config.auth.statePath;
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `No saved session found at ${statePath}. Run the app to log in first.`,
    );
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (err) {
    throw new Error(`Could not read session file: ${err.message}`);
  }

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  if (cookies.length === 0) {
    throw new Error(
      "Saved session has no cookies. Re-run with --fresh-login to log in again.",
    );
  }

  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of cookies) {
    if (!c.domain || !c.name) continue;
    const includeSubdomains = c.domain.startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    // Playwright stores `expires` in seconds; -1 marks a session cookie.
    const expiry =
      Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push(
      [
        c.domain,
        includeSubdomains,
        cookiePath,
        secure,
        expiry,
        c.name,
        c.value,
      ].join("\t"),
    );
  }

  const cookiesPath = path.join(path.dirname(statePath), "cookies.txt");
  fs.writeFileSync(cookiesPath, lines.join("\n") + "\n", { mode: 0o600 });
  return cookiesPath;
}

let cachedCookieFile = null;

/**
 * Returns the path to the cookies.txt for yt-dlp, building it once per run.
 */
function getCookieFile() {
  if (cachedCookieFile && fs.existsSync(cachedCookieFile)) {
    return cachedCookieFile;
  }
  cachedCookieFile = buildCookieFile();
  return cachedCookieFile;
}

/**
 * Fetches metadata for a post without downloading media.
 * Returns normalized fields useful for tracking analytics.
 */
export async function fetchVideoMetadata(postUrl) {
  await checkYtDlp();

  let cookieFile;
  try {
    cookieFile = getCookieFile();
  } catch {
    return null;
  }

  const args = [
    "--cookies",
    cookieFile,
    "--skip-download",
    "--dump-single-json",
    postUrl,
  ];

  let stdout;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", args));
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(stdout);
    return {
      view_count: Number.isFinite(parsed.view_count) ? parsed.view_count : null,
      like_count: Number.isFinite(parsed.like_count) ? parsed.like_count : null,
      comment_count: Number.isFinite(parsed.comment_count)
        ? parsed.comment_count
        : null,
      caption: parsed.description || parsed.title || null,
      uploader: parsed.uploader || parsed.uploader_id || null,
      posted_at: parsed.upload_date || null,
      duration_seconds: Number.isFinite(parsed.duration)
        ? parsed.duration
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Downloads the best available audio track from an Instagram post and saves it
 * losslessly as an .m4a (AAC).
 *
 * Instagram serves audio as AAC inside an MP4/M4A container, so selecting
 * `bestaudio` and remuxing to m4a is a stream copy — yt-dlp does NOT re-encode
 * when the source is already AAC. That means zero generational quality loss,
 * and it is faster and smaller than transcoding to MP3.
 *
 * @param {string} postUrl   - Full Instagram post / reel URL
 * @param {string} outputDir - Directory to save the file into
 * @returns {Promise<string>} Absolute path to the saved .m4a
 */
export async function downloadAndExtractAudio(
  postUrl,
  outputDir = config.downloads.dir,
) {
  await checkYtDlp();

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // yt-dlp template: saves as <post-id>.m4a inside outputDir
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");

  console.log(`Downloading audio: ${postUrl}`);

  // Feed yt-dlp the logged-in session exported from Playwright's storageState.
  //   -f bestaudio/best     → grab the highest-quality standalone audio stream
  //   -x --audio-format m4a → extract audio, remuxing (copying) the AAC stream
  //                           with no re-encode when the source is already AAC
  const args = [
    "--cookies",
    getCookieFile(),
    "--format",
    "bestaudio/best",
    "--extract-audio",
    "--audio-format",
    "m4a",
    "--audio-quality",
    "0",
    "--output",
    outputTemplate,
    "--print",
    "after_move:filepath", // print final file path to stdout
    "--no-simulate", // --print alone can imply simulate; force the download
    postUrl,
  ];

  let stdout;
  try {
    ({ stdout } = await execFileAsync("yt-dlp", args));
  } catch (err) {
    throw new Error(`yt-dlp failed: ${err.message}\n${err.stderr || ""}`);
  }

  const audioPath = stdout.trim().split("\n").pop(); // last line = filepath
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw new Error(`yt-dlp did not produce a file at: ${audioPath}`);
  }

  console.log(`✓ Audio saved: ${audioPath}`);
  return audioPath;
}
