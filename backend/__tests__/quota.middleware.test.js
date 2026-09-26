import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * quota.middleware 单元测试 — 用户级每日配额
 * 覆盖：白名单跳过 / 原子预占 / 并发限流 / 失败与断连回滚 / fail-open。
 *
 * quota.service 导出单例对象（module.exports = new QuotaService()），
 * middleware 与其引用同一实例，因此直接 vi.spyOn 单例方法即可隔离。
 */
function getQuotaMiddleware() {
  delete require.cache[require.resolve('../src/middleware/quota.middleware')];
  return require('../src/middleware/quota.middleware').quotaMiddleware;
}

const flush = () => new Promise((r) => setImmediate(r));

function createResponse(statusCode = 200) {
  const listeners = new Map();
  const response = {
    statusCode,
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    once: vi.fn((event, handler) => listeners.set(event, handler)),
    removeListener: vi.fn((event, handler) => {
      if (listeners.get(event) === handler) listeners.delete(event);
    }),
    emit(event) {
      const handler = listeners.get(event);
      if (!handler) return;
      listeners.delete(event);
      handler();
    },
  };
  return response;
}

describe('quota.middleware', () => {
  let quotaMiddleware;
  let quotaService;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    quotaService = require('../src/services/auth/quota.service');
    quotaMiddleware = getQuotaMiddleware();
  });

  it('白名单路径（/api/health）跳过配额检查', () => {
    const reserveSpy = vi.spyOn(quotaService, 'reserve');
    const req = { path: '/api/health', userId: null };
    const next = vi.fn();
    quotaMiddleware(req, {}, next);
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('API 列表页精确跳过，但 /api/chat 等消耗 LLM 的接口不跳过', async () => {
    const reserveSpy = vi.spyOn(quotaService, 'reserve');
    // /api 列表页本身跳过
    const reqList = { path: '/api', userId: null };
    quotaMiddleware(reqList, {}, vi.fn());
    expect(reserveSpy).not.toHaveBeenCalled();
    // /api/chat 必须走配额检查（此前 "/api" 前缀误匹配导致配额失效）
    const reqChat = { path: '/api/chat', userId: 'u1' };
    reserveSpy.mockResolvedValue({ ok: true, usage: { used: 1, limit: 100 } });
    await quotaMiddleware(reqChat, createResponse(), vi.fn());
    expect(reserveSpy).toHaveBeenCalledWith('u1');
  });

  it('静态资源路径跳过配额检查', () => {
    const reserveSpy = vi.spyOn(quotaService, 'reserve');
    const req = { path: '/assets/app.js', userId: null };
    const next = vi.fn();
    quotaMiddleware(req, {}, next);
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('配额不足时返回 429 且不继续', async () => {
    const reserveSpy = vi.spyOn(quotaService, 'reserve').mockResolvedValue({ ok: false, usage: { used: 100, limit: 100 } });
    const req = { path: '/api/chat', userId: 'u1' };
    const res = createResponse();
    const next = vi.fn();

    await quotaMiddleware(req, res, next);

    expect(reserveSpy).toHaveBeenCalledWith('u1');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: '今日配额已用完，请明天再试' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('配额充足时在放行前完成预占，2xx 响应保留配额', async () => {
    const reserveSpy = vi.spyOn(quotaService, 'reserve').mockResolvedValue({ ok: true, usage: { used: 6, limit: 100 } });
    const releaseSpy = vi.spyOn(quotaService, 'release').mockResolvedValue({ used: 5, limit: 100 });
    const req = { path: '/api/chat', userId: 'u1' };
    const res = createResponse(200);
    const next = vi.fn();

    await quotaMiddleware(req, res, next);

    expect(reserveSpy).toHaveBeenCalledWith('u1');
    expect(reserveSpy.mock.invocationCallOrder[0]).toBeLessThan(next.mock.invocationCallOrder[0]);
    expect(next).toHaveBeenCalled();
    res.emit('finish');
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it('非 2xx 响应回滚已预占配额', async () => {
    vi.spyOn(quotaService, 'reserve').mockResolvedValue({ ok: true, usage: { used: 6, limit: 100 } });
    const releaseSpy = vi.spyOn(quotaService, 'release').mockResolvedValue({ used: 5, limit: 100 });
    const req = { path: '/api/chat', userId: 'u1' };
    const res = createResponse(500);
    const next = vi.fn();

    await quotaMiddleware(req, res, next);
    res.emit('finish');
    await flush();

    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledWith('u1');
  });

  it('连接在 finish 前关闭时回滚且只回滚一次', async () => {
    vi.spyOn(quotaService, 'reserve').mockResolvedValue({ ok: true, usage: { used: 6, limit: 100 } });
    const releaseSpy = vi.spyOn(quotaService, 'release').mockResolvedValue({ used: 5, limit: 100 });
    const res = createResponse(200);

    await quotaMiddleware({ path: '/api/chat', userId: 'u1' }, res, vi.fn());
    res.emit('close');
    res.emit('finish');
    await flush();

    expect(releaseSpy).toHaveBeenCalledOnce();
  });

  it('并发请求在限额为 1 时只放行一个', async () => {
    let used = 0;
    const reserveSpy = vi.spyOn(quotaService, 'reserve').mockImplementation(async () => {
      if (used >= 1) return { ok: false, usage: { used, limit: 1 } };
      used += 1;
      return { ok: true, usage: { used, limit: 1 } };
    });
    vi.spyOn(quotaService, 'release').mockResolvedValue({ used: 0, limit: 1 });
    const firstNext = vi.fn();
    const secondNext = vi.fn();
    const firstResponse = createResponse();
    const secondResponse = createResponse();

    await Promise.all([
      quotaMiddleware({ path: '/api/chat', userId: 'u1' }, firstResponse, firstNext),
      quotaMiddleware({ path: '/api/chat', userId: 'u1' }, secondResponse, secondNext),
    ]);

    expect(reserveSpy).toHaveBeenCalledTimes(2);
    expect(firstNext.mock.calls.length + secondNext.mock.calls.length).toBe(1);
    expect(firstResponse.status.mock.calls.length + secondResponse.status.mock.calls.length).toBe(1);
  });

  it('配额系统异常时不阻塞请求（fail-open）', async () => {
    vi.spyOn(quotaService, 'reserve').mockRejectedValue(new Error('store down'));
    const req = { path: '/api/chat', userId: 'u1' };
    const res = createResponse();
    const next = vi.fn();

    await quotaMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
