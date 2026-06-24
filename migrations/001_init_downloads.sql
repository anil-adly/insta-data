CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_url TEXT NOT NULL UNIQUE,
  shortcode TEXT,
  topic TEXT,
  is_video INTEGER DEFAULT 1,
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  caption TEXT,
  uploader TEXT,
  posted_at TEXT,
  duration_seconds INTEGER,
  status TEXT NOT NULL DEFAULT 'discovered',
  audio_path TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  downloaded_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
CREATE INDEX IF NOT EXISTS idx_downloads_topic ON downloads(topic);
