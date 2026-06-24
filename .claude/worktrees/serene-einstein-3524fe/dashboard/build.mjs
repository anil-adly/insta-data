#!/usr/bin/env node
/**
 * Build the static dashboard data.
 *
 * Reads the crawler's SQLite database and produces a fully static snapshot the
 * dashboard can serve without any backend:
 *   - dashboard/data.json   all rows + metadata, read by index.html at load
 *   - dashboard/audio/*.m4a  copies of the audio files referenced by each row
 *
 * Run this locally from the repo root whenever the crawler has new data:
 *   node dashboard/build.mjs
 *
 * Netlify never runs this script (it has no access to the DB or audio); it only
 * serves the committed output. That's why the generated files are committed.
 *
 * Source locations can be overridden with env vars (used when the DB/audio live
 * outside the repo, e.g. building from a git worktree):
 *   DASHBOARD_SQLITE     path to downloads.sqlite   (default: ../data/downloads.sqlite)
 *   DASHBOARD_AUDIO_SRC  folder holding the .m4a     (default: ../downloads)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dashboardDir, "..");

const sqlitePath =
  process.env.DASHBOARD_SQLITE || path.join(repoRoot, "data", "downloads.sqlite");
const audioSrcDir =
  process.env.DASHBOARD_AUDIO_SRC || path.join(repoRoot, "downloads");

const dataJsonPath = path.join(dashboardDir, "data.json");
const audioOutDir = path.join(dashboardDir, "audio");

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite database not found: ${sqlitePath}`);
  console.error("Set DASHBOARD_SQLITE to point at downloads.sqlite.");
  process.exit(1);
}

const db = new Database(sqlitePath, { readonly: true });

// Pull every column so the client has all fields the server used to expose
// (post_url, shortcode, caption, uploader, metrics, timestamps, etc.).
const rows = db
  .prepare(`SELECT * FROM downloads ORDER BY datetime(updated_at) DESC`)
  .all();

db.close();

// Reset the audio output folder so deleted/renamed files don't linger.
fs.rmSync(audioOutDir, { recursive: true, force: true });
fs.mkdirSync(audioOutDir, { recursive: true });

let copied = 0;
let missing = 0;

for (const row of rows) {
  const raw = (row.audio_path || "").trim();
  if (!raw) {
    row.audio_file = null;
    continue;
  }

  const base = path.basename(raw);
  row.audio_file = base;
  // Don't publish the crawler's local absolute path; expose only the filename.
  row.audio_path = base;

  // Resolve the source file: try the stored path first, then the audio source
  // folder by basename (paths in the DB may be relative to the crawler's cwd).
  const candidates = [
    path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw),
    path.join(audioSrcDir, base),
  ];
  const src = candidates.find((p) => fs.existsSync(p));

  if (!src) {
    missing += 1;
    continue;
  }

  fs.copyFileSync(src, path.join(audioOutDir, base));
  copied += 1;
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: path.basename(sqlitePath),
  rowCount: rows.length,
  rows,
};

fs.writeFileSync(dataJsonPath, JSON.stringify(payload));

const withAudio = rows.filter((r) => r.audio_file).length;
console.log(`Wrote ${dataJsonPath}`);
console.log(`  rows:        ${rows.length}`);
console.log(`  with audio:  ${withAudio}`);
console.log(`  copied .m4a: ${copied}${missing ? ` (missing ${missing})` : ""}`);
console.log(`  audio dir:   ${audioOutDir}`);
