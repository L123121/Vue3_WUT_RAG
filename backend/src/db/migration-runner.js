'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'store.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function getDatabasePath(options = {}) {
  return options.dbPath || process.env.SQLITE_DB_PATH || DEFAULT_DB_PATH;
}

function listMigrations(directory = MIGRATIONS_DIR) {
  return fs.readdirSync(directory)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort()
    .map((name) => ({
      version: name.split('_', 1)[0],
      name,
      filePath: path.join(directory, name),
    }));
}

function checksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 执行所有未应用的 SQLite migration。
 * migration runner 自己管理连接，完成后立即关闭，避免改变现有服务的连接生命周期。
 */
function runMigrations(options = {}) {
  const dbPath = getDatabasePath(options);
  const migrationDir = options.migrationsDir || MIGRATIONS_DIR;
  const Database = options.Database || require('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = new Map(
      db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all()
        .map((row) => [row.version, row]),
    );
    const pending = listMigrations(migrationDir);
    const applyMigration = db.transaction((migration, sql, digest) => {
      db.exec(sql);
      db.prepare(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, digest, Date.now());
    });

    for (const migration of pending) {
      const sql = fs.readFileSync(migration.filePath, 'utf8');
      const digest = checksum(sql);
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.name !== migration.name || existing.checksum !== digest) {
          throw new Error(`migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }
      applyMigration(migration, sql, digest);
    }

    return {
      dbPath,
      applied: pending.filter((migration) => !applied.has(migration.version)).map((migration) => migration.name),
      currentVersion: pending.at(-1)?.version || null,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  MIGRATIONS_DIR,
  getDatabasePath,
  listMigrations,
  runMigrations,
};
