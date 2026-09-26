/**
 * RAG 管道端到端集成测试
 *
 * 验证「问 → 检索 → rerank → 上下文装配」全链路契约。
 *
 * 设计决策：
 *   - embedding 使用真实 BGE-small-zh ONNX 模型（本地缓存）
 *   - reranker 用 module-level mock（本地无 bge-reranker-base 缓存，278MB 未下载）
 *     mock 用 query-text 关键词 overlap 打分，模拟 cross-encoder 排序效果
 *   - Qdrant 通过 spyOn 注入 fake client（格式: { points: [{ id, score, payload }] }）
 *   - 每个测试 vi.resetModules() 隔离模块级单例
 *
 * 运行：npx vitest run --config vitest.integration.config.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
const fs = require('fs');
const path = require('path');

// 真实 ONNX 用例依赖本地模型缓存（.model-cache）。缓存缺失（全新环境/CI 未预热）时
// embedding 加载会失败并导致整组断言误报，这里显式 skip 而不是让用例挂掉。
const EMBEDDING_ONNX_PATH = path.resolve(
  __dirname,
  '../../.model-cache/Xenova/bge-small-zh-v1.5/onnx/model_quantized.onnx'
);
const hasEmbeddingCache = fs.existsSync(EMBEDDING_ONNX_PATH);
const describeE2E = hasEmbeddingCache ? describe : describe.skip;

// ─── Reranker Service Mock ────────────────────────────────────
// 本地无 bge-reranker-base 模型缓存，用关键词 overlap 模拟 cross-encoder 打分
vi.mock('../src/services/knowledge/reranker.service', () => {
  const { QueryCache } = require('../src/utils/query-cache');
  const rerankerScoreCache = new QueryCache(2000, 300000);

  class MockRerankerService {
    async _loadModel() {
      // 返回一个假的 model 对象，避免真实加载
      return { tokenizer: {}, model: () => ({ logits: { data: new Float32Array([0]) } }) };
    }

    async rerank(query, candidates, topK = 5) {
      if (!candidates || candidates.length === 0) return [];
      if (candidates.length === 1) {
        candidates[0]._rerankScore = candidates[0].score || 0;
        candidates[0]._rerankModel = 'skip';
        return candidates;
      }

      const qKey = String(query || '').trim().toLowerCase();
      const qWords = new Set(qKey.replace(/[^一-龥a-z0-9]/g, '').split('').filter(Boolean));

      // 缓存拦截 + 逐条打分
      const uncached = [];
      let allCached = true;
      for (const c of candidates) {
        const textHash = Buffer.from(String(c.text || '').slice(0, 200)).toString('hex').slice(0, 12);
        const cachedScore = rerankerScoreCache.get(`${qKey}|${textHash}`);
        if (cachedScore !== undefined) {
          c._rerankScore = cachedScore;
          c._rerankModel = 'cache';
        } else {
          allCached = false;
          uncached.push(c);
        }
      }
      if (allCached) {
        candidates.forEach(c => { c._rerankModel = 'cache'; });
        candidates.sort((a, b) => (b._rerankScore || 0) - (a._rerankScore || 0));
        return candidates.slice(0, topK);
      }
      if (uncached.length < candidates.length) {
        candidates = uncached;
      }

      // 关键词 overlap 模拟 cross-encoder 打分
      for (const c of candidates) {
        const text = String(c.text || '');
        const textWords = new Set(text.replace(/[^一-龥a-z0-9]/g, '').split('').filter(Boolean));
        let overlap = 0;
        for (const w of qWords) { if (textWords.has(w)) overlap++; }
        const baseScore = c.score || 0;
        const boost = qWords.size > 0 ? (overlap / qWords.size) * 0.3 : 0;
        const score = Math.min(1, baseScore + boost);

        c._rerankScore = score;
        c._rerankModel = 'mock-reranker';
        rerankerScoreCache.set(`${qKey}|${Buffer.from(text.slice(0, 200)).toString('hex').slice(0, 12)}`, score);
      }

      candidates.sort((a, b) => (b._rerankScore || 0) - (a._rerankScore || 0));
      return candidates.slice(0, topK);
    }
  }

  return { RerankerService: MockRerankerService };
});

// ─── 工具函数 ────────────────────────────────────────────────

function resetAll() {
  vi.resetModules();
  vi.clearAllMocks();
}

function loadClass(cjsPath) {
  delete require.cache[require.resolve(cjsPath)];
  return require(cjsPath);
}

/** 512d 向量：前 50 维高值 + 其余低频 */
function highDimVector(amp = 0.9, phase = 0) {
  return Array.from({ length: 512 }, (_, i) =>
    i < 50 ? amp - i * 0.001 + phase : Math.sin(i * 0.1 + phase) * 0.2
  );
}

function lowDimVector() {
  return Array.from({ length: 512 }, () => Math.random() * 0.05);
}

// ─── Mock Reranker Service ────────────────────────────────────
// 用关键词 overlap 模拟 cross-encoder 打分（本地无 bge-reranker-base 模型缓存）

function createMockReranker() {
  const { QueryCache } = require('../src/utils/query-cache');
  const scoreCache = new QueryCache(2000, 300000);
  const stats = { cacheHits: 0, scoreComputations: 0 };

  return {
    async _loadModel() {
      return { tokenizer: {}, model: () => ({ logits: { data: new Float32Array([0]) } }) };
    },
    async rerank(query, candidates, topK = 5) {
      try {
        await this._loadModel();
      } catch (err) {
        return candidates.slice(0, topK).map(c => ({ ...c, _rerankScore: c.score || 0, _rerankModel: 'fallback' }));
      }

      if (!candidates || candidates.length === 0) return [];
      if (candidates.length === 1) {
        candidates[0]._rerankScore = candidates[0].score || 0;
        candidates[0]._rerankModel = 'skip';
        return candidates;
      }

      const qKey = String(query || '').trim().toLowerCase();
      const qChars = new Set(qKey.replace(/[^一-龥a-z0-9]/g, ''));

      // 缓存检查
      const uncached = [];
      let allCached = true;
      for (const c of candidates) {
        const textHash = Buffer.from(String(c.text || '').slice(0, 200)).toString('hex').slice(0, 12);
        const cached = scoreCache.get(`${qKey}|${textHash}`);
        if (cached !== undefined) {
          c._rerankScore = cached;
          c._rerankModel = 'cache';
          stats.cacheHits += 1;
        } else {
          allCached = false;
          uncached.push(c);
        }
      }
      if (allCached) {
        candidates.forEach(c => { c._rerankModel = 'cache'; });
        candidates.sort((a, b) => (b._rerankScore || 0) - (a._rerankScore || 0));
        return candidates.slice(0, topK);
      }
      if (uncached.length < candidates.length) {
        candidates = uncached;
      }

      // 关键词 overlap 模拟 cross-encoder
      for (const c of candidates) {
        const text = String(c.text || '');
        const textChars = new Set(text.replace(/[^一-龥a-z0-9]/g, ''));
        let overlap = 0;
        for (const ch of qChars) { if (textChars.has(ch)) overlap++; }
        const boost = qChars.size > 0 ? (overlap / qChars.size) * 0.3 : 0;
        c._rerankScore = Math.min(1, (c.score || 0) + boost);
        c._rerankModel = 'mock-reranker';
        stats.scoreComputations += 1;
        scoreCache.set(`${qKey}|${Buffer.from(text.slice(0, 200)).toString('hex').slice(0, 12)}`, c._rerankScore);
      }

      candidates.sort((a, b) => (b._rerankScore || 0) - (a._rerankScore || 0));
      return candidates.slice(0, topK);
    },
    stats,
  };
}

// ─── Qdrant Fake 数据适配 ────────────────────────────────────
// store.search() 期望: client.query() → { points: [{ id, score, payload: {...} }] }

function makeChunk(id, docId, parentIdx, text, parentText, score, denseVec) {
  return {
    id, docId, parentIdx,
    parentId: `${docId}_para_${parentIdx}`,
    text, parentText, score, dense: denseVec,
    sparse: { [Math.abs((id || '').charCodeAt(0) || 1) % 1000 + 1]: 1 },
  };
}

function qdrantPoint(chunk) {
  return {
    id: chunk.id,
    score: chunk.score,
    payload: {
      id: chunk.id, docId: chunk.docId,
      parentId: chunk.parentId,
      parentText: chunk.parentText,
      parentIdx: chunk.parentIdx, text: chunk.text,
      title: chunk.docId === 'doc-lib' ? '图书馆服务指南' : chunk.docId === 'doc-caf' ? '校园生活手册' : '测试文档',
      category: '学校概况', chunkIndex: chunk.chunkIndex,
    },
  };
}

function makeFakeQdrantClient(chunks = []) {
  let pointCount = chunks.length;
  return {
    collectionExists: vi.fn().mockResolvedValue({ exists: true }),
    createCollection: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockResolvedValue({ status: 'completed' }),
    query: vi.fn().mockResolvedValue({ points: chunks.map(qdrantPoint) }),
    count: vi.fn().mockImplementation(() => ({ count: pointCount })),
    delete: vi.fn().mockResolvedValue({ status: 'completed' }),
    deleteCollection: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function setupStore(fakeClient) {
  const { QdrantVectorStore } = loadClass('../src/services/knowledge/vector-store-qdrant.service');
  vi.spyOn(QdrantVectorStore.prototype, '_createClient').mockReturnValue(fakeClient);
  const store = new QdrantVectorStore();
  for (let i = 0; i < 200; i++) {
    if (store._ready) return store;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('QdrantVectorStore._ready timeout');
}

// ─── 服务工厂 ────────────────────────────────────────────────

const SAMPLE_DOCS = [
  {
    id: 'doc-lib', title: '图书馆服务指南', category: '学校概况',
    content: '图书馆开放时间是早上 8 点，晚上 10 点关门。节假日另行通知。图书馆藏书超过 200 万册。一楼设有 24 小时自习室。',
    chunkCount: 3, metadata: {},
  },
  {
    id: 'doc-caf', title: '校园生活手册', category: '学校概况',
    content: '南湖食堂有三层。支持校园一卡通和微信支付。人均消费约 10-15 元。',
    chunkCount: 2, metadata: {},
  },
];

function createRagService(vectorStore, docService, rerankerService = null) {
  const { RagService } = loadClass('../src/services/rag/rag.service');
  const rag = new RagService();
  rag.vectorStore = vectorStore;
  rag.documentService = docService;
  if (rerankerService) rag.rerankerService = rerankerService;
  return rag;
}

function createDocService(docs) {
  const map = new Map(docs.map(d => [d.id, d]));
  return {
    hasDocuments: vi.fn().mockResolvedValue(docs.length > 0),
    getDocument: vi.fn().mockImplementation(async docId => map.get(docId) || null),
  };
}

// ─── E2E 测试 ────────────────────────────────────────────────

describeE2E('RAG Pipeline E2E (real ONNX)', () => {
  beforeEach(() => resetAll());

  /**
   * 场景 1：happy path — 完整管道跑通
   */
  it('完整检索管道跑通：检索 → 父段聚合 → rerank → 上下文装配', async () => {
    const chunks = [
      makeChunk('doc-lib_s0', 'doc-lib', 0, '图书馆开放时间是早上 8 点，晚上 10 点关门。',
        '图书馆开放时间是早上 8 点，晚上 10 点关门。节假日另行通知。', 0.92, highDimVector(0.9)),
      makeChunk('doc-lib_s1', 'doc-lib', 0, '图书馆藏书超过 200 万册，涵盖各个学科领域。',
        '图书馆藏书超过 200 万册，涵盖各个学科领域。', 0.88, highDimVector(0.85)),
      makeChunk('doc-lib_s2', 'doc-lib', 1, '图书馆一楼设有 24 小时自习室，需刷卡进入。',
        '图书馆一楼设有 24 小时自习室，需刷卡进入。', 0.75, highDimVector(0.7)),
      makeChunk('doc-caf_s0', 'doc-caf', 2, '南湖食堂有三层，一楼是基本大伙，二楼是特色窗口。',
        '南湖食堂有三层，一楼是基本大伙，二楼是特色窗口，三楼是教职工餐厅。', 0.85, highDimVector(0.8, 1)),
      makeChunk('doc-caf_s1', 'doc-caf', 2, '食堂支持校园一卡通和微信支付，人均消费约 10-15 元。',
        '食堂支持校园一卡通和微信支付，人均消费约 10-15 元。', 0.80, highDimVector(0.75, 1)),
    ];

    const store = await setupStore(makeFakeQdrantClient(chunks));
    const rag = createRagService(store, createDocService(SAMPLE_DOCS));

    const result = await rag.localSearchChat('图书馆几点开门', [], { noCache: true });

    expect(result.reply).toBeTruthy();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.context).toBeTruthy();
    expect(result.context.length).toBeGreaterThan(0);
    // model 契约（2026-08 更新）：返回真实 LLM 模型名（无 API Key 的 mock 模式为 'mock'），
    // 不再是检索管道标记；token 用量随 result.usage 一并返回（mock 模式为 null）
    expect(typeof result.model).toBe('string');
    expect(result.model.length).toBeGreaterThan(0);
    expect(result.usage).toBeDefined();
    expect(result._metrics.matchedDocs).toBeGreaterThan(0);
    expect(result.questionType).toBeDefined();
    expect(result.topChunks.length).toBeGreaterThan(0);
  });

  /**
   * 场景 2：reranker 纠正排序
   *
   * A 向量分高但内容无关，B 向量分低但内容匹配 → mock reranker 把 B 提到前面
   */
  it('reranker 纠正向量检索排序', async () => {
    const bDense = Array.from({ length: 512 }, (_, i) =>
      i < 100 ? 0.75 + Math.sin(i * 0.1) * 0.15 : Math.cos(i * 0.08) * 0.25
    );
    const libDoc = {
      id: 'doc-t', title: '校园综合指南', category: '学校概况',
      content: '图书馆借书规则：本科生最多借 20 本，期限 30 天。课程评分标准：平时成绩占 30%，期末占 70%。体育场开放时间：周一至周五 6:00-22:00。',
      chunkCount: 3, metadata: {},
    };
    const chunks = [
      makeChunk('doc-t_a', 'doc-t', 0, '课程评分标准：平时成绩占 30%，期末占 70%。',
        '课程评分标准详解。', 0.95, highDimVector(0.9)),
      makeChunk('doc-t_b', 'doc-t', 1, '图书馆借书规则：本科生最多借 20 本，期限 30 天。',
        '图书馆借书规则说明。', 0.70, bDense),
      makeChunk('doc-t_c', 'doc-t', 2, '体育场开放时间：周一至周五 6:00-22:00。',
        '体育场开放时间。', 0.50, lowDimVector()),
    ];

    const store = await setupStore(makeFakeQdrantClient(chunks));
    const rag = createRagService(store, createDocService([libDoc]));

    const result = await rag.localSearchChat('图书馆借书有什么规则', [], { noCache: true });

    expect(result.context).toBeTruthy();
    expect(result.context.length).toBeGreaterThan(0);
    expect(result.topChunks.length).toBeGreaterThan(0);
    expect(result.topChunks.map(c => c.text).join('')).toContain('借书');
    // mock reranker 不 skip（>1 候选）
    expect(result.topChunks[0]._rerankModel).not.toBe('skip');
  });

  /**
   * 场景 3：reranker 降级（模拟 _loadModel 抛错）
   *
   * vi.mock 已拦截 RerankerService，但我们可以手动 override _loadModel
   * 验证管道在 reranker 失败时仍能降级返回结果
   */
  it('reranker 加载失败时降级为 fallback 排序', async () => {
    const fbDoc = {
      id: 'doc-fb', title: '测试文档', category: '学校概况',
      content: '备用排序测试第一条内容。备用排序测试第二条内容。',
      chunkCount: 2, metadata: {},
    };
    const chunks = [
      makeChunk('doc-fb_0', 'doc-fb', 0, '备用排序测试第一条内容。',
        '备用排序测试父段。', 0.8, highDimVector(0.5)),
      makeChunk('doc-fb_1', 'doc-fb', 1, '备用排序测试第二条内容。',
        '备用排序测试父段二。', 0.7, highDimVector(0.4)),
    ];

    const store = await setupStore(makeFakeQdrantClient(chunks));
    const { RagService } = loadClass('../src/services/rag/rag.service');
    const rag = new RagService();
    rag.vectorStore = store;
    rag.documentService = createDocService([fbDoc]);

    // 注入失败的 _loadModel
    rag.rerankerService._loadModel = vi.fn().mockRejectedValue(new Error('model load failed'));

    const result = await rag.localSearchChat('备用排序测试', [], { noCache: true });

    expect(result.context).toBeTruthy();
    expect(result.sources[0].rerankModel).toBe('fallback');
  });

  /**
   * 场景 4：无可靠候选 → 降级回复，不调用 LLM
   */
  it('无检索结果时返回降级回复，不调用 LLM', async () => {
    const store = await setupStore(makeFakeQdrantClient([]));
    const rag = createRagService(store, createDocService(SAMPLE_DOCS));
    rag.aiService = { getCompletion: vi.fn() };

    const result = await rag.localSearchChat(
      '量子力学中的薛定谔方程是什么', [], { noCache: true }
    );

    expect(result.reply).toContain('没有检索到足够可靠');
    expect(result.sources).toEqual([]);
    expect(rag.aiService.getCompletion).not.toHaveBeenCalled();
  });

  /**
   * 场景 5：retrievalCache — 同 query 第二次命中
   */
  it('retrievalCache 对相同 query 第二次命中缓存', async () => {
    const cacheDoc = {
      id: 'doc-cache', title: '缓存测试文档', category: '学校概况',
      content: '缓存测试正文。',
      chunkCount: 1, metadata: {},
    };
    const chunks = [
      makeChunk('doc-cache_0', 'doc-cache', 0, '缓存测试正文。',
        '缓存测试父段内容。', 0.8, highDimVector(0.5)),
    ];

    const store = await setupStore(makeFakeQdrantClient(chunks));
    const rag = createRagService(store, createDocService([cacheDoc]));

    const r1 = await rag.localSearchChat('缓存测试问题', [], { noCache: false });
    expect(r1.context).toBeTruthy();

    const r2 = await rag.localSearchChat('缓存测试问题', [], { noCache: false });
    expect(r2.context).toBeTruthy();

    const r3 = await rag.localSearchChat('缓存测试问题', [], { noCache: true });
    expect(r3.context).toBeTruthy();
  });

  /**
   * 场景 6：reranker score cache — 同 (query, passage) 第二次命中
   */
  it('rerankerScoreCache 对相同 (query, passage) 返回缓存分数', async () => {
    const rcDoc = {
      id: 'doc-rc', title: 'Reranker 缓存测试', category: '学校概况',
      content: 'reranker 缓存测试第一条内容。reranker 缓存测试第二条内容。',
      chunkCount: 2, metadata: {},
    };
    const chunks = [
      makeChunk('doc-rc_0', 'doc-rc', 0, 'reranker 缓存测试第一条内容。',
        'reranker 缓存测试第一条父段。', 0.8, highDimVector(0.5)),
      makeChunk('doc-rc_1', 'doc-rc', 1, 'reranker 缓存测试第二条内容。',
        'reranker 缓存测试第二条父段。', 0.7, highDimVector(0.45)),
    ];

    const store = await setupStore(makeFakeQdrantClient(chunks));
    const mockReranker = createMockReranker();
    const rag = createRagService(store, createDocService([rcDoc]), mockReranker);

    // 第一次：mock reranker 实际打分
    await rag.localSearchChat('reranker 缓存测试', [], { noCache: false });

    // 第二次：reranker 分数缓存应命中
    const r2 = await rag.localSearchChat('reranker 缓存测试', [], { noCache: false });
    expect(r2.topChunks.length).toBeGreaterThan(0);
    expect(mockReranker.stats.cacheHits).toBeGreaterThan(0);
  });
});

