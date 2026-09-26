import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/rag/rag.service', () => ({
  RagService: class RagService {},
}));

vi.mock('../src/services/llm/ai.service', () => ({
  aiService: {},
}));

vi.mock('../src/services/knowledge/document.service', () => ({
  DocumentService: class DocumentService {},
}));

vi.mock('../src/services/memory/memory-store.service', () => ({
  redis: {},
}));

vi.mock('../src/services/memory/memory.service', () => ({
  MemoryService: class MemoryService {
    saveChatMemory() {}
  },
}));

vi.mock('../src/utils/response', () => ({
  successResponse: vi.fn(),
  errorResponse: vi.fn(),
}));

vi.mock('../src/services/knowledge/file-upload.service', () => ({
  upload: { single: vi.fn(() => vi.fn()) },
  parseFile: vi.fn(),
  cleanupFile: vi.fn(),
}));

function getRagChatStream() {
  delete require.cache[require.resolve('../src/controllers/rag.controller')];
  return require('../src/controllers/rag.controller').ragChatStream;
}

describe('rag.controller ragChatStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('SSE 响应头发送失败时将原始错误交给 next', async () => {
    const expectedError = new Error('flush failed');
    const response = {
      headersSent: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(() => { throw expectedError; }),
      removeListener: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    };
    const next = vi.fn();

    await getRagChatStream()(
      { body: { message: '请介绍学校图书馆', history: [] }, userId: 'u1', get: vi.fn() },
      response,
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(expectedError);
    expect(response.write).not.toHaveBeenCalled();
  });
});

describe('rag.controller updateFeedbackEvalStatus', () => {
  // 原生 require 与控制器共享同一 CJS 模块图（vi.mock 不拦截 raw require），
  // 因此这里直接用真实 SQLite 存储跑集成断言，避免 mock 实例身份不一致
  function getHandlerAndStore() {
    delete require.cache[require.resolve('../src/controllers/rag.controller')];
    delete require.cache[require.resolve('../src/services/memory/memory-store.service')];
    const handler = require('../src/controllers/rag.controller').updateFeedbackEvalStatus;
    const store = require('../src/services/memory/memory-store.service').redis;
    return { handler, store };
  }

  const TEST_USER = 'eval_status_it_user';
  const TEST_ID = 'conv_it:msg_it';

  const makeRes = () => {
    const res = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('非管理员返回 403', async () => {
    const { handler } = getHandlerAndStore();
    const res = makeRes();

    await handler({ userId: TEST_USER, body: { userId: TEST_USER, feedbackId: TEST_ID, status: 'queued' } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('状态非法或缺少标识返回 400', async () => {
    const { handler } = getHandlerAndStore();

    const resA = makeRes();
    await handler({ userId: 'admin', body: { userId: TEST_USER, feedbackId: TEST_ID, status: 'bad' } }, resA, vi.fn());
    expect(resA.status).toHaveBeenCalledWith(400);

    const resB = makeRes();
    await handler({ userId: 'admin', body: { status: 'queued' } }, resB, vi.fn());
    expect(resB.status).toHaveBeenCalledWith(400);
  });

  it('反馈不存在返回 404', async () => {
    const { handler } = getHandlerAndStore();
    const res = makeRes();

    await handler({ userId: 'admin', body: { userId: TEST_USER, feedbackId: 'missing:id', status: 'queued' } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('入队成功：evalStatus/evalStatusAt 落库且双写生效', async () => {
    const { handler, store } = getHandlerAndStore();
    await store.hset(`rag_feedback:${TEST_USER}`, TEST_ID, { id: TEST_ID, rating: 'dislike', question: '测试问题' });

    const res = makeRes();
    await handler({ userId: 'admin', body: { userId: TEST_USER, feedbackId: TEST_ID, status: 'queued' } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const saved = (await store.hgetall(`rag_feedback:${TEST_USER}`))[TEST_ID];
    expect(saved.evalStatus).toBe('queued');
    expect(saved.evalStatusAt).toEqual(expect.any(String));
    const allView = (await store.hgetall('rag_feedback:all'))[`${TEST_USER}:${TEST_ID}`];
    expect(allView.evalStatus).toBe('queued');
  });
});

describe('rag.controller listFeedback（真实 SQLite 回归）', () => {
  // 历史 bug：await 括号位置错误使 .filter 链在 Promise 上，接口恒 500。
  // 该接口此前无测试覆盖，用真实存储走一遍完整链路防回归。
  function getListHandler() {
    delete require.cache[require.resolve('../src/controllers/rag.controller')];
    delete require.cache[require.resolve('../src/services/memory/memory-store.service')];
    return {
      handler: require('../src/controllers/rag.controller').listFeedback,
      store: require('../src/services/memory/memory-store.service').redis,
    };
  }

  const ADMIN = 'admin'; // isAdminRequest 以 userId === 'admin' 判定
  const USER = 'list_fb_user';

  const makeRes = () => {
    const res = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 清理共享 SQLite 单例中的反馈数据，保证测试隔离
    const { store } = getListHandler();
    const all = await store.hgetall('rag_feedback:all');
    for (const field of Object.keys(all || {})) {
      const userId = String(field).split(':')[0];
      await store.hdel(`rag_feedback:${userId}`, String(field).split(':').slice(1).join(':'));
      await store.hdel('rag_feedback:all', field);
    }
  });

  it('管理员查询反馈返回 200 与分页数据', async () => {
    const { handler, store } = getListHandler();
    await store.hset('rag_feedback:list_user', 'c1:m1', {
      id: 'c1:m1', userId: USER, rating: 'dislike',
      question: '校车几点？', answer: '未检索到', createdAt: new Date().toISOString(),
    });
    await store.hset('rag_feedback:all', `${USER}:c1:m1`, {
      id: 'c1:m1', userId: USER, rating: 'dislike',
      question: '校车几点？', answer: '未检索到', createdAt: new Date().toISOString(),
    });

    const res = makeRes();
    await handler({ userId: ADMIN, query: { page: 1, limit: 20 } }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.items[0].question).toBe('校车几点？');
  });

  it('rating 筛选生效', async () => {
    const { handler, store } = getListHandler();
    await store.hset('rag_feedback:all', `${USER}:c2:m2`, {
      id: 'c2:m2', userId: USER, rating: 'like', question: 'q', answer: 'a', createdAt: new Date().toISOString(),
    });

    const res = makeRes();
    await handler({ userId: ADMIN, query: { page: 1, limit: 20, rating: 'like' } }, res, vi.fn());

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.items.every((item) => item.rating === 'like')).toBe(true);
  });

  it('非管理员返回 403', async () => {
    const { handler } = getListHandler();
    const res = makeRes();

    await handler({ userId: USER, query: {} }, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
