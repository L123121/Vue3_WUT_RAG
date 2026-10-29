import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const express = require('express');
const { createAgentRunsRouter } = require('../src/routes/agent-runs.routes');
const { RunCoordinator } = require('../src/services/agent-runtime/run-coordinator.service');
const { AgentRuntimeStore } = require('../src/services/agent-runtime/runtime-store.service');
let directory;
let store;
let server;
let base;
let coordinator;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-'));
  store = new AgentRuntimeStore({ backend: 'sqlite', dbPath: path.join(directory, 'state.db') });
  coordinator = new RunCoordinator({ store, principal: async id => ({ id, role: id === 'admin' ? 'admin' : 'user', approved: true }) });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = req.headers['x-test-user']; req.role = req.headers['x-test-role'] || 'user'; next(); });
  app.use('/agent-runs', createAgentRunsRouter({ coordinator }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message, code: err.code }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/agent-runs`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const request = (suffix = '', { method = 'GET', user = 'alice', role = 'user', body } = {}) => fetch(`${base}${suffix}`, {
  method, headers: { ...(user ? { 'x-test-user': user } : {}), 'x-test-role': role, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const create = async () => (await (await request('', { method: 'POST', body: { requestId: 'req_test', goal: '资料汇编', queries: ['图书馆'], userId: 'bob' } })).json()).data.run;

describe('持久Agent API访问边界', () => {
  it('未登录无法查询，创建身份不采信请求体的userId', async () => {
    expect((await request('', { user: null })).status).toBe(401);
    const run = await create();
    expect((await store.getRun(run.id)).value.ownerId).toBe('alice');
    expect((await store.getRun(run.id)).value.calls).toBe(0);
    expect((await request(`/${run.id}`, { user: 'bob' })).status).toBe(404);
    expect((await request(`/${run.id}/events`, { user: 'bob' })).status).toBe(404);
    expect((await request(`/${run.id}/replay?through=1`, { user: 'bob' })).status).toBe(404);
  });

  it('事件和replay只读且支持游标，不能隐式恢复或执行', async () => {
    const run = await create();
    await request(`/${run.id}/start`, { method: 'POST', body: { version: run.version } });
    const first = (await (await request(`/${run.id}/events?limit=1`)).json()).data;
    expect(first.events).toHaveLength(1);
    expect(first.nextSeq).toBe(1);
    const next = (await (await request(`/${run.id}/events?after=1`)).json()).data;
    expect(next.events[0].type).toBe('run.queued');
    expect((await (await request(`/${run.id}/replay?through=1`)).json()).data.state.status).toBe('draft');
    const current = await store.getRun(run.id);
    expect(current.value.status).toBe('queued');
    expect(current.value.calls).toBe(0);
    expect((await request(`/${run.id}/events?limit=0`)).status).toBe(400);
  });

  it('权限中心必须是真实管理员，不能依靠伪造的role上下文', async () => {
    const body = { tool: 'search_published_sources', effect: 'deny', roles: ['admin'], version: 0 };
    expect((await request('/tools/policy', { method: 'PUT', role: 'admin', body })).status).toBe(403);
    expect((await request('/tools/policy', { method: 'PUT', user: 'admin', role: 'admin', body })).status).toBe(200);
    const privateCatalog = (await (await request('/tools')).json()).data;
    expect(privateCatalog.history).toEqual([]);
    expect(privateCatalog.tools.find(tool => tool.name === 'search_published_sources').rule.effect).toBe('deny');
    expect((await request('/tools/policy', { method: 'PUT', user: 'admin', role: 'admin', body: { ...body, tool: 'shell_execute', effect: 'allow', version: 1 } })).status).toBe(403);
  });

  it('关闭开关后禁止启动和恢复，但仍可查询和取消', async () => {
    const run = await create();
    vi.stubEnv('AGENT_RUNTIME_ENABLED', 'false');
    expect((await request(`/${run.id}/start`, { method: 'POST', body: { version: run.version } })).status).toBe(403);
    expect((await request(`/${run.id}/resume`, { method: 'POST', body: { version: run.version } })).status).toBe(403);
    expect((await request(`/${run.id}`)).status).toBe(200);
    expect((await request(`/${run.id}/cancel`, { method: 'POST', body: { version: run.version } })).status).toBe(200);
  });

  it('数组请求体和过期状态版本返回明确错误', async () => {
    expect((await request('', { method: 'POST', body: [] })).status).toBe(400);
    const run = await create();
    expect((await request(`/${run.id}/start`, { method: 'POST', body: { version: 0 } })).status).toBe(409);
  });
});
