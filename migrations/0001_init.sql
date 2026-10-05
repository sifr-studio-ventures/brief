CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  platform TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  cookies_enc TEXT,
  label TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  targets TEXT NOT NULL,
  held_platforms TEXT NOT NULL DEFAULT '[]',
  schedule_at INTEGER,
  posted_at INTEGER,
  x_post_id TEXT,
  linkedin_post_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_time (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS x_query_ids (
  operation TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS x_features (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS posts_status_schedule ON posts (status, schedule_at);
CREATE INDEX IF NOT EXISTS post_media_post ON post_media (post_id);
CREATE INDEX IF NOT EXISTS session_time_day ON session_time (day);
