import { describe, expect, it, vi } from 'vitest';

const {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  JevDecisionError,
  JevDecisionService,
  buildRouteQuestions,
  extractUsage,
  normalizeHistory,
  normalizeUsage,
} = require('../src/services/agent/jev-decision.service');

const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
});

const baseConfig = (overrides = {}) => ({
  enabled: true,
  mode: 'enforce',
  apiKey: 'jev-test-key',
  endpoint: 'https://jev.test/v1/decision',
  model: 'NeoHorse-Jev-4B',
  timeoutMs: 500,
  maxRetries: 0,
  minConfidence: 0.55,
  rolloutPercent: 100,
  unavailableCooldownMs: 60000,
  ...overrides,
});

// 实测响应形状（2026-10-27）：answers.route 为 choice，用量在顶层
const choiceRouteResponse = (overrides = {}) => response({
  model: 'NeoHorse-Jev-4B',
  answers: {
    route: {
      type: 'choice',
      choice: 'rag',
      probabilities: { chat: 0.365, rag: 0.632, agent: 0.003 },
    },
  },
  input_tokens: 124,
  input_details: { input_tokens: 124, expanded_tokens: 138, question_count: 1 },
  probability_source: 'pointer_head',
  decision_seconds: 0.056,
  ...overrides,
});

const noulRouteResponse = (answers, overrides = {}) => response({
  model: 'NeoHorse-Jev-4B',
  answers,
  ...overrides,
});

describe('JevDecisionService 路由决策（choice 主协议）', () => {
  it('发送 state + 单个带 criteria 的 choice 问题，并按返回概率确定路由', async () => {
    const fetchImpl = vi.fn(async () => choiceRouteResponse());
    const service = new JevDecisionService({ config: baseConfig(), fetchImpl });

    const result = await service.decideRoute({
      message: '图书馆几点开门',
      history: [{ role: 'user', content: '之前的问题' }],
      traceId: 'trace_1',
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://jev.test/v1/decision');
    expect(options.headers.Authorization).toBe('Bearer jev-test-key');
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      model: 'NeoHorse-Jev-4B',
      state: { message: '图书馆几点开门' },
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
      confidence: 0.632,
      probabilities: { chat: 0.365, rag: 0.632, agent: 0.003 },
      decision: {
        provider: 'jev',
        model: 'NeoHorse-Jev-4B',
        status: 'success',
        confidence: 0.632,
      },
    });
    // 文档口径：input_tokens 优先，不与 expanded_tokens 相加
    expect(result.decision.usage).toMatchObject({ inputTokens: 124, source: 'input_tokens' });
    expect(result.decision.decisionSeconds).toBe(0.056);
  });

  it('兼容按路由拆成多个 noul 问题的返回（取最大概率）', async () => {
    const service = new JevDecisionService({
      config: baseConfig(),
      fetchImpl: vi.fn(async () => noulRouteResponse({
        chat: { type: 'noul', noul: 0.02 },
        rag: { type: 'noul', noul: 0.93 },
        agent: { type: 'noul', noul: 0.05 },
      })),
    });

    const result = await service.decideRoute({ message: '推免材料' });
    expect(result.route).toBe('rag');
    expect(result.confidence).toBe(0.93);
  });

  it('部分路由缺答案时按已有概率取最大，全部缺失报协议错误', async () => {
    const partial = new JevDecisionService({
      config: baseConfig(),
      fetchImpl: vi.fn(async () => noulRouteResponse({ chat: { type: 'noul', noul: 0.9 } })),
    });
    await expect(partial.decideRoute({ message: '测试' })).resolves.toMatchObject({
      route: 'chat',
      confidence: 0.9,
    });

    const empty = new JevDecisionService({
      config: baseConfig(),
      fetchImpl: vi.fn(async () => response({ answers: {} })),
    });
    await expect(empty.decideRoute({ message: '测试' })).rejects.toMatchObject({
      code: 'JEV_INVALID_RESPONSE',
    });
  });

  it('低置信度或非法路由不会越过服务端策略边界', async () => {
    const lowConfidence = new JevDecisionService({
      config: baseConfig(),
      fetchImpl: vi.fn(async () => response({
        answers: { route: { choice: 'chat', probabilities: { chat: 0.4, rag: 0.35, agent: 0.25 } } },
      })),
    });
    await expect(lowConfidence.decideRoute({ message: '测试' })).rejects.toMatchObject({
      code: 'JEV_LOW_CONFIDENCE',
    });

    const invalidRoute = new JevDecisionService({
      config: baseConfig({ minConfidence: 0 }),
      fetchImpl: vi.fn(async () => response({ answers: { route: { choice: 'delete_all', probabilities: { delete_all: 1 } } } })),
    });
    await expect(invalidRoute.decideRoute({ message: '测试' })).rejects.toMatchObject({
      code: 'JEV_INVALID_ROUTE',
    });
  });

  it('429 按有限次数退避后重试', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(choiceRouteResponse({
        answers: { route: { choice: 'chat', probabilities: { chat: 0.8, rag: 0.1, agent: 0.1 } } },
      }));
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
      httpStatus: 504,
    });
  }, 2000);
});

describe('JevDecisionService 灰度未放量（403）熔断', () => {
  it('命中 MODEL_ACCESS_DENIED 后进入冷却，期间不再请求上游，冷却结束自动恢复', async () => {
    let clock = 1_000;
    const now = () => clock;
    const fetchImpl = vi.fn(async () => response({
      code: 'MODEL_ACCESS_DENIED',
      message: '当前模型仅对灰度用户开放',
      traceId: 'trace_denied',
    }, 403));
    const service = new JevDecisionService({
      config: baseConfig({ unavailableCooldownMs: 60_000 }),
      fetchImpl,
      now,
    });

    await expect(service.decideRoute({ message: '图书馆几点开门' })).rejects.toMatchObject({
      code: 'JEV_MODEL_ACCESS_DENIED',
      status: 403,
      httpStatus: 503,
    });

    expect(service.shouldEvaluate({ runId: 'run_1' })).toBe(false);
    expect(service.getAvailability()).toMatchObject({
      available: false,
      status: 'unavailable',
      model: 'NeoHorse-Jev-4B',
      retryAfterMs: 60_000,
      lastFailure: { code: 'JEV_MODEL_ACCESS_DENIED', status: 403 },
    });

    await expect(service.decideRoute({ message: '再来一次' })).rejects.toMatchObject({
      code: 'JEV_UNAVAILABLE',
      httpStatus: 503,
      unavailable: true,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();

    clock += 60_001;
    expect(service.shouldEvaluate({ runId: 'run_2' })).toBe(true);
    expect(service.getAvailability()).toMatchObject({ available: true, status: 'available' });
  });

  it('可用性快照不包含 API Key', () => {
    const service = new JevDecisionService({ config: baseConfig(), fetchImpl: vi.fn() });
    const availability = service.getAvailability();
    expect(JSON.stringify(availability)).not.toContain('jev-test-key');
    expect(availability).toMatchObject({
      provider: 'jev',
      endpointHost: 'jev.test',
      enabled: true,
      available: true,
      questionTypes: ['noul', 'choice'],
    });
  });
});

describe('JevDecisionService 通用决策接口（/v1/decision）', () => {
  it('跑通文档示例并按问题 ID 返回概率（实测字段 noul + probabilities.true）', async () => {
    const fetchImpl = vi.fn(async () => response({
      model: 'NeoHorse-Jev-4B',
      answers: {
        stop: {
          type: 'noul',
          noul: 0.9895584583282471,
          probabilities: { false: 0.010441573336720467, true: 0.9895584583282471 },
        },
      },
      input_tokens: 20,
      input_details: { input_tokens: 20, expanded_tokens: 26, question_count: 1 },
      decision_seconds: 0.058,
      probability_source: 'pointer_head',
    }));
    const service = new JevDecisionService({ config: baseConfig(), fetchImpl });

    const result = await service.decide({
      state: '路口信号灯为红色，前方有行人。',
      questions: { stop: { type: 'noul', instructions: '现在是否应停车？' } },
      traceId: 'trace_local',
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'NeoHorse-Jev-4B',
      state: '路口信号灯为红色，前方有行人。',
      questions: { stop: { type: 'noul', instructions: '现在是否应停车？' } },
    });
    expect(result).toMatchObject({
      provider: 'jev',
      model: 'NeoHorse-Jev-4B',
      answers: { stop: { type: 'noul', probability: 0.9895584583282471 } },
      usage: { inputTokens: 20, source: 'input_tokens' },
      decisionSeconds: 0.058,
    });
    expect(result.decisionId).toMatch(/^jev_/);
  });

  it('choice 题返回选项与分布，结构化 state 原样透传', async () => {
    const fetchImpl = vi.fn(async () => response({
      answers: {
        route: { type: 'choice', choice: 'agent', probabilities: { chat: 0.01, rag: 0.45, agent: 0.54 } },
      },
      input_tokens: 30,
    }));
    const service = new JevDecisionService({ config: baseConfig(), fetchImpl });

    const result = await service.decide({
      state: { speed: 30, pedestrian: true },
      questions: {
        route: {
          type: 'choice',
          instructions: '选择链路',
          criteria: { chat: '闲聊', rag: '知识库', agent: '多步' },
        },
      },
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.state).toEqual({ speed: 30, pedestrian: true });
    expect(body.questions.route.criteria).toEqual({ chat: '闲聊', rag: '知识库', agent: '多步' });
    expect(result.answers.route).toMatchObject({ type: 'choice', choice: 'agent' });
  });

  it('answers 缺失或问题缺答案时报协议错误', async () => {
    const missing = new JevDecisionService({
      config: baseConfig(),
      fetchImpl: vi.fn(async () => response({ answers: {} })),
    });
    await expect(missing.decide({
      state: 'x',
      questions: { stop: { type: 'noul', instructions: '是否停车？' } },
    })).rejects.toMatchObject({ code: 'JEV_INVALID_RESPONSE', missing: ['stop'] });

    const noAnswers = new JevDecisionService({
      config: baseConfig(),
      fetchImpl: vi.fn(async () => response({ error: 'x' })),
    });
    await expect(noAnswers.decide({
      state: 'x',
      questions: { stop: { type: 'noul', instructions: '是否停车？' } },
    })).rejects.toMatchObject({ code: 'JEV_INVALID_RESPONSE' });
  });

  it('入参校验：空 state、非法问题类型/字段/ID、问题过多都返回 400', async () => {
    const service = new JevDecisionService({ config: baseConfig(), fetchImpl: vi.fn() });
    const validQuestion = { stop: { type: 'noul', instructions: '是否停车？' } };

    await expect(service.decide({ state: '  ', questions: validQuestion })).rejects.toMatchObject({
      code: 'JEV_INVALID_REQUEST',
      httpStatus: 400,
    });
    await expect(service.decide({
      state: 'x',
      questions: { stop: { type: 'categorical', instructions: '选一个' } },
    })).rejects.toMatchObject({ code: 'JEV_INVALID_REQUEST' });
    await expect(service.decide({
      state: 'x',
      questions: { stop: { type: 'noul', instructions: '是否停车？', criteria: 'oops' } },
    })).rejects.toMatchObject({ code: 'JEV_INVALID_REQUEST' });
    await expect(service.decide({
      state: 'x',
      questions: { 'bad id': { type: 'noul', instructions: '是否停车？' } },
    })).rejects.toMatchObject({ code: 'JEV_INVALID_REQUEST' });
    await expect(service.decide({
      state: 'x',
      questions: { stop: { type: 'noul', instructions: '' } },
    })).rejects.toMatchObject({ code: 'JEV_INVALID_REQUEST' });

    const tooMany = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`q${index}`, { type: 'noul', instructions: '是否？' }]),
    );
    await expect(service.decide({ state: 'x', questions: tooMany })).rejects.toMatchObject({
      code: 'JEV_INVALID_REQUEST',
    });
    expect(service.maxQuestions).toBe(8);
  });

  it('未启用时直接拒绝，不发起网络请求', async () => {
    const fetchImpl = vi.fn();
    const service = new JevDecisionService({ config: baseConfig({ enabled: false }), fetchImpl });
    await expect(service.decide({
      state: 'x',
      questions: { stop: { type: 'noul', instructions: '是否？' } },
    })).rejects.toMatchObject({ code: 'JEV_DISABLED', httpStatus: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('JevDecisionService 工具函数与默认值', () => {
  it('默认指向 tokenrhythm 的 /v1/decision 与 NeoHorse-Jev-4B', () => {
    expect(DEFAULT_ENDPOINT).toBe('https://tokenrhythm.studio/v1/decision');
    expect(DEFAULT_MODEL).toBe('NeoHorse-Jev-4B');
  });

  it('Token 口径：input_tokens 优先，缺失时回退 expanded_tokens，两者不相加', () => {
    expect(normalizeUsage({ input_tokens: 10, input_details: { expanded_tokens: 99 }, output_tokens: 2 }))
      .toMatchObject({ inputTokens: 10, outputTokens: 2, totalTokens: 12, source: 'input_tokens' });
    expect(normalizeUsage({ input_details: { expanded_tokens: 99 } }))
      .toMatchObject({ inputTokens: 99, outputTokens: null, totalTokens: 99, source: 'expanded_tokens' });
    expect(normalizeUsage(undefined)).toMatchObject({ inputTokens: null, source: 'unknown' });
  });

  it('提取用量：兼容顶层（/v1/decision）与 usage 包裹（/v1/systemone）两种位置', () => {
    expect(extractUsage({ input_tokens: 124, input_details: { expanded_tokens: 138 } }))
      .toMatchObject({ inputTokens: 124, source: 'input_tokens' });
    expect(extractUsage({ usage: { input_tokens: 20, output_tokens: 34 } }))
      .toMatchObject({ inputTokens: 20, outputTokens: 34, totalTokens: 54, source: 'input_tokens' });
    expect(extractUsage({})).toMatchObject({ inputTokens: null, source: 'unknown' });
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

  it('只在显式启用且命中灰度桶时评估', () => {
    const disabled = new JevDecisionService({
      config: { enabled: false, mode: 'off', apiKey: '' },
      fetchImpl: vi.fn(),
    });
    expect(disabled.shouldEvaluate({ runId: 'run_1' })).toBe(false);

    const canary = new JevDecisionService({
      config: baseConfig({ mode: 'canary', rolloutPercent: 100 }),
      fetchImpl: vi.fn(),
    });
    expect(canary.shouldEvaluate({ runId: 'run_1' })).toBe(true);

    const canaryOff = new JevDecisionService({
      config: baseConfig({ mode: 'canary', rolloutPercent: 0 }),
      fetchImpl: vi.fn(),
    });
    expect(canaryOff.shouldEvaluate({ runId: 'run_1' })).toBe(false);
  });

  it('路由问题为单个 choice，带三条链路的口径说明', () => {
    const questions = buildRouteQuestions();
    expect(Object.keys(questions)).toEqual(['route']);
    expect(questions.route.type).toBe('choice');
    expect(questions.route.instructions).toContain('单一业务链路');
    expect(Object.keys(questions.route.criteria).sort()).toEqual(['agent', 'chat', 'rag']);
  });

  it('导出统一错误类型', () => {
    const error = new JevDecisionError('x', 'JEV_TEST');
    expect(error).toMatchObject({ name: 'JevDecisionError', code: 'JEV_TEST' });
  });
});
