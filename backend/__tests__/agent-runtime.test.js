import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { AgentRuntimeStore } = require('../src/services/agent-runtime/runtime-store.service');
const { RunCoordinator } = require('../src/services/agent-runtime/run-coordinator.service');
const { AgentRunWorker } = require('../src/services/agent-runtime/run-worker.service');
const { WorkerTools } = require('../src/services/agent-runtime/worker-tools.service');
const { ToolPolicyService } = require('../src/services/agent-runtime/tool-policy.service');
const { validatePlan, researchPlan, getTool } = require('../src/services/agent-runtime/tool-catalog');
const { publicRun } = require('../src/services/agent-runtime/runtime-values');
const { ToolRegistry } = require('../src/services/agent/tool-registry.service');

let directory;
let store;
let coordinator;
let tools;
let worker;
let now;
let count;
const principal = async id => ['alice', 'bob', 'admin'].includes(id) ? { id, role: id === 'admin' ? 'admin' : 'user', approved: true } : null;
const fixture = { id: 'doc_test', title: '图书馆演示资料', currentRevision: 'revision_1', visible: true, body: '开放时间：每天8点至22点。', simulated: true };
const clean = value => JSON.parse(JSON.stringify(value));
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wut-agent-runtime-'));
  store = new AgentRuntimeStore({ backend: 'sqlite', dbPath: path.join(directory, 'agent.db') });
  now = Date.parse('2026-10-29T00:00:00Z');
  count = 0;
  coordinator = new RunCoordinator({ store, principal, clock: () => now });
  tools = new WorkerTools({ store, isWorker: () => true, clock: () => now, wiki: {
    searchPublished: vi.fn(async () => [fixture]), getEntry: vi.fn(async () => fixture),
  } });
  vi.spyOn(tools, 'execute');
  worker = new AgentRunWorker({ coordinator, tools, isWorker: () => true, clock: () => now, heartbeatMs: 5000 });
});
afterEach(async () => {
  await worker.stop();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function create(input = {}) {
  return (await coordinator.create('alice', { requestId: `request_${++count}`, goal: '查找校园资料', queries: ['图书馆', '借阅办理'], ...input })).run;
}
async function start(input = {}) {
  const run = await create(input);
  await coordinator.start('alice', run.id, { version: run.version });
  return run.id;
}
const current = id => coordinator.get('alice', id);
async function tickTimes(times) { for (let i = 0; i < times; i++) await worker.tick(); }
async function approve(id) {
  const run = await current(id);
  const step = run.steps.find(node => node.status === 'awaiting_approval');
  return coordinator.approval('alice', id, step.id, { requestId: step.approval.id, digest: step.approval.digest, decision: 'approve' });
}

describe('持久DAG计划与执行', () => {
  it('创建只保存草稿，不在API进程执行；只有独立worker能执行', async () => {
    const run = await create();
    expect(run.status).toBe('draft');
    expect(tools.execute).not.toHaveBeenCalled();
    await expect(new AgentRunWorker({ coordinator }).tick()).rejects.toMatchObject({ code: 'WORKER_REQUIRED' });
    await expect(new WorkerTools({ store }).execute('search_published_sources', { query: 'q' }, {})).rejects.toMatchObject({ code: 'WORKER_REQUIRED' });
    await worker.tick();
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it('并行检索、依赖汇编、一次性审批后幂等保存，检查点与事件同源', async () => {
    const id = await start();
    await worker.tick();
    let run = await current(id);
    expect(run.steps.slice(0, 2).map(step => step.status)).toEqual(['succeeded', 'succeeded']);
    expect(run.calls).toBe(2);
    await tickTimes(2);
    run = await current(id);
    expect(run.status).toBe('awaiting_approval');
    expect(run.calls).toBe(3);
    expect(run.steps[3].approval.inputPreview.brief.content).toContain('8点至22点');
    expect(await store.getValue('artifact', `${id}:save`)).toBeNull();
    const pending = run.steps[3].approval;
    await approve(id);
    await worker.tick();
    run = await current(id);
    expect(run.status).toBe('completed');
    expect(run.calls).toBe(4);
    expect(run.steps[3].approval.usedAt).toBe(now);
    expect((await store.getValue('artifact', `${id}:save`)).value.ownerId).toBe('alice');
    await expect(coordinator.approval('alice', id, 'save', { requestId: pending.id, digest: pending.digest, decision: 'approve' })).rejects.toMatchObject({ status: 409 });
    const events = await coordinator.events('alice', id);
    expect(events.events.map(item => item.seq)).toEqual(events.events.map((_, index) => index + 1));
    const callsBefore = tools.execute.mock.calls.length;
    const replayed = await coordinator.replay('alice', id, events.lastSeq);
    expect(clean(replayed.state)).toEqual(clean(run));
    expect(tools.execute).toHaveBeenCalledTimes(callsBefore);
    const historical = await coordinator.replay('alice', id, 2);
    expect(historical.state.status).toBe('queued');
    expect(historical.state.steps.every(step => step.status === 'pending')).toBe(true);
  });

  it('无依赖只读节点真实并发，parallelSafe=false的节点只串行调度', async () => {
    let active = 0;
    let max = 0;
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    tools.wiki.searchPublished.mockImplementation(async () => {
      active++; max = Math.max(max, active);
      if (active === 2) release();
      await barrier; active--;
      return [fixture];
    });
    const id = await start({ persist: false });
    await worker.tick();
    expect(max).toBe(2);
    expect((await current(id)).steps.filter(step => step.status === 'succeeded')).toHaveLength(2);
    tools.wiki.searchPublished.mockResolvedValue([fixture]);
    tools.definition = name => ({ ...getTool(name), parallelSafe: false });
    const second = await start({ persist: false });
    await worker.processRun(second);
    expect((await current(second)).steps.filter(step => step.status === 'succeeded')).toHaveLength(1);
  });

  it('验证依赖环、缺失依赖、原型路径和沙箱工具，不接受无来源伪造产物', () => {
    const base = { id: 'a', label: '查询', tool: 'search_published_sources', input: { query: 'test' }, dependsOn: [] };
    expect(() => validatePlan([{ ...base, dependsOn: ['a'] }])).toThrow();
    expect(() => validatePlan([{ ...base, dependsOn: ['b'] }, { ...base, id: 'b', dependsOn: ['a'] }])).toThrow(/环/);
    expect(() => validatePlan([{ ...base, dependsOn: ['missing'] }])).toThrow(/不存在/);
    expect(() => validatePlan([{ ...base, input: { query: { $from: 'b', path: ['__proto__'] } }, dependsOn: ['b'] }, { ...base, id: 'b' }])).toThrow(/路径/);
    expect(() => validatePlan([{ ...base, tool: 'python_execute' }])).toThrow(/沙箱/);
    expect(() => validatePlan([{ ...base, tool: 'save_research_brief', input: { brief: { content: '伪造来源' } } }])).toThrow(/只能引用/);
  });

  it('同一创建请求幂等，开始后计划不可改变，身份不可越权', async () => {
    const first = await coordinator.create('alice', { requestId: 'same', goal: '目标', queries: ['查询'] });
    const second = await coordinator.create('alice', { requestId: 'same', goal: '目标', queries: ['查询'] });
    expect(first.run.id).toBe(second.run.id);
    expect(second.existing).toBe(true);
    await expect(coordinator.get('bob', first.run.id)).rejects.toMatchObject({ status: 404 });
    await expect(coordinator.events('bob', first.run.id)).rejects.toMatchObject({ status: 404 });
    await coordinator.start('alice', first.run.id, { version: first.run.version });
    await expect(coordinator.edit('alice', first.run.id, { version: (await current(first.run.id)).version, steps: researchPlan('目标', ['q']) })).rejects.toMatchObject({ code: 'PLAN_IMMUTABLE' });
  });

  it('计划可延迟执行并跨服务重启恢复，不依赖HTTP连接存活', async () => {
    const id = await start({ startAt: now + 86400000, persist: false });
    await worker.tick();
    expect((await current(id)).status).toBe('waiting');
    expect(tools.execute).not.toHaveBeenCalled();
    const reopenedStore = new AgentRuntimeStore({ backend: 'sqlite', dbPath: path.join(directory, 'agent.db') });
    try {
      now += 86400000;
      const reopened = new RunCoordinator({ store: reopenedStore, principal, clock: () => now });
      const nextWorker = new AgentRunWorker({ coordinator: reopened, tools, isWorker: () => true, clock: () => now });
      await nextWorker.tick();
      expect((await reopened.get('alice', id)).calls).toBe(2);
      await nextWorker.tick();
      expect((await reopened.get('alice', id)).status).toBe('completed');
      await nextWorker.stop();
    } finally { reopenedStore.close(); }
  });
});

describe('审批与权限中心', () => {
  it('策略默认拒绝未知/高风险工具，副作用审批下限不能被管理员关闭', async () => {
    const policy = coordinator.policy;
    expect((await policy.decide('unknown', await principal('alice'))).effect).toBe('deny');
    expect((await policy.decide('python_execute', await principal('admin'))).effect).toBe('deny');
    await expect(policy.update(await principal('admin'), { tool: 'python_execute', effect: 'allow', roles: ['admin'], version: 0 })).rejects.toMatchObject({ code: 'SANDBOX_REQUIRED' });
    await expect(policy.update(await principal('admin'), { tool: 'save_research_brief', effect: 'allow', roles: ['user'], version: 0 })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await expect(policy.update(await principal('alice'), {})).rejects.toMatchObject({ status: 403 });
  });

  it('权限调整使待审批绑定失效；恢复后需要新审批，拒绝没有任何副作用', async () => {
    const id = await start();
    await tickTimes(3);
    let run = await current(id);
    const oldRequest = run.steps[3].approval;
    await coordinator.policy.update(await principal('admin'), { tool: 'save_research_brief', effect: 'approval', roles: ['user', 'admin'], version: 0 });
    await expect(coordinator.approval('alice', id, 'save', { requestId: oldRequest.id, digest: oldRequest.digest, decision: 'approve' })).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    await coordinator.resume('alice', id, { version: run.version });
    await worker.tick();
    run = await current(id);
    expect(run.steps[3].approval.id).not.toBe(oldRequest.id);
    await coordinator.approval('alice', id, 'save', { requestId: run.steps[3].approval.id, digest: run.steps[3].approval.digest, decision: 'deny' });
    await worker.tick();
    expect((await current(id)).status).toBe('cancelled');
    expect(await store.getValue('artifact', `${id}:save`)).toBeNull();
  });

  it('过期或跨用户审批不执行工具', async () => {
    const id = await start();
    await tickTimes(3);
    const run = await current(id);
    const request = run.steps[3].approval;
    await expect(coordinator.approval('bob', id, 'save', { requestId: request.id, digest: request.digest, decision: 'approve' })).rejects.toMatchObject({ status: 404 });
    now = request.expiresAt + 1;
    await expect(approve(id)).rejects.toMatchObject({ code: 'APPROVAL_STALE' });
    expect((await current(id)).calls).toBe(3);
  });

  it('审批后政策撤销在实际执行前再次检查，不消费授权操作', async () => {
    const id = await start();
    await tickTimes(3);
    await approve(id);
    await coordinator.policy.update(await principal('admin'), { tool: 'save_research_brief', effect: 'deny', roles: ['user'], version: 0 });
    await worker.tick();
    expect((await current(id)).status).toBe('blocked');
    expect(await store.getValue('artifact', `${id}:save`)).toBeNull();
  });

  it('旧聊天工具不能通过伪造approval布尔值执行副作用或沙箱工具', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'should not run');
    registry.register({ name: 'write', sideEffect: true, requiresConfirmation: true, handler });
    registry.register({ name: 'shell', execution: 'sandbox', handler });
    expect(await registry.executeToolDetailed('write', {}, { approval: true })).toMatchObject({ errorCode: 'DURABLE_APPROVAL_REQUIRED' });
    expect(await registry.executeToolDetailed('shell', {})).toMatchObject({ errorCode: 'SANDBOX_REQUIRED' });
    const restricted = new ToolRegistry({ authorize: async () => ({ effect: 'deny', reason: '策略拒绝' }) });
    restricted.register({ name: 'read', handler });
    expect(await restricted.executeToolDetailed('read', {})).toMatchObject({ errorCode: 'POLICY_DENIED' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('检查点与故障恢复', () => {
  it('失败后resume跳过成功节点，保留累计预算；回放绝不重跑', async () => {
    let failed = false;
    const original = WorkerTools.prototype.execute.bind(tools);
    tools.execute.mockImplementation(async (name, input, context) => {
      if (name === 'search_published_sources' && input.query === '借阅办理' && !failed) { failed = true; throw new Error('暂时失败'); }
      return original(name, input, context);
    });
    const id = await start({ persist: false });
    await worker.tick();
    let run = await current(id);
    expect(run.status).toBe('failed');
    expect(run.calls).toBe(2);
    const checkpoint = run.steps[0].resultHash;
    await coordinator.resume('alice', id, { version: run.version });
    tools.execute.mockRestore();
    await tickTimes(2);
    run = await current(id);
    expect(run.status).toBe('completed');
    expect(run.calls).toBe(4);
    expect(run.steps[0].attempts).toBe(1);
    expect(run.steps[0].resultHash).toBe(checkpoint);
  });

  it('两执行器CAS抢占只有一个成功；租约过期后旧token不能提交结果', async () => {
    const id = await start({ persist: false });
    const other = new AgentRunWorker({ coordinator, tools, isWorker: () => true, clock: () => now });
    const tokens = await Promise.all([worker.claim(id), other.claim(id)]);
    expect(tokens.filter(Boolean)).toHaveLength(1);
    const oldToken = tokens.find(Boolean);
    await worker.prepare(id, oldToken, 'search_1');
    now += 31000;
    await other.processRun(id);
    const run = await current(id);
    expect(run.steps[0].status).toBe('succeeded');
    expect(run.steps[0].attempts).toBe(2);
    await expect(coordinator.mutate(id, value => worker.checkLease(value, oldToken))).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await other.stop();
  });

  it('副作用已保存但检查点前崩溃时重新审批，幂等键防止重复保存', async () => {
    const id = await start();
    await tickTimes(3);
    await approve(id);
    const token = await worker.claim(id);
    const prepared = await worker.prepare(id, token, 'save');
    await tools.execute('save_research_brief', prepared.input, {
      runId: id, stepId: 'save', userId: 'alice', signal: new AbortController().signal,
      verifyActive: async () => {
        const record = await store.getRun(id);
        worker.checkLease(record.value, token);
        return { runId: id, generation: record.value.generation, leaseToken: token, ownerId: 'alice', revision: record.revision, policyVersion: 0 };
      },
    });
    now += 31000;
    await worker.tick();
    expect((await current(id)).status).toBe('awaiting_approval');
    await approve(id);
    await worker.tick();
    expect((await current(id)).steps[3].result.deduplicated).toBe(true);
    expect((await store.query("SELECT * FROM agent_runtime_kv WHERE namespace = 'artifact'")).rows).toHaveLength(1);
  });

  it('非可安全重放的副作用中断变为待人工核对，不自动重试', async () => {
    const id = await start();
    await tickTimes(3);
    await approve(id);
    const token = await worker.claim(id);
    await worker.prepare(id, token, 'save');
    tools.definition = name => ({ ...getTool(name), replaySafe: name !== 'save_research_brief' });
    coordinator.getDefinition = tools.definition;
    now += 31000;
    await worker.tick();
    const run = await current(id);
    expect(run.status).toBe('attention');
    await expect(coordinator.resume('alice', id, { version: run.version })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(await store.getValue('artifact', `${id}:save`)).toBeNull();
  });

  it('运行取消后不会执行后续节点，预算和过期运行不能被resume重置', async () => {
    const id = await start();
    await worker.tick();
    let run = await current(id);
    await coordinator.stop('alice', id, { version: run.version });
    await worker.tick();
    expect((await current(id)).status).toBe('cancelled');
    expect((await current(id)).calls).toBe(2);
    const second = await start({ maxCalls: 4 });
    now += 8 * 86400000;
    await worker.tick();
    run = await current(second);
    expect(run.status).toBe('expired');
    await expect(coordinator.resume('alice', second, { version: run.version })).rejects.toMatchObject({ status: 409 });
  });

  it('重复审批/恢复不重置尝试次数及总调用数', async () => {
    const id = await start({ persist: false, maxCalls: 3 });
    tools.execute.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'TOOL_TIMEOUT' }));
    await worker.tick();
    now += 5000;
    await worker.tick();
    const run = await current(id);
    expect(run.calls).toBe(3);
    expect(run.status).toBe('failed');
    await expect(coordinator.resume('alice', id, { version: run.version })).rejects.toMatchObject({ code: 'RUN_BUDGET_EXHAUSTED' });
  });

  it('取消先于产物提交时，旧执行凭据不能再写入副作用', async () => {
    const id = await start();
    await tickTimes(3);
    await approve(id);
    const token = await worker.claim(id);
    await worker.prepare(id, token, 'save');
    const before = await store.getRun(id);
    const guard = { runId: id, generation: before.value.generation, leaseToken: token, ownerId: 'alice', revision: before.revision, policyVersion: 0 };
    await coordinator.stop('alice', id, { version: before.value.version });
    expect(await store.saveArtifactIfActive(`${id}:save`, { runId: id, generation: before.value.generation, ownerId: 'alice' }, guard, now)).toBe(false);
    expect(await store.getValue('artifact', `${id}:save`)).toBeNull();
    await worker.release(id, token);
  });

  it('策略在校验后变更时，原子产物写入拒绝旧权限版本', async () => {
    const id = await start();
    await tickTimes(3);
    await approve(id);
    const token = await worker.claim(id);
    await worker.prepare(id, token, 'save');
    const before = await store.getRun(id);
    await coordinator.policy.update(await principal('admin'), { tool: 'save_research_brief', effect: 'deny', roles: ['user'], version: 0 });
    expect(await store.saveArtifactIfActive(`${id}:save`, { runId: id, generation: before.value.generation, ownerId: 'alice' }, { runId: id, generation: before.value.generation, leaseToken: token, ownerId: 'alice', revision: before.revision, policyVersion: 0 }, now)).toBe(false);
    await worker.release(id, token);
  });

  it('活跃工具响应取消信号，取消后不会执行后续依赖', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    tools.execute.mockImplementation(async (_name, _input, context) => new Promise((_, reject) => {
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORTED' })), { once: true });
      started();
    }));
    const id = await start({ queries: ['图书馆'], persist: false });
    const executing = worker.tick();
    await ready;
    const record = await store.getRun(id);
    await coordinator.stop('alice', id, { version: record.value.version });
    await worker.heartbeat(id, record.value.lease.token, worker.controller);
    await executing;
    const run = await current(id);
    expect(run.status).toBe('cancelled');
    expect(run.calls).toBe(1);
    expect(run.steps.every(node => node.status === 'cancelled')).toBe(true);
  });

  it('执行器优雅停止保存暂停检查点，而非把长任务当作失败重建', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    tools.execute.mockImplementation(async (_name, _input, context) => new Promise((_, reject) => {
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('stop'), { name: 'AbortError', code: 'ABORTED' })), { once: true });
      started();
    }));
    const id = await start({ queries: ['图书馆'], persist: false });
    const executing = worker.tick();
    await ready;
    await worker.stop();
    await executing;
    const run = await current(id);
    expect(run.status).toBe('paused');
    expect(run.steps[0].status).toBe('pending');
    expect(run.calls).toBe(1);
  });

  it('删除重建同一请求ID后，旧版本与旧租约凭据都不能写入新代际', async () => {
    const id = await start({ requestId: 'reused_request', persist: false });
    const token = await worker.claim(id);
    const old = await store.getRun(id);
    now += 31000;
    let run = await coordinator.stop('alice', id, { version: old.value.version });
    await coordinator.remove('alice', id, run.version);
    const fresh = await create({ requestId: 'reused_request', persist: false });
    expect(fresh.id).toBe(id);
    await coordinator.start('alice', id, { version: fresh.version });
    const nextToken = await worker.claim(id);
    const next = await store.getRun(id);
    expect(next.revision).toBe(old.revision);
    expect(next.value.generation).not.toBe(old.value.generation);
    expect(await store.saveRun(old, old.value)).toBe(false);
    const oldGuard = { runId: id, ownerId: 'alice', revision: old.revision, generation: old.value.generation, leaseToken: token, policyVersion: 0 };
    expect(await store.saveArtifactIfActive(`${id}:save`, { runId: id, ownerId: 'alice', generation: old.value.generation }, oldGuard, now)).toBe(false);
    const wrongLease = { ...oldGuard, generation: next.value.generation };
    expect(await store.saveArtifactIfActive(`${id}:save`, { runId: id, ownerId: 'alice', generation: next.value.generation }, wrongLease, now)).toBe(false);
    expect(await store.removeRun(old)).toBe(false);
    await worker.release(id, nextToken);
  });

  it('运行和产物删除是同一事务，产物清理失败不会留下孤立记录', async () => {
    const id = await start();
    await tickTimes(3); await approve(id); await worker.tick();
    const run = await current(id);
    store.db().exec("CREATE TRIGGER reject_artifact_delete BEFORE DELETE ON agent_runtime_kv WHEN OLD.namespace = 'artifact' BEGIN SELECT RAISE(ABORT, 'delete blocked'); END");
    await expect(coordinator.remove('alice', id, run.version)).rejects.toThrow('delete blocked');
    expect((await current(id)).status).toBe('completed');
    expect(await store.getValue('artifact', `${id}:save`)).not.toBeNull();
    store.db().exec('DROP TRIGGER reject_artifact_delete');
    await coordinator.remove('alice', id, run.version);
    expect(await store.getRun(id)).toBeNull();
    expect(await store.getValue('artifact', `${id}:save`)).toBeNull();
  });

  it('终态检查点可以从第二个真实数据库连接读取', async () => {
    const id = await start({ persist: false });
    await tickTimes(2);
    const reopened = new AgentRuntimeStore({ backend: 'sqlite', dbPath: path.join(directory, 'agent.db') });
    try {
      expect(publicRun((await reopened.getRun(id)).value).status).toBe('completed');
    } finally { reopened.close(); }
  });
});
