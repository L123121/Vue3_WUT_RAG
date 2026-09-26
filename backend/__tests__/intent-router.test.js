import { describe, it, expect, beforeEach, vi } from 'vitest';

// 模拟 config（避免读 .env）
vi.mock('../src/config', () => ({
  rag: {
    intentRoutingEnabled: true,
    intentClassifyEnabled: false,
  },
  ai: {
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com/v2',
    model: 'test-model',
    maxTokens: 4000,
    temperature: 0.7,
    timeout: 60000,
  },
}));

let IntentRouter;
const { INTENT_TYPES } = require('../src/services/agent/intent-router.service');

beforeEach(() => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('intent-router') || k.includes('ai.service')) delete require.cache[k];
  }
  const mod = require('../src/services/agent/intent-router.service');
  IntentRouter = mod.IntentRouter;
});

function getRouter() {
  // fastRoute 是纯关键词路由（零 LLM），传 null 避免触发 AiService 初始化
  return new IntentRouter(null);
}

/**
 * fastRoute 是纯关键词路由（零 LLM），是路由正确性的核心。
 * 用例锁定：普通聊天、工具任务与明确知识库问题必须正确分流。
 */
describe('IntentRouter.fastRoute', () => {
  const chatCases = [
    ['问候-你好', '你好', INTENT_TYPES.GENERAL_CHAT],
    ['问候-您好', '您好', INTENT_TYPES.GENERAL_CHAT],
    ['问候-hello', 'hello', INTENT_TYPES.GENERAL_CHAT],
    ['问候-hi', 'Hi', INTENT_TYPES.GENERAL_CHAT],
    ['问候-早上好', '早上好', INTENT_TYPES.GENERAL_CHAT],
    ['感谢', '谢谢', INTENT_TYPES.GENERAL_CHAT],
    ['告别', '再见', INTENT_TYPES.GENERAL_CHAT],
  ];

  for (const [desc, input, intent] of chatCases) {
    it(`正向匹配 chat：${desc} → chat/${intent}`, () => {
      const r = getRouter().fastRoute(input);
      expect(r).not.toBeNull();
      expect(r.intent).toBe(intent);
      expect(r.route).toBe('chat');
      expect(r.confidence).toBeGreaterThan(0);
    });
  }

  const agentCases = [
    ['多步-复习计划', '帮我制定一个期末复习计划', INTENT_TYPES.COMPLEX_TASK],
    ['多步-综合对比', '综合对比一下两个方案', INTENT_TYPES.COMPLEX_TASK],
    ['多步-规划时间线', '帮我规划考研时间线', INTENT_TYPES.COMPLEX_TASK],
    ['多步-权衡', '帮我权衡一下利弊', INTENT_TYPES.COMPLEX_TASK],
    ['计算-中文乘法', '帮我算一下 128 乘以 46 等于多少', INTENT_TYPES.CALCULATION_TASK],
    ['计算-sqrt', 'sqrt(144) 是多少', INTENT_TYPES.CALCULATION_TASK],
    ['计算-次方', '23 的 3 次方等于多少', INTENT_TYPES.CALCULATION_TASK],
  ];

  for (const [desc, input, intent] of agentCases) {
    it(`正向匹配 agent：${desc} → agent/${intent}`, () => {
      const r = getRouter().fastRoute(input);
      expect(r).not.toBeNull();
      expect(r.intent).toBe(intent);
      expect(r.route).toBe('agent');
      expect(r.confidence).toBeGreaterThan(0);
    });
  }

  const ragCases = [
    ['校园问答-食堂', '学校食堂几点关门'],
    ['校园问答-图书馆', '图书馆怎么借书'],
    ['校园政策-奖学金', '怎么申请奖学金'],
    ['课程资料-数据结构', '数据结构期末复习重点'],
    ['显式知识库请求', '请根据知识库里的文档回答'],
    ['复杂问候词尾', '你好，请问食堂在哪'],
  ];
  for (const [desc, input] of ragCases) {
    it(`正向匹配 rag：${desc} → rag`, () => {
      const r = getRouter().fastRoute(input);
      expect(r).not.toBeNull();
      expect(r.intent).toBe(INTENT_TYPES.KNOWLEDGE_QUERY);
      expect(r.route).toBe('rag');
      expect(r.confidence).toBeGreaterThan(0);
    });
  }

  // 不应触发知识库的普通问题 → null（走兜底 chat）
  const nullCases = [
    ['天气闲聊', '今天天气怎么样'],
    ['普通写作', '帮我写一封请假邮件'],
    ['通用编程知识', '什么是闭包'],
    ['普通翻译', '把这句话翻译成英文'],
  ];
  for (const [desc, input] of nullCases) {
    it(`不硬路由：${desc} → null（走兜底 chat）`, () => {
      const r = getRouter().fastRoute(input);
      expect(r).toBeNull();
    });
  }
});

describe('IntentRouter.route', () => {
  it('fastRoute 命中时直接返回，不调用 LLM', async () => {
    const router = getRouter();
    const r = await router.route('你好');
    expect(r.route).toBe('chat');
    expect(r.intent).toBe(INTENT_TYPES.GENERAL_CHAT);
  });

  it('明确校园问题走 rag', async () => {
    const router = getRouter();
    const r = await router.route('学校食堂几点关门');
    expect(r.route).toBe('rag');
    expect(r.intent).toBe(INTENT_TYPES.KNOWLEDGE_QUERY);
    expect(r.reason).toContain('知识库');
  });

  it.each([
    ['帮我写一封请假邮件'],
    ['什么是闭包'],
    ['今天天气怎么样'],
  ])('普通问题兜底走 chat：%s', async (message) => {
    const r = await getRouter().route(message);
    expect(r.route).toBe('chat');
    expect(r.intent).toBe(INTENT_TYPES.GENERAL_CHAT);
    expect(r.reason).toContain('兜底');
    expect(r.confidence).toBeGreaterThan(0);
  });
});

describe('IntentRouter.classify (LLM 兜底)', () => {
  it('LLM 返回合法 JSON 时解析为路由结果', async () => {
    const fakeAi = {
      getCompletion: async () => ({
        content: '{"intent": "general_chat", "confidence": 0.9, "params": {}, "reason": "闲聊"}',
        isMock: false,
      }),
    };
    const router = new IntentRouter(fakeAi);
    const r = await router.classify('帮我写首诗');
    expect(r.route).toBe('chat');
    expect(r.intent).toBe(INTENT_TYPES.GENERAL_CHAT);
    expect(r.confidence).toBe(0.9);
  });

  it('LLM 返回无法解析的内容时走兜底 chat', async () => {
    const fakeAi = {
      getCompletion: async () => ({ content: '抱歉我无法分类', isMock: false }),
    };
    const router = new IntentRouter(fakeAi);
    const r = await router.classify('帮我润色这段话');
    expect(r.route).toBe('chat');
    expect(r.intent).toBe(INTENT_TYPES.GENERAL_CHAT);
  });

  it('LLM 超时（15s）时走兜底 chat', async () => {
    const fakeAi = {
      getCompletion: () => new Promise(() => {}), // 永不 resolve，触发 race 超时
    };
    const router = new IntentRouter(fakeAi);
    const r = await router.classify('什么都不会超时的问题');
    expect(r.route).toBe('chat');
  }, 20000); // 超时用例需要等 15s race 触发
});
