import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runMigrations } = require('../src/db/migration-runner');
const Database = require('better-sqlite3');

let tempDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wut-migrations-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('migration-runner', () => {
  it('从空数据库执行有序 migration，重复执行保持幂等', () => {
    const dbPath = join(tempDir, 'store.db');
    const first = runMigrations({ dbPath });
    const second = runMigrations({ dbPath });
    const db = new Database(dbPath, { readonly: true });

    expect(first.applied).toEqual(['001_initial_schema.sql', '002_background_jobs.sql']);
    expect(second.applied).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'background_jobs'").get()).toBeTruthy();
    db.close();
  });

  it('检测已应用 migration 的 checksum 变化', () => {
    const dbPath = join(tempDir, 'store.db');
    const migrationDir = join(tempDir, 'migrations');
    require('fs').mkdirSync(migrationDir);
    writeFileSync(join(migrationDir, '001_test.sql'), 'CREATE TABLE sample (id TEXT);', 'utf8');
    runMigrations({ dbPath, migrationsDir: migrationDir });
    writeFileSync(join(migrationDir, '001_test.sql'), 'CREATE TABLE sample (id INTEGER);', 'utf8');

    expect(() => runMigrations({ dbPath, migrationsDir: migrationDir })).toThrow(/checksum mismatch/);
  });
});
