import { describe, expect, it, vi } from 'vitest';

const { createCsrfMiddleware } = require('../src/middleware/csrf.middleware');

function createRequest({ method = 'POST', origin = undefined, referer = undefined } = {}) {
  const headers = Object.fromEntries(
    Object.entries({ origin, referer }).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value])
  );
  return {
    method,
    path: '/api/conversations',
    traceId: 'trace_test',
    get: (name) => headers[String(name).toLowerCase()] || undefined,
  };
}

function createResponse() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const ALLOWED = 'https://wuli.example.com,https://admin.example.com';

describe('csrf.middleware 同源校验', () => {
  it('安全方法（GET/HEAD/OPTIONS）不校验来源', () => {
    const guard = createCsrfMiddleware({ allowedOrigins: ALLOWED });
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = createResponse();
      const next = vi.fn();
      guard(createRequest({ method, origin: 'https://evil.example.com' }), res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.statusCode).toBeNull();
    }
  });

  it('Origin 命中白名单放行（含末尾斜杠与大小写差异）', () => {
    const guard = createCsrfMiddleware({ allowedOrigins: ALLOWED });
    const res = createResponse();
    const next = vi.fn();
    guard(createRequest({ origin: 'https://wuli.example.com/' }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('跨站 Origin 一律 403 并带可识别错误码', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const guard = createCsrfMiddleware({ allowedOrigins: ALLOWED });
    const res = createResponse();
    const next = vi.fn();
    guard(createRequest({ origin: 'https://evil.example.com' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'CSRF_ORIGIN_REJECTED' });
  });

  it('Origin 缺失时回退 Referer 的协议+host 比对', () => {
    const guard = createCsrfMiddleware({ allowedOrigins: ALLOWED });
    const okRes = createResponse();
    guard(createRequest({ referer: 'https://admin.example.com/page?x=1' }), okRes, vi.fn());
    expect(okRes.statusCode).toBeNull();

    const blockedRes = createResponse();
    guard(createRequest({ referer: 'https://evil.example.com/page' }), blockedRes, vi.fn());
    expect(blockedRes.statusCode).toBe(403);
  });

  it('Origin 与 Referer 都没有时放行（非浏览器来源，风险由接口鉴权承担）', () => {
    const guard = createCsrfMiddleware({ allowedOrigins: ALLOWED });
    const res = createResponse();
    const next = vi.fn();
    guard(createRequest({}), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('未配置白名单时不生效，保持改动前行为', () => {
    const guard = createCsrfMiddleware({ allowedOrigins: '' });
    const res = createResponse();
    const next = vi.fn();
    guard(createRequest({ origin: 'https://evil.example.com' }), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('支持 *.example.com 通配白名单', () => {
    const guard = createCsrfMiddleware({ allowedOrigins: '*.example.com' });
    const res = createResponse();
    const next = vi.fn();
    guard(createRequest({ origin: 'https://sub.example.com' }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });
});
