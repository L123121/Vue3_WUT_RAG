import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runPostgresMigrations } = require('../src/db/postgres.service');
const { PostgresConversationRepository, PostgresJobRepository } = require('../src/repositories/postgres.repositories');

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function createClient() {
  const applied = new Map();
  const queries = [];
  return {
    applied,
    queries,
    query: vi.fn(async (sql, params = []) => {
      queries.push({ sql, params });
      if (/SELECT version, checksum FROM app_schema_migrations/.test(sql)) return { rows: [...applied].map(([version, checksum]) => ({ version, checksum })) };
      if (/INSERT INTO app_schema_migrations/.test(sql)) { applied.set(params[0], params[1]); return { rows: [] }; }
      if (/INSERT INTO conversations/.test(sql)) return { rows: [{ id: params[0], title: params[2], messages_json: JSON.parse(params[3]), created_at: params[4], updated_at: params[5] }] };
      if (/UPDATE conversations/.test(sql)) return { rows: [{ id: params[4], title: params[0], messages_json: JSON.parse(params[1]), created_at: params[2], updated_at: params[2] }] };
      if (/INSERT INTO background_jobs/.test(sql)) return { rows: [{ id: params[0], type: params[1], payload_json: JSON.parse(params[2]), status: 'queued', attempts: 0, max_attempts: params[3], available_at: params[4], idempotency_key: params[5], created_at: params[6], updated_at: params[7], locked_at: null, last_error: null, completed_at: null }] };
      return { rows: [], rowCount: 0 };
    }),
  };
}

describe('PostgreSQL repositories and migrations', () => {
  it('执行 migration 并拒绝 checksum 漂移', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wut-pg-migrations-'));
    dirs.push(directory);
    writeFileSync(join(directory, '001_test.sql'), 'CREATE TABLE test_table (id TEXT);', 'utf8');
    const client = createClient();
    const first = await runPostgresMigrations({ client, migrationsDir: directory });
    expect(first.applied).toEqual(['001_test.sql']);
    expect(await runPostgresMigrations({ client, migrationsDir: directory })).toMatchObject({ applied: [] });
    writeFileSync(join(directory, '001_test.sql'), 'CREATE TABLE test_table (id INTEGER);', 'utf8');
    await expect(runPostgresMigrations({ client, migrationsDir: directory })).rejects.toThrow(/checksum mismatch/);
  });

  it('Conversation repository 写入和更新 JSONB 会话', async () => {
    const client = createClient();
    const repository = new PostgresConversationRepository({ pool: client });
    const created = await repository.create('user_1', { id: 'conv_1', title: '测试', messages: [{ id: 'm1' }], createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' });
    expect(created).toMatchObject({ id: 'conv_1', title: '测试', messages: [{ id: 'm1' }] });
    expect(client.queries[0].sql).toContain('INSERT INTO conversations');
    const saved = await repository.save('user_1', { ...created, title: '更新', messages: [] });
    expect(saved.title).toBe('更新');
  });

  it('Job repository 用 idempotency_key 去重入队', async () => {
    const client = createClient();
    const repository = new PostgresJobRepository({ pool: client });
    const job = await repository.enqueue({ id: 'job_1', type: 'audit', payload: { ok: true }, maxAttempts: 3, availableAt: 1, idempotencyKey: 'audit:1', createdAt: 1, updatedAt: 1 });
    expect(job).toMatchObject({ id: 'job_1', status: 'queued', payload: { ok: true } });
    expect(client.queries[0].sql).toContain('ON CONFLICT (idempotency_key)');
  });
});
