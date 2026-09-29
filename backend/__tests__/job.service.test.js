import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir;
let jobService;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'wut-jobs-'));
  process.env.SQLITE_DB_PATH = join(tempDir, 'jobs.db');
  vi.resetModules();
  jobService = require('../src/services/jobs/job.service');
});

afterEach(() => {
  return jobService.closeJobStore().finally(() => {
    delete process.env.SQLITE_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('job.service', () => {
  it('支持幂等入队、成功执行和状态查询', async () => {
    const handler = vi.fn(async () => {});
    jobService.registerJobHandler('test.success', handler);
    const first = jobService.enqueueJob('test.success', { value: 1 }, { idempotencyKey: 'same-key' });
    const duplicate = jobService.enqueueJob('test.success', { value: 2 }, { idempotencyKey: 'same-key' });

    expect(duplicate.id).toBe(first.id);
    expect(jobService.listJobs({ status: 'queued' })).toHaveLength(1);
    const result = await jobService.runOneJob();

    expect(handler).toHaveBeenCalledWith({ value: 1 }, expect.objectContaining({ id: first.id, attempts: 1 }));
    expect(result.status).toBe('succeeded');
  });

  it('失败后按最大尝试次数进入 failed，并支持手动重试', async () => {
    const handler = vi.fn(async () => { throw new Error('temporary failure'); });
    jobService.registerJobHandler('test.fail', handler);
    const job = jobService.enqueueJob('test.fail', {}, { maxAttempts: 1 });
    const failed = await jobService.runOneJob();

    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('temporary failure');
    const retried = jobService.retryJob(job.id);
    expect(retried.status).toBe('queued');
    expect(retried.attempts).toBe(0);
  });

  it('锁超时后可以重新领取 running 任务', async () => {
    const job = jobService.enqueueJob('test.missing', {});
    const database = require('better-sqlite3');
    const db = new database(process.env.SQLITE_DB_PATH);
    db.prepare("UPDATE background_jobs SET status = 'running', locked_at = ?, attempts = 1 WHERE id = ?").run(Date.now() - 600_000, job.id);
    db.close();

    const result = await jobService.runOneJob({ lockTimeoutMs: 1000 });
    expect(result.status).toBe('retrying');
    expect(result.attempts).toBe(2);
  });

  it('达到最大尝试次数的过期 running 任务不会再次执行', async () => {
    const job = jobService.enqueueJob('test.missing.max', {}, { maxAttempts: 1 });
    const database = require('better-sqlite3');
    const db = new database(process.env.SQLITE_DB_PATH);
    db.prepare("UPDATE background_jobs SET status = 'running', locked_at = ?, attempts = 1 WHERE id = ?").run(Date.now() - 600_000, job.id);
    db.close();

    const result = await jobService.runOneJob({ lockTimeoutMs: 1000 });
    expect(result).toBeNull();
    expect(jobService.getJob(job.id)).toMatchObject({ status: 'failed', attempts: 1 });
  });
});
