PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  recovery_hash BLOB NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at INTEGER NOT NULL,
  banned_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash BLOB PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  article_key TEXT NOT NULL,
  parent_id TEXT REFERENCES comments(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  hidden_at INTEGER
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  storage_name TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry
ON sessions(user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_comments_article_created
ON comments(article_key, created_at, id);

CREATE INDEX IF NOT EXISTS idx_comments_parent
ON comments(parent_id);

CREATE INDEX IF NOT EXISTS idx_attachments_comment
ON attachments(comment_id);

CREATE INDEX IF NOT EXISTS idx_attachments_unclaimed
ON attachments(created_at)
WHERE comment_id IS NULL;

PRAGMA optimize;
