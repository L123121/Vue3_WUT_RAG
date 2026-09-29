'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { getDatabasePath, runMigrations } = require('../../db/migration-runner');
const { logEvent } = require('../observability/observability.service');

const JOB_STATUSES = new Set(['queued', 'running', 'retrying', 'succeeded', 'failed']);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

let db = null;
let runnerTimer = null;
let running = false;
let tickInFlight = false;
let activeTickPromise = null;
let migrationsReady = false;
let nextPruneAt = 0;
const handlers = new Map();

function getDb() {
  if (db?.open) return db;
  if (!migrationsReady) {
    runMigrations();
    migrationsReady = true;
  }
  const Database = require('better-sqlite3');
  const dbPath = getDatabasePath();
  fs.mkdirSync(require('path').dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function normalizeJob(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  return {
    id: row.id,
    type: row.type,
    payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function registerJobHandler(type, handler) {
  if (!type || typeof handler !== 'function') throw new TypeError('job handler requires type and function');
  handlers.set(String(type), handler);
  return () => handlers.delete(String(type));
}

function enqueueJob(type, payload = {}, options = {}) {
  const now = Date.now();
  const id = options.id || `job_${now}_${crypto.randomBytes(5).toString('hex')}`;
  const maxAttempts = Math.max(Number.parseInt(options.maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS, 1);
  const availableAt = Number.isFinite(options.availableAt) ? options.availableAt : now;
  const idempotencyKey = options.idempotencyKey ? String(options.idempotencyKey) : null;
  const database = getDb();
  if (idempotencyKey) {
    const existing = database.prepare('SELECT * FROM background_jobs WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return normalizeJob(existing);
  }
  database.prepare(`
    INSERT INTO background_jobs
      (id, type, payload_json, status, attempts, max_attempts, available_at, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
  `).run(id, String(type), JSON.stringify(payload ?? {}), maxAttempts, availableAt, idempotencyKey, now, now);
  const job = getJob(id);
  logEvent('info', 'background_job_enqueued', { jobId: id, type: String(type), idempotencyKey });
  return job;
}

function getJob(id) {
  return normalizeJob(getDb().prepare('SELECT * FROM background_jobs WHERE id = ?').get(String(id)));
}

function listJobs(options = {}) {
  const clauses = [];
  const params = [];
  if (options.status && JOB_STATUSES.has(String(options.status))) {
    clauses.push('status = ?');
    params.push(String(options.status));
  }
  const limit = Math.min(Math.max(Number.parseInt(options.limit, 10) || 50, 1), 200);
  const rows = getDb().prepare(`
    SELECT * FROM background_jobs
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit);
  return rows.map(normalizeJob);
}

function claimNextJob(now = Date.now(), lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
  const database = getDb();
  const claim = database.transaction(() => {
    // 进程崩溃后释放超过锁租期的 running 任务，允许重新执行。
    database.prepare(`
      UPDATE background_jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retrying' END,
          locked_at = NULL,
          available_at = ?,
          updated_at = ?,
          completed_at = CASE WHEN attempts >= max_attempts THEN ? ELSE NULL END,
          last_error = COALESCE(last_error, 'worker lock expired')
      WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < ?
    `).run(now, now, now, now - lockTimeoutMs);

    const row = database.prepare(`
      SELECT * FROM background_jobs
      WHERE status IN ('queued', 'retrying') AND attempts < max_attempts AND available_at <= ?
      ORDER BY available_at ASC, created_at ASC
      LIMIT 1
    `).get(now);
    if (!row) return null;
    const updated = database.prepare(`
      UPDATE background_jobs
      SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'retrying')
    `).run(now, now, row.id);
    return updated.changes === 1 ? normalizeJob(database.prepare('SELECT * FROM background_jobs WHERE id = ?').get(row.id)) : null;
  });
  return claim();
}

function completeJob(id) {
  const now = Date.now();
  getDb().prepare(`
    UPDATE background_jobs
    SET status = 'succeeded', payload_json = '{}', locked_at = NULL, updated_at = ?, completed_at = ?, last_error = NULL
    WHERE id = ? AND status = 'running'
  `).run(now, now, id);
}

function pruneJobs(now = Date.now()) {
  const retentionDays = Math.max(Number.parseInt(process.env.JOB_RETENTION_DAYS, 10) || 30, 1);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return getDb().prepare(`
    DELETE FROM background_jobs
    WHERE status IN ('succeeded', 'failed') AND updated_at < ?
  `).run(cutoff).changes;
}

function failJob(job, error) {
  const now = Date.now();
  const message = String(error?.stack || error?.message || error).slice(0, 4000);
  const retryable = job.attempts < job.maxAttempts;
  const delay = Math.min(60_000, 1000 * (2 ** Math.max(job.attempts - 1, 0)));
  getDb().prepare(`
    UPDATE background_jobs
    SET status = ?, locked_at = NULL, available_at = ?, updated_at = ?, last_error = ?, completed_at = ?
    WHERE id = ? AND status = 'running'
  `).run(retryable ? 'retrying' : 'failed', retryable ? now + delay : now, now, message, retryable ? null : now, job.id);
  logEvent(retryable ? 'warn' : 'error', 'background_job_failed', {
    jobId: job.id,
    type: job.type,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    retryable,
    error: message,
  });
}

function retryJob(id) {
  const now = Date.now();
  const result = getDb().prepare(`
    UPDATE background_jobs
    SET status = 'queued', attempts = 0, available_at = ?, locked_at = NULL,
        updated_at = ?, completed_at = NULL, last_error = NULL
    WHERE id = ? AND status = 'failed'
  `).run(now, now, String(id));
  return result.changes === 1 ? getJob(id) : null;
}

async function runOneJob(options = {}) {
  const job = claimNextJob(options.now || Date.now(), options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS);
  if (!job) return null;
  const handler = handlers.get(job.type);
  if (!handler) {
    failJob(job, new Error(`没有注册的任务处理器: ${job.type}`));
    return getJob(job.id);
  }
  try {
    await handler(job.payload, job);
    completeJob(job.id);
    logEvent('info', 'background_job_succeeded', { jobId: job.id, type: job.type, attempts: job.attempts });
  } catch (error) {
    failJob(job, error);
  }
  return getJob(job.id);
}

function startJobRunner(options = {}) {
  if (runnerTimer) return runnerTimer;
  const intervalMs = Math.max(Number.parseInt(options.intervalMs, 10) || Number.parseInt(process.env.JOB_POLL_INTERVAL_MS, 10) || DEFAULT_POLL_INTERVAL_MS, 100);
  running = true;
  const tick = async () => {
    if (!running || tickInFlight) return;
    tickInFlight = true;
    activeTickPromise = (async () => {
      try {
        // 单个进程串行消费，避免本地 SQLite worker 自相竞争；后续迁移队列时保留接口。
        await runOneJob();
        if (Date.now() >= nextPruneAt) {
          const removed = pruneJobs();
          nextPruneAt = Date.now() + Math.max(Number.parseInt(process.env.JOB_PRUNE_INTERVAL_MS, 10) || 60 * 60 * 1000, 60 * 1000);
          if (removed > 0) logEvent('info', 'background_jobs_pruned', { removed });
        }
      } catch (error) {
        logEvent('error', 'background_job_runner_tick_failed', { error: error.message });
      } finally {
        tickInFlight = false;
        activeTickPromise = null;
      }
    })();
    return activeTickPromise;
  };
  void tick();
  runnerTimer = setInterval(() => { void tick(); }, intervalMs);
  runnerTimer.unref?.();
  return runnerTimer;
}

function stopJobRunner() {
  running = false;
  if (runnerTimer) clearInterval(runnerTimer);
  runnerTimer = null;
  return activeTickPromise || Promise.resolve();
}

async function closeJobStore() {
  await stopJobRunner();
  if (db?.open) db.close();
  db = null;
  migrationsReady = false;
  nextPruneAt = 0;
}

module.exports = {
  JOB_STATUSES,
  enqueueJob,
  getJob,
  listJobs,
  retryJob,
  pruneJobs,
  registerJobHandler,
  runOneJob,
  startJobRunner,
  stopJobRunner,
  closeJobStore,
};
