import { describe, expect, it, vi } from 'vitest';

const { PostgresJobService } = require('../src/services/jobs/postgres-job.service');

function createPool() {
  const queries = [];
  const client = {
    query: vi.fn(async (sql, params = []) => {
      queries.push({ sql, params });
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [{ id: 'job_1', type: 'test', payload_json: { value: 1 }, status: 'queued', attempts: 0, max_attempts: 3, available_at: 0, locked_at: null, last_error: null, idempotency_key: null, created_at: 0, updated_at: 0, completed_at: null }] };
      if (/SET status='running'/.test(sql)) return { rows: [{ id: 'job_1', type: 'test', payload_json: { value: 1 }, status: 'running', attempts: 1, max_attempts: 3, available_at: 0, locked_at: params[0], last_error: null, idempotency_key: null, created_at: 0, updated_at: params[0], completed_at: null }] };
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return { queries, connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [], rowCount: 1 })), client };
}

describe('PostgresJobService', () => {
  it('使用 FOR UPDATE SKIP LOCKED 原子领取任务', async () => {
    const pool = createPool();
    const repository = { normalize: (row) => ({ id: row.id, type: row.type, payload: row.payload_json, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: row.available_at, lockedAt: row.locked_at, lastError: row.last_error, idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at }) };
    const service = new PostgresJobService({ pool, repository });
    const job = await service.claimNextJob(1000);
    expect(job).toMatchObject({ id: 'job_1', status: 'running', attempts: 1, payload: { value: 1 } });
    expect(pool.client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'), [1000]);
    expect(pool.client.query).toHaveBeenCalledWith('COMMIT');
    expect(pool.client.release).toHaveBeenCalledOnce();
  });

  it('执行 handler 后写入完成状态', async () => {
    const pool = createPool();
    const repository = {
      normalize: (row) => row,
      get: vi.fn(async () => ({ id: 'job_1', status: 'succeeded' })),
    };
    const service = new PostgresJobService({ pool, repository });
    service.claimNextJob = vi.fn(async () => ({ id: 'job_1', type: 'test', payload: { value: 1 }, attempts: 1, maxAttempts: 3 }));
    service.registerJobHandler('test', vi.fn(async () => {}));
    await expect(service.runOneJob()).resolves.toMatchObject({ status: 'succeeded' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("status='succeeded'"), expect.any(Array));
  });
});
