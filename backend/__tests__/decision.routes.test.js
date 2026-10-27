import { describe, expect, it, vi } from 'vitest';

const {
  createDecisionHandler,
  statusForError,
  STATUS_BY_CODE,
} = require('../src/routes/decision.routes');
const { JevDecisionError } = require('../src/services/agent/jev-decision.service');

const createReq = (body = {}) => ({
  body,
  traceId: 'trace_req_1',
  once: vi.fn(),
  removeListener: vi.fn(),
});

const createRes = () => {
  const res = {
    locals: { traceId: 'trace_req_1' },
    headersSent: false,
    writableEnded: false,
    headers: {},
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn(),
  };
  res.status.mockImplementation((code) => {
    res.statusCode = code;
    return res;
  });
  return res;
};

describe('/api/decision 处理器', () => {
  it('成功时透传 service 结果', async () => {
    const service = {
      decide: vi.fn(async () => ({
        provider: 'jev',
        model: 'NeoHorse-Jev-4B',
        answers: { stop: { type: 'noul', probability: 0.97 } },
        usage: { inputTokens: 31 },
        decisionId: 'jev_1',
      })),
    };
    const handler = createDecisionHandler(service);
    const req = createReq({ state: '红灯', questions: { stop: { type: 'noul', instructions: '是否停车？' } } });
    const res = createRes();

    await handler(req, res);

    expect(service.decide).toHaveBeenCalledWith(expect.objectContaining({
      state: '红灯',
      questions: { stop: { type: 'noul', instructions: '是否停车？' } },
      traceId: 'trace_req_1',
      signal: expect.any(Object),
    }));
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ model: 'NeoHorse-Jev-4B', decisionId: 'jev_1' }),
    });
    // 客户端断开的监听必须清理，避免请求对象被闭包持有
    expect(req.removeListener).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('灰度未放量（403）映射为 503 + Retry-After，不透传上游原文', async () => {
    const service = {
      decide: vi.fn(async () => {
        throw new JevDecisionError('当前模型仅对灰度用户开放', 'JEV_MODEL_ACCESS_DENIED', {
          httpStatus: 503,
          status: 403,
          retryAfterMs: 120_000,
          upstreamMessage: '当前模型仅对灰度用户开放',
        });
      }),
    };
    const handler = createDecisionHandler(service);
    const res = createRes();

    await handler(createReq({ state: 'x' }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '120');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'JEV_MODEL_ACCESS_DENIED',
      error: expect.stringContaining('灰度'),
      retryAfterMs: 120_000,
      traceId: 'trace_req_1',
    }));
  });

  it('参数错误返回 400 并带上具体原因，上游协议错误返回 502，超时返回 504', async () => {
    const cases = [
      ['JEV_INVALID_REQUEST', { httpStatus: 400 }, 400, 'state 不能为空'],
      ['JEV_INVALID_RESPONSE', { httpStatus: 502 }, 502, '决策请求失败'],
      ['JEV_TIMEOUT', { httpStatus: 504 }, 504, '决策模型响应超时'],
    ];
    for (const [code, details, expected, message] of cases) {
      const service = {
        decide: vi.fn(async () => {
          throw new JevDecisionError(code === 'JEV_INVALID_REQUEST' ? 'state 不能为空' : 'boom', code, details);
        }),
      };
      const res = createRes();
      await createDecisionHandler(service)(createReq({ state: 'x' }), res);
      expect(res.status).toHaveBeenCalledWith(expected);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        code,
        error: expect.stringContaining(message),
      }));
    }
  });

  it('客户端中止时不写响应体', async () => {
    const service = {
      decide: vi.fn(async () => {
        throw new JevDecisionError('已取消', 'JEV_ABORTED', { httpStatus: 499 });
      }),
    };
    const res = createRes();
    await createDecisionHandler(service)(createReq({ state: 'x' }), res);
    expect(res.status).toHaveBeenCalledWith(499);
    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('响应已发出后不再二次写入', async () => {
    const service = { decide: vi.fn(async () => { throw new Error('late'); }) };
    const res = createRes();
    res.headersSent = true;
    await createDecisionHandler(service)(createReq({ state: 'x' }), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('未注入 service 时构造即失败', () => {
    expect(() => createDecisionHandler(null)).toThrow(/决策服务实例/);
  });

  it('错误码 → HTTP 状态映射完整', () => {
    expect(statusForError({ code: 'JEV_UNAVAILABLE' })).toBe(503);
    expect(statusForError({ code: 'JEV_INVALID_REQUEST' })).toBe(400);
    expect(statusForError({ code: 'JEV_TIMEOUT' })).toBe(504);
    expect(statusForError({ code: 'UNKNOWN' })).toBe(502);
    expect(statusForError({ code: 'UNKNOWN', httpStatus: 429 })).toBe(429);
    expect(Object.keys(STATUS_BY_CODE)).toEqual(expect.arrayContaining([
      'JEV_DISABLED',
      'JEV_MODEL_ACCESS_DENIED',
      'JEV_INVALID_RESPONSE',
    ]));
  });
});
