'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logEvent } = require('../services/observability/observability.service');

const MIGRATIONS_DIR = path.join(__dirname, 'postgres-migrations');
let pool = null;

function isPostgresEnabled() {
  return config.database?.backend === 'postgres';
}

function getPool(options = {}) {
  if (options.pool) return options.pool;
  if (!isPostgresEnabled()) return null;
  if (!config.database?.url) throw new Error('DATABASE_BACKEND=postgres 时必须设置 DATABASE_URL');
  if (pool) return pool;
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: config.database?.url,
    max: config.database?.poolMax || 10,
    idleTimeoutMillis: config.database?.idleTimeoutMs || 30000,
    connectionTimeoutMillis: config.database?.connectTimeoutMs || 5000,
    ssl: config.database?.ssl ? { rejectUnauthorized: config.database?.sslRejectUnauthorized !== false } : undefined,
  });
  pool.on('error', (error) => logEvent('error', 'postgres_pool_error', { error: error.message }));
  return pool;
}

function migrations(directory = MIGRATIONS_DIR) {
  return fs.readdirSync(directory).filter((name) => /^\d+_.+\.sql$/i.test(name)).sort();
}

async function runPostgresMigrations(options = {}) {
  const client = options.client || await getPool(options)?.connect();
  if (!client) throw new Error('PostgreSQL 未启用或 DATABASE_URL 未配置');
  const release = !options.client;
  try {
    await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const applied = new Map((await client.query('SELECT version, checksum FROM app_schema_migrations')).rows.map((row) => [row.version, row.checksum]));
    const done = [];
    const migrationDir = options.migrationsDir || MIGRATIONS_DIR;
    const migrationNames = migrations(migrationDir);
    for (const name of migrationNames) {
      const sql = fs.readFileSync(path.join(migrationDir, name), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const existing = applied.get(name);
      if (existing) {
        if (existing !== checksum) throw new Error(`PostgreSQL migration checksum mismatch: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO app_schema_migrations (version, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
        done.push(name);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    return { applied: done, currentVersion: migrationNames.at(-1) || null };
  } finally {
    if (release) client.release();
  }
}

async function probePostgres(options = {}) {
  if (!isPostgresEnabled() && !options.pool) return { status: 'disabled', enabled: false };
  try {
    const activePool = getPool(options);
    await activePool.query('SELECT 1');
    return { status: 'ready', enabled: true };
  } catch (error) {
    return { status: 'unavailable', enabled: true, lastError: error.message };
  }
}

async function closePostgres() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = { MIGRATIONS_DIR, isPostgresEnabled, getPool, migrations, runPostgresMigrations, probePostgres, closePostgres };
