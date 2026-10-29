CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_owner ON agent_runs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_schedule ON agent_runs(status, available_at, lease_until);

CREATE TABLE IF NOT EXISTS agent_runtime_kv (
  namespace TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (namespace, entry_key)
);
