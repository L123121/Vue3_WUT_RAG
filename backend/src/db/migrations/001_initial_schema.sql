-- 兼容现有 store.db：所有对象均使用 IF NOT EXISTS，首次启动和旧库升级都安全。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  student_id    TEXT NOT NULL DEFAULT '',
  approved      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hash (
  key   TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (key, field)
);

CREATE TABLE IF NOT EXISTS sets (
  key    TEXT NOT NULL,
  member TEXT NOT NULL,
  PRIMARY KEY (key, member)
);

CREATE TABLE IF NOT EXISTS list (
  key   TEXT NOT NULL,
  idx   INTEGER NOT NULL,
  value TEXT,
  PRIMARY KEY (key, idx)
);

CREATE TABLE IF NOT EXISTS operational_metrics_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
