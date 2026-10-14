-- Reaction bot schema (libSQL / SQLite)

CREATE TABLE IF NOT EXISTS expressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '[]',
  caption_template TEXT NOT NULL DEFAULT '{from} {action} {to}!',
  is_lewd INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL UNIQUE,
  phash TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  is_lewd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per-chat settings (lewd mode, bluetext mode, locked commands)
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id INTEGER PRIMARY KEY,
  lewd_mode INTEGER NOT NULL DEFAULT 0,
  bluetext INTEGER NOT NULL DEFAULT 1,
  disabled_commands TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS media_expressions (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  expression_id INTEGER NOT NULL REFERENCES expressions(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, expression_id)
);

CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  added_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS search_cache (
  file_unique_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (file_unique_id, provider)
);

-- grammY conversation/session state shared by local polling and webhook instances.
CREATE TABLE IF NOT EXISTS bot_sessions (
  session_key TEXT PRIMARY KEY,
  session_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_media_expressions_expr ON media_expressions(expression_id);
CREATE INDEX IF NOT EXISTS idx_media_expressions_media ON media_expressions(media_id);
CREATE INDEX IF NOT EXISTS idx_search_cache_provider ON search_cache(provider, created_at);
