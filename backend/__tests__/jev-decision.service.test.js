import { describe, expect, it, vi } from 'vitest';

const {
  JevDecisionError,
  JevDecisionService,
  normalizeHistory,
} = require('../src/services/jev-decision.service');

const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
});

const baseConfig = (overrides = {}) => ({
  enabled: true,
  mode: 'enforce',
  apiKey: 'jev-test-key',
  endpoint: 'https://jev.test/v1/systemone',
  model: 'jev-test',
  timeoutMs: 500,
  maxRetries: 0,
  minConfidence: 0.55,
  rolloutPercent: 100,
  ...overrides,
});

describe('JevDecisionService', () => {
  it('按官方 System One 请求协议生成路由决策', async () => {
    const fetchImpl = vi.fn(async (_url, options) => response({
      model: 'jev-1.13.0',
      answers: {
        route: {
          type: 'choice',
          choice: 'rag',
          confidence: 0.91,
          probabilities: { chat: 0.03, rag: 0.91, agent: 0.06 },
        },
      },
    }));
    const service = new JevDecisionService({ config: baseConfig(), fetchImpl });

    const result = await service.decideRoute({
      message: '图书馆几点开门',
      history: [{ role: 'user', content: '之前的问题' }],
      traceId: 'trace_1',
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://jev.test/v1/systemone');
    expect(options.headers.Authorization).toBe('Bearer jev-test-key');
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      state: { message: '图书馆几点开门' },
      model: 'jev-test',
      questions: {
        route: {
          type: 'choice',
          instructions: expect.any(String),
          criteria: {
            chat: expect.any(String),
            rag: expect.any(String),
            agent: expect.any(String),
          },
        },
      },
    });
    expect(result).toMatchObject({
      intent: 'knowledge_query',
      route: 'rag',
      confidence: 0.91,
      decision: {
        provider: 'jev',
        model: 'jev-1.13.0',
        status: 'success',
      },
    });
  });

  it('低置信度或非法路由不会越过服务端策略边界', async () => {
    const lowConfidence = new JevDecisionService({
      config: baseConfig(),
      fetchImpl: vi.fn(async () => response({ answers: { route: { choice: 'chat', confidence: 0.2 } } })),
    });
    await expect(lowConfidence.decideRoute({ message: '测试' })).rejects.toMatchObject({ code: 'JEV_LOW_CONFIDENCE' });

    const invalidRoute = new JevDecisionService({
      config: baseConfig({ minConfidence: 0 }),
      fetchImpl: vi.fn(async () => response({ answers: { route: { choice: 'delete_all', confidence: 1 } } })),
    });
    await expect(invalidRoute.decideRoute({ message: '测试' })).rejects.toMatchObject({ code: 'JEV_INVALID_ROUTE' });
  });

  it('429/529 按有限次数退避后重试', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(response({ answers: { route: { choice: 'chat', confidence: 0.8 } } }));
    const service = new JevDecisionService({
      config: baseConfig({ maxRetries: 1 }),
      fetchImpl,
      sleep,
    });

    const result = await service.decideRoute({ message: '帮我写一封邮件' });

    expect(result.route).toBe('chat');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('请求超时返回可识别错误，供编排层降级', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const service = new JevDecisionService({
      config: baseConfig({ timeoutMs: 100 }),
      fetchImpl,
    });

    await expect(service.decideRoute({ message: '慢请求' })).rejects.toMatchObject({
      code: 'JEV_TIMEOUT',
    });
  }, 2000);

  it('仅在显式配置并按灰度桶命中时调用', () => {
    const disabled = new JevDecisionService({ config: { enabled: false, mode: 'off', apiKey: '' }, fetchImpl: vi.fn() });
    expect(disabled.shouldEvaluate({ runId: 'run_1' })).toBe(false);

    const canary = new JevDecisionService({
      config: baseConfig({ mode: 'canary', rolloutPercent: 100 }),
      fetchImpl: vi.fn(),
    });
    expect(canary.shouldEvaluate({ runId: 'run_1' })).toBe(true);
  });

  it('历史状态默认不发送，开启后只保留有界角色和文本', () => {
    expect(normalizeHistory([
      { role: 'user', content: 'a' },
      { role: 'unknown', content: 'b' },
      { role: 'assistant', content: '' },
    ], { maxItems: 2, maxChars: 10 })).toEqual([
      { role: 'user', content: 'b' },
    ]);
    const service = new JevDecisionService({ config: baseConfig({ includeHistory: true }), fetchImpl: vi.fn() });
    expect(service.buildRequest({ message: '问题', history: [{ role: 'user', content: '历史' }] }).state.history).toEqual([
      { role: 'user', content: '历史' },
    ]);
  });

  it('导出统一错误类型', () => {
    const error = new JevDecisionError('x', 'JEV_TEST');
    expect(error).toMatchObject({ name: 'JevDecisionError', code: 'JEV_TEST' });
  });
});
