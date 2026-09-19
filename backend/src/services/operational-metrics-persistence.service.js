'use strict';

const { logEvent } = require('./observability.service');

const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '../../data/store.db');

class OperationalMetricsPersistence {
  constructor(options = {}) {
    this.dbPath = options.dbPath || process.env.OPS_METRICS_DB_PATH || DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    const Database = options.Database || require('better-sqlite3');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operational_metrics_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.readState = this.db.prepare('SELECT state_json FROM operational_metrics_state WHERE id = 1');
    this.writeState = this.db.prepare(`
      INSERT INTO operational_metrics_state (id, state_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
  }

  load() {
    const row = this.readState.get();
    if (!row?.state_json) return null;
    try {
      return JSON.parse(row.state_json);
    } catch (error) {
      logEvent('warn', 'op_metrics_state_parse_failed_reset', { error: error.message });
      return null;
    }
  }

  save(state) {
    this.writeState.run(JSON.stringify(state), Date.now());
  }

  close() {
    if (!this.db?.open) return;
    this.db.close();
  }
}

function createDefaultOperationalMetricsPersistence() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST || process.env.OPS_METRICS_PERSISTENCE === 'false') {
    return null;
  }
  try {
    return new OperationalMetricsPersistence();
  } catch (error) {
    logEvent('warn', 'op_metrics_persistence_init_failed_memory_only', { error: error.message });
    return null;
  }
}

module.exports = {
  OperationalMetricsPersistence,
  createDefaultOperationalMetricsPersistence,
};
