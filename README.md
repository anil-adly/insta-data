# Instagram Audio Downloader

Search Instagram by topic or hashtag, collect video posts, download the audio losslessly as M4A (AAC), and track everything in SQLite.

## What it does

1. **Playwright + Chromium** logs into Instagram and reuses a saved session.
2. The search flow can **deep-scroll paginated results** and collect a large number of posts for a topic or hashtag.
3. **yt-dlp** fetches post metadata and downloads the best audio track using your browser cookies.
4. The audio is saved as **M4A (AAC)** — yt-dlp remuxes the original stream with no re-encode (via ffmpeg), so there is zero quality loss.
5. **SQLite** tracks discovered, processing, downloaded, and failed posts along with metrics such as likes and comments.
6. A local **dashboard** lets you browse reports, filter results, export CSV, and play saved audio.

## Prerequisites

| Tool         | Install               |
| ------------ | --------------------- |
| Node.js ≥ 18 | `brew install node`   |
| yt-dlp       | `brew install yt-dlp` |
| ffmpeg       | `brew install ffmpeg` (used by yt-dlp to remux audio) |

## Setup

```bash
# 1. Clone / open the project
cd instaAudioDownloader

# 2. Install Node dependencies & Chromium
npm install
npm run install-browsers

# 3. Create your .env file
cp .env.example .env
# Then edit .env and fill in INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD
```

## CLI usage

```bash
npm start
```

You can also pass the topic directly:

```bash
npm start -- "frequency"
npm start -- "#frequency"
```

If you switch Instagram accounts or want to ignore the saved session for one run, use:

```bash
npm start -- --fresh-login "#frequency"
```

The CLI will:

1. Open a Chromium window and log in to Instagram (first run only — session is saved to `auth/session.json`).
2. Search the topic and automatically retry as a hashtag if a plain text query returns no video posts.
3. Scroll through paginated search results and collect unique post URLs.
4. Apply SQL migrations from `migrations/` and store discovered posts in `data/downloads.sqlite`.
5. Skip posts that are already downloaded and still exist on disk.
6. Download the best audio for new posts into `downloads/` as lossless M4A.

## CLI report mode

The SQLite data can also be queried directly from the CLI:

```bash
npm start -- --report
```

Supported report aliases:

```bash
npm start -- report
npm start -- stats
```

Useful filter examples:

```bash
npm start -- --report --topic "#frequency"
npm start -- --report --status failed --days 7
npm start -- --report --topic "#frequency" --limit 10
npm start -- --report --since 2026-06-20T00:00:00Z
```

Supported report filters:

| Flag             | Description                             |
| ---------------- | --------------------------------------- |
| `--topic`, `-t`  | Filter by topic / hashtag               |
| `--status`, `-s` | Filter by status                        |
| `--days`, `-d`   | Show records updated in the last N days |
| `--since`        | Filter from a specific ISO date/time    |
| `--limit`, `-l`  | Limit top-liked / failure rows          |

## Backfilling view counts

yt-dlp does not report view counts for Instagram clips, so the `Views` column
is empty for posts. Instagram's own media-info endpoint still exposes them as
`play_count`, and the downloader now fills views in automatically on every new
download. To recover views for posts already in the database, run:

```bash
npm start -- --backfill-views
```

It only touches rows where the view count is still missing (most-liked first),
so it is safe to re-run. Narrow or cap the pass with the report filters:

```bash
npm start -- --backfill-views --topic "#frequency"
npm start -- --backfill-views --limit 50
```

The pass waits `BACKFILL_DELAY_MS` (default 1200 ms) between requests to stay
gentle on Instagram's rate limits.

## Dashboard

Launch a local dashboard with filters and reports:

```bash
npm run dashboard
```

Then open `http://localhost:4789`.

Dashboard features:

1. Filter by topic, status, since date/time, relative days, minimum likes, and free-text search.
2. Summary cards, status breakdown, top liked posts, recent failures, and paginated full rows.
3. **Export CSV** for the currently filtered dataset.
4. Row actions for opening the Instagram post and playing saved audio.
5. Inline mini player for audio playback (M4A) inside the dashboard.
6. Theme switcher for light, dark, and system modes.

The dashboard reads from:

```text
data/downloads.sqlite
```

`data/*.sqlite` is git-ignored. If the SQLite file is missing, the app creates it and applies tracked migrations to create empty tables.

## Project structure

```
instaAudioDownloader/
├── src/
│   ├── index.js        ← CLI entry point
│   ├── instagram.js    ← Playwright login + search
│   ├── downloader.js   ← yt-dlp lossless audio download (M4A)
│   ├── db.js           ← SQLite storage and reporting queries
│   ├── dashboard.js    ← local dashboard server
│   └── config.js       ← reads .env and exports settings
├── public/
│   └── dashboard.html  ← dashboard UI
├── migrations/
│   └── 001_init_downloads.sql
├── data/
│   └── downloads.sqlite  ← runtime file (git-ignored)
├── downloads/          ← M4A audio files saved here (git-ignored)
├── auth/               ← saved Playwright session (git-ignored)
├── .env.example
└── package.json
```

## Configuration (`.env`)

| Variable                   | Default       | Description                                               |
| -------------------------- | ------------- | --------------------------------------------------------- |
| `INSTAGRAM_USERNAME`       | —             | Your Instagram username                                   |
| `INSTAGRAM_PASSWORD`       | —             | Your Instagram password                                   |
| `DOWNLOAD_DIR`             | `./downloads` | Directory for downloaded audio files                      |
| `MAX_RESULTS`              | `10`          | Legacy limit used by some fallback logic                  |
| `SEARCH_MAX_SCROLL_ROUNDS` | `150`         | Max scroll rounds while collecting paginated results      |
| `SEARCH_NO_NEW_ROUNDS`     | `8`           | Stop after this many rounds with no new links             |
| `SEARCH_MAX_COLLECTED`     | `2000`        | Safety cap for total collected unique post links          |
| `SEARCH_VERIFY_LIMIT`      | `300`         | Max posts to verify if grid-level video detection is weak |
| `DASHBOARD_PORT`           | `4789`        | Local dashboard server port                               |

## Data model

The SQLite table stores, at minimum:

1. `post_url`, `shortcode`, `topic`
2. `status` such as `discovered`, `processing`, `downloaded`, `failed`
3. `audio_path`, `attempts`, `last_error`
4. `view_count`, `like_count`, `comment_count`
5. timestamps such as `discovered_at`, `downloaded_at`, `updated_at`

## Notes

- The browser runs **non-headless** so you can complete any 2-FA challenge manually on first login.
- After the first successful login the session is cached; subsequent runs skip the login page.
- yt-dlp authenticates using a `cookies.txt` exported from the Playwright session (`auth/session.json`), since Playwright's bundled Chromium uses an isolated profile that `--cookies-from-browser` cannot read.
- Search result collection is intentionally aggressive and can discover hundreds of posts for a popular hashtag.
- The dashboard audio player only works for files that already exist under `downloads/`.
- If you change Instagram accounts in `.env`, you can run `npm start -- --fresh-login` once, or delete `auth/session.json` if you want to force a clean login manually.
