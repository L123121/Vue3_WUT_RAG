import { describe, expect, it, vi } from 'vitest';
const { AgentRuntimeStore } = require('../src/services/agent-runtime/runtime-store.service');

function fixture() {
  const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() };
  const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), connect: vi.fn(async () => client) };
  return { client, pool, store: new AgentRuntimeStore({ backend: 'postgres', pool }) };
}
const record = () => ({ revision: 12, value: { id: 'ar_test', generation: 'gen-test', ownerId: 'alice', status: 'completed', availableAt: 1, updatedAt: 2, lease: null, steps: [{ id: 'save' }] } });

describe('Agent PostgreSQL适配器SQL契约（不依赖真实数据库）', () => {
  it('检查点条件包含版本和代际，正确使用参数化SQL', async () => {
    const { store, pool } = fixture();
    const before = record();
    await store.saveRun(before, before.value);
    const [sql, args] = pool.query.mock.calls[0];
    expect(sql).toContain('generation = $10');
    expect(sql).not.toContain('?');
    expect(args.slice(-2)).toEqual([12, 'gen-test']);
  });

  it('产物提交同时约束租约token、代际和策略版本', async () => {
    const { store, pool } = fixture();
    await store.saveArtifactIfActive('ar_test:save', { runId: 'ar_test', ownerId: 'alice', generation: 'gen' }, { runId: 'ar_test', ownerId: 'alice', generation: 'gen', leaseToken: 'lease', revision: 10, policyVersion: 3 }, 100);
    const [sql, args] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain('generation = $6 AND lease_token = $7');
    expect(args.slice(-4)).toEqual(['gen', 'lease', 100, 3]);
  });

  it('删除运行和产物共享事务，清理失败ROLLBACK并释放连接', async () => {
    const { store, client } = fixture();
    client.query.mockImplementation(async sql => {
      if (sql.includes('DELETE FROM agent_runtime_kv')) throw new Error('cleanup failed');
      return { rows: [], rowCount: 1 };
    });
    await expect(store.removeRun(record())).rejects.toThrow('cleanup failed');
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN', expect.stringContaining('DELETE FROM agent_runs'), expect.stringContaining('DELETE FROM agent_runtime_kv'), 'ROLLBACK',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('删除CAS未命中不清理产物，避免旧请求删除新代产物', async () => {
    const { store, client } = fixture();
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await store.removeRun(record())).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('agent_runtime_kv'))).toBe(false);
    expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
  });

  it('创建用用户级事务锁防止并行突破运行数上限', async () => {
    const { store, client } = fixture();
    await store.createRun({ ...record().value, createdAt: 1 });
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(client.query.mock.calls[1]).toEqual(['SELECT pg_advisory_xact_lock(hashtext($1))', ['agent-quota:alice']]);
    expect(client.query.mock.calls[2][0]).toContain('COUNT(*) FROM agent_runs');
    expect(client.query.mock.calls.at(-1)[0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
