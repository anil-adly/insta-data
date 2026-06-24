import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

let db;
const DB_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "downloads.sqlite");
const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function ensureMigrationsTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function runMigrations(conn) {
  ensureMigrationsTable(conn);

  const applied = new Set(
    conn
      .prepare(`SELECT name FROM schema_migrations`)
      .all()
      .map((row) => row.name),
  );

  const files = getMigrationFiles();
  if (files.length === 0) return;

  const insertApplied = conn.prepare(
    `INSERT INTO schema_migrations (name) VALUES (?)`,
  );

  const tx = conn.transaction(() => {
    for (const fileName of files) {
      if (applied.has(fileName)) continue;

      const sqlPath = path.join(MIGRATIONS_DIR, fileName);
      const sql = fs.readFileSync(sqlPath, "utf8");
      conn.exec(sql);
      insertApplied.run(fileName);
    }
  });

  tx();
}

function ensureDb() {
  if (db) return db;

  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  db = new Database(DB_PATH);
  runMigrations(db);

  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function extractShortcode(postUrl) {
  const match = postUrl.match(/\/(p|reel|tv)\/([^/?#]+)/i);
  return match?.[2] || null;
}

export function upsertDiscoveredPosts(posts, topic) {
  const conn = ensureDb();
  const stmt = conn.prepare(`
    INSERT INTO downloads (
      post_url, shortcode, topic, is_video, status, discovered_at, last_seen_at, updated_at
    ) VALUES (
      @post_url, @shortcode, @topic, @is_video, 'discovered', @now, @now, @now
    )
    ON CONFLICT(post_url) DO UPDATE SET
      topic = excluded.topic,
      is_video = excluded.is_video,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `);

  const now = nowIso();
  const tx = conn.transaction((items) => {
    for (const item of items) {
      stmt.run({
        post_url: item.postUrl,
        shortcode: extractShortcode(item.postUrl),
        topic,
        is_video: item.isVideo ? 1 : 0,
        now,
      });
    }
  });

  tx(posts);
}

export function markProcessing(postUrl) {
  const conn = ensureDb();
  conn
    .prepare(
      `
      UPDATE downloads
      SET status = 'processing',
          attempts = attempts + 1,
          updated_at = @now
      WHERE post_url = @post_url
    `,
    )
    .run({ post_url: postUrl, now: nowIso() });
}

export function markDownloaded(postUrl, audioPath) {
  const conn = ensureDb();
  conn
    .prepare(
      `
      UPDATE downloads
      SET status = 'downloaded',
          audio_path = @audio_path,
          last_error = NULL,
          downloaded_at = @now,
          updated_at = @now
      WHERE post_url = @post_url
    `,
    )
    .run({ post_url: postUrl, audio_path: audioPath, now: nowIso() });
}

export function markFailed(postUrl, errorMessage) {
  const conn = ensureDb();
  conn
    .prepare(
      `
      UPDATE downloads
      SET status = 'failed',
          last_error = @err,
          updated_at = @now
      WHERE post_url = @post_url
    `,
    )
    .run({
      post_url: postUrl,
      err: errorMessage?.slice(0, 2000) || "Unknown error",
      now: nowIso(),
    });
}

export function updatePostMetrics(postUrl, metrics = {}) {
  const conn = ensureDb();
  conn
    .prepare(
      `
      UPDATE downloads
      SET view_count = COALESCE(@view_count, view_count),
          like_count = COALESCE(@like_count, like_count),
          comment_count = COALESCE(@comment_count, comment_count),
          caption = COALESCE(@caption, caption),
          uploader = COALESCE(@uploader, uploader),
          posted_at = COALESCE(@posted_at, posted_at),
          duration_seconds = COALESCE(@duration_seconds, duration_seconds),
          updated_at = @now
      WHERE post_url = @post_url
    `,
    )
    .run({
      post_url: postUrl,
      view_count: Number.isFinite(metrics.view_count)
        ? metrics.view_count
        : null,
      like_count: Number.isFinite(metrics.like_count)
        ? metrics.like_count
        : null,
      comment_count: Number.isFinite(metrics.comment_count)
        ? metrics.comment_count
        : null,
      caption: metrics.caption || null,
      uploader: metrics.uploader || null,
      posted_at: metrics.posted_at || null,
      duration_seconds: Number.isFinite(metrics.duration_seconds)
        ? metrics.duration_seconds
        : null,
      now: nowIso(),
    });
}

export function getRecord(postUrl) {
  const conn = ensureDb();
  return (
    conn.prepare(`SELECT * FROM downloads WHERE post_url = ?`).get(postUrl) ||
    null
  );
}

/**
 * Returns video rows that have no view count yet, most-liked first so the
 * highest-value posts get backfilled before any rate limit kicks in.
 */
export function getRowsMissingViews(filters = {}, limit = 100000) {
  const conn = ensureDb();
  const params = {};
  const clauses = ["view_count IS NULL", "is_video = 1", "shortcode IS NOT NULL"];
  addCommonFilters(clauses, params, filters);
  params.limit = normalizeLimit(limit, 100000, 1000000);

  return conn
    .prepare(
      `
      SELECT post_url, shortcode
      FROM downloads
      WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(like_count, 0) DESC
      LIMIT @limit
    `,
    )
    .all(params);
}

function addCommonFilters(clauses, params, filters = {}) {
  const topicRaw = (filters.topic || "").trim();
  const statusRaw = (filters.status || "").trim();
  const sinceIsoRaw = (filters.sinceIso || "").trim();
  const searchTextRaw = (filters.searchText || "").trim();
  const minLikes = Number.parseInt(filters.minLikes, 10);

  if (topicRaw) {
    const topicPlain = topicRaw.replace(/^#+/, "");
    const topicHash = topicRaw.startsWith("#") ? topicRaw : `#${topicPlain}`;
    clauses.push(`topic IN (@topic_input, @topic_plain, @topic_hash)`);
    params.topic_input = topicRaw;
    params.topic_plain = topicPlain;
    params.topic_hash = topicHash;
  }

  if (statusRaw) {
    clauses.push(`status = @status`);
    params.status = statusRaw;
  }

  if (sinceIsoRaw) {
    clauses.push(`datetime(updated_at) >= datetime(@since_iso)`);
    params.since_iso = sinceIsoRaw;
  }

  if (searchTextRaw) {
    clauses.push(
      `(post_url LIKE @search_like OR COALESCE(caption, '') LIKE @search_like OR COALESCE(uploader, '') LIKE @search_like OR COALESCE(shortcode, '') LIKE @search_like)`,
    );
    params.search_like = `%${searchTextRaw}%`;
  }

  if (Number.isFinite(minLikes) && minLikes > 0) {
    clauses.push(`like_count >= @min_likes`);
    params.min_likes = minLikes;
  }
}

function normalizeLimit(value, fallback = 50, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeOffset(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function getStatusCounts(filters = {}) {
  const conn = ensureDb();
  const params = {};
  const clauses = [];
  addCommonFilters(clauses, params, filters);

  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  return conn
    .prepare(
      `
      SELECT status, COUNT(*) AS count
      FROM downloads
      ${whereClause}
      GROUP BY status
      ORDER BY count DESC
    `,
    )
    .all(params);
}

export function getTopLikedPosts(limit = 5, filters = {}) {
  const conn = ensureDb();
  const params = { limit };
  const clauses = [`like_count IS NOT NULL`];
  addCommonFilters(clauses, params, filters);

  const whereClause = `WHERE ${clauses.join(" AND ")}`;

  return conn
    .prepare(
      `
      SELECT post_url, like_count, view_count, comment_count, status, updated_at
      FROM downloads
      ${whereClause}
      ORDER BY like_count DESC
      LIMIT @limit
    `,
    )
    .all(params);
}

export function getRecentFailures(limit = 5, filters = {}) {
  const conn = ensureDb();
  const params = { limit };
  const clauses = [`status = 'failed'`];

  // Allow topic and since filter for failures view.
  addCommonFilters(clauses, params, {
    topic: filters.topic,
    sinceIso: filters.sinceIso,
  });

  const whereClause = `WHERE ${clauses.join(" AND ")}`;

  return conn
    .prepare(
      `
      SELECT post_url, last_error, attempts, updated_at
      FROM downloads
      ${whereClause}
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
    )
    .all(params);
}

export function getTotalCount(filters = {}) {
  const conn = ensureDb();
  const params = {};
  const clauses = [];
  addCommonFilters(clauses, params, filters);
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const row = conn
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM downloads
      ${whereClause}
    `,
    )
    .get(params);

  return row?.count || 0;
}

export function getDashboardRows(options = {}) {
  const conn = ensureDb();
  const filters = options.filters || {};
  const limit = normalizeLimit(options.limit, 50, 200);
  const offset = normalizeOffset(options.offset);
  const params = { limit, offset };
  const clauses = [];
  addCommonFilters(clauses, params, filters);
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  return conn
    .prepare(
      `
      SELECT
        post_url,
        topic,
        status,
        is_video,
        view_count,
        like_count,
        comment_count,
        uploader,
        caption,
        attempts,
        audio_path,
        last_error,
        discovered_at,
        downloaded_at,
        updated_at
      FROM downloads
      ${whereClause}
      ORDER BY datetime(updated_at) DESC
      LIMIT @limit OFFSET @offset
    `,
    )
    .all(params);
}

export function getDashboardExportRows(filters = {}, limit = 10000) {
  const conn = ensureDb();
  const normalizedLimit = normalizeLimit(limit, 10000, 25000);
  const params = { limit: normalizedLimit };
  const clauses = [];
  addCommonFilters(clauses, params, filters);
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  return conn
    .prepare(
      `
      SELECT
        post_url,
        topic,
        status,
        is_video,
        view_count,
        like_count,
        comment_count,
        uploader,
        caption,
        attempts,
        audio_path,
        last_error,
        discovered_at,
        downloaded_at,
        updated_at
      FROM downloads
      ${whereClause}
      ORDER BY datetime(updated_at) DESC
      LIMIT @limit
    `,
    )
    .all(params);
}

export function getDistinctTopics(limit = 200) {
  const conn = ensureDb();
  const normalizedLimit = normalizeLimit(limit, 200, 500);

  return conn
    .prepare(
      `
      SELECT topic, COUNT(*) AS count
      FROM downloads
      WHERE topic IS NOT NULL AND TRIM(topic) <> ''
      GROUP BY topic
      ORDER BY count DESC, topic ASC
      LIMIT ?
    `,
    )
    .all(normalizedLimit);
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
