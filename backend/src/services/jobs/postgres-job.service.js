'use strict';

const crypto = require('crypto');
const { getRepositories } = require('../../repositories/repository-factory');
const { getPool } = require('../../db/postgres.service');
const { logEvent } = require('../observability/observability.service');
const { getRedisRuntime } = require('../runtime/redis-runtime.service');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

class PostgresJobService {
  constructor(options = {}) {
    this.pool = options.pool || getPool(options);
    this.repository = options.repository || getRepositories(options)?.jobs;
    this.handlers = options.handlers || new Map();
  }

  registerJobHandler(type, handler) {
    if (!type || typeof handler !== 'function') throw new TypeError('job handler requires type and function');
    this.handlers.set(String(type), handler);
    return () => this.handlers.delete(String(type));
  }

  async enqueueJob(type, payload = {}, options = {}) {
    const now = Date.now();
    const job = await this.repository.enqueue({
      id: options.id || `job_${now}_${crypto.randomBytes(5).toString('hex')}`,
      type: String(type),
      payload,
      maxAttempts: Math.max(Number.parseInt(options.maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS, 1),
      availableAt: Number.isFinite(options.availableAt) ? options.availableAt : now,
      idempotencyKey: options.idempotencyKey ? String(options.idempotencyKey) : null,
      createdAt: now,
      updatedAt: now,
    });
    logEvent('info', 'background_job_enqueued', { jobId: job.id, type: job.type, idempotencyKey: job.idempotencyKey, backend: 'postgres' });
    void getRedisRuntime().notifyJobsAvailable({ jobId: job.id, type: job.type });
    return job;
  }

  async getJob(id) { return this.repository.get(String(id)); }
  async listJobs(options = {}) { return this.repository.list(options); }

  async retryJob(id) {
    const now = Date.now();
    const result = await this.pool.query(`UPDATE background_jobs
      SET status='queued', attempts=0, available_at=$1, locked_at=NULL, updated_at=$1, completed_at=NULL, last_error=NULL
      WHERE id=$2 AND status='failed' RETURNING *`, [now, String(id)]);
    return result.rows[0] ? this.repository.normalize(result.rows[0]) : null;
  }

  async claimNextJob(now = Date.now(), lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE background_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retrying' END,
            locked_at = NULL,
            available_at = $1,
            updated_at = $1,
            completed_at = CASE WHEN attempts >= max_attempts THEN $1 ELSE NULL END,
            last_error = COALESCE(last_error, 'worker lock expired')
        WHERE status='running' AND locked_at IS NOT NULL AND locked_at < $2`, [now, now - lockTimeoutMs]);
      const selected = await client.query(`SELECT * FROM background_jobs
        WHERE status IN ('queued','retrying') AND attempts < max_attempts AND available_at <= $1
        ORDER BY available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED LIMIT 1`, [now]);
      if (!selected.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const row = selected.rows[0];
      const updated = await client.query(`UPDATE background_jobs SET status='running', attempts=attempts+1, locked_at=$1, updated_at=$1
        WHERE id=$2 RETURNING *`, [now, row.id]);
      await client.query('COMMIT');
      return this.repository.normalize(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async completeJob(id) {
    const now = Date.now();
    await this.pool.query(`UPDATE background_jobs SET status='succeeded', payload_json='{}'::jsonb, locked_at=NULL, updated_at=$1, completed_at=$1, last_error=NULL
      WHERE id=$2 AND status='running'`, [now, id]);
  }

  async failJob(job, error) {
    const now = Date.now();
    const message = String(error?.stack || error?.message || error).slice(0, 4000);
    const retryable = job.attempts < job.maxAttempts;
    const delay = Math.min(60_000, 1000 * (2 ** Math.max(job.attempts - 1, 0)));
    await this.pool.query(`UPDATE background_jobs SET status=$1, locked_at=NULL, available_at=$2, updated_at=$3, last_error=$4, completed_at=$5
      WHERE id=$6 AND status='running'`, [retryable ? 'retrying' : 'failed', retryable ? now + delay : now, now, message, retryable ? null : now, job.id]);
    logEvent(retryable ? 'warn' : 'error', 'background_job_failed', { jobId: job.id, type: job.type, attempt: job.attempts, maxAttempts: job.maxAttempts, retryable, error: message, backend: 'postgres' });
  }

  async pruneJobs(now = Date.now()) {
    const retentionDays = Math.max(Number.parseInt(process.env.JOB_RETENTION_DAYS, 10) || 30, 1);
    const result = await this.pool.query(`DELETE FROM background_jobs WHERE status IN ('succeeded','failed') AND updated_at < $1`, [now - retentionDays * 24 * 60 * 60 * 1000]);
    return result.rowCount || 0;
  }

  async runOneJob(options = {}) {
    const job = await this.claimNextJob(options.now || Date.now(), options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS);
    if (!job) return null;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.failJob(job, new Error(`没有注册的任务处理器: ${job.type}`));
      return this.getJob(job.id);
    }
    try {
      await handler(job.payload, job);
      await this.completeJob(job.id);
      logEvent('info', 'background_job_succeeded', { jobId: job.id, type: job.type, attempts: job.attempts, backend: 'postgres' });
    } catch (error) {
      await this.failJob(job, error);
    }
    return this.getJob(job.id);
  }
}

module.exports = { PostgresJobService };
