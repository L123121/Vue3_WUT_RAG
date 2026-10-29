import { afterEach, describe, expect, it, vi } from 'vitest';

const express = require('express');
const { createCampusRouter } = require('../src/routes/campus.routes');
const scheduler = require('../src/services/campus/source-radar-scheduler.service');
const jobs = require('../src/services/jobs/job.service');
let server;

async function serve(service) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = req.headers['x-test-user'] || null; next(); });
  app.use('/campus', createCampusRouter({ service }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}/campus`;
}

afterEach(async () => {
  scheduler.stopSourceRadarScheduler();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
});

describe('校园接口访问边界', () => {
  it('未登录请求被拒绝，不执行工作台查询', async () => {
    const service = { overview: vi.fn() };
    const base = await serve(service);
    const response = await fetch(base);
    expect(response.status).toBe(401);
    expect(service.overview).not.toHaveBeenCalled();
  });

  it('用户身份只取认证上下文，不采信查询或请求体里的 userId', async () => {
    const service = { overview: vi.fn(async () => ({ tasks: [] })), create: vi.fn(async () => ({ task: { id: 'task_test' } })) };
    const base = await serve(service);
    const read = await fetch(`${base}?userId=other`, { headers: { 'x-test-user': 'alice' } });
    expect(read.status).toBe(200);
    expect(service.overview).toHaveBeenCalledWith('alice');
    const create = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'other', card: {} }) });
    expect(create.status).toBe(200);
    expect(service.create).toHaveBeenCalledWith('alice', expect.objectContaining({ userId: 'other' }));
  });

  it('非法 JSON 结构和版本冲突有明确状态码', async () => {
    const service = { update: vi.fn(async () => { throw Object.assign(new Error('版本冲突'), { status: 409 }); }) };
    const base = await serve(service);
    const headers = { 'x-test-user': 'alice', 'content-type': 'application/json' };
    expect((await fetch(`${base}/tasks/task_test`, { method: 'PUT', headers, body: '[]' })).status).toBe(400);
    const response = await fetch(`${base}/tasks/task_test`, { method: 'PUT', headers, body: '{"version":0,"action":"archive"}' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: '版本冲突' });
  });
});

describe('变化雷达调度', () => {
  it('启动时入队、按时间桶去重，停止后不再产生任务', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubEnv('CAMPUS_RADAR_ENABLED', 'true');
    vi.stubEnv('CAMPUS_RADAR_INTERVAL_MS', '60000');
    const enqueue = vi.spyOn(jobs, 'enqueueJob').mockResolvedValue({ id: 'fake-job' });
    scheduler.startSourceRadarScheduler();
    scheduler.startSourceRadarScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toBe('campus.sources.check');
    const firstKey = enqueue.mock.calls[0][2].idempotencyKey;
    await vi.advanceTimersByTimeAsync(60000);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1][2].idempotencyKey).not.toBe(firstKey);
    scheduler.stopSourceRadarScheduler();
    await vi.advanceTimersByTimeAsync(120000);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('关闭开关时不启动调度', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CAMPUS_RADAR_ENABLED', 'false');
    const enqueue = vi.spyOn(jobs, 'enqueueJob').mockResolvedValue({});
    scheduler.startSourceRadarScheduler();
    await vi.advanceTimersByTimeAsync(300000);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
