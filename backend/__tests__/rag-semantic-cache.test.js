import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SemanticCache } from '../src/services/rag-semantic-cache.service';

// 与被测服务同一 CJS 模块图取 config，保证开关修改对服务可见
const config = require('../src/config');
const { bumpCorpusVersion, resetCorpusVersionForTest } = require('../src/services/corpus-version.service');

function getRetrievalModule() {
  delete require.cache[require.resolve('../src/services/rag-retrieval.service')];
  return require('../src/services/rag-retrieval.service');
}

describe('SemanticCache 余弦相似度', () => {
  it('相同向量为 1，正交为 0，反向为 -1', () => {
    expect(SemanticCache.cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(SemanticCache.cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(SemanticCache.cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('零向量 / 空向量 / Float32Array 边界', () => {
    expect(SemanticCache.cosine([0, 0], [1, 1])).toBe(0);
    expect(SemanticCache.cosine([], [1, 1])).toBe(0);
    expect(SemanticCache.cosine(null, [1, 1])).toBe(0);
    const a = new Float32Array([1, 2, 3]);
    expect(SemanticCache.cosine(a, [1, 2, 3])).toBeCloseTo(1, 10);
  });
});

describe('SemanticCache 存取', () => {
  it('相同向量命中并返回原查询与相似度', () => {
    const cache = new SemanticCache({ threshold: 0.95 });
    cache.store('武理有几个食堂', [1, 2, 3], { candidates: ['c1'] });
    const hit = cache.lookup([1, 2, 3]);
    expect(hit).not.toBeNull();
    expect(hit.query).toBe('武理有几个食堂');
    expect(hit.similarity).toBeGreaterThanOrEqual(0.95);
    expect(hit.value.candidates).toEqual(['c1']);
  });

  it('低于阈值不命中并计入 miss', () => {
    const cache = new SemanticCache({ threshold: 0.95 });
    cache.store('问题A', [1, 0], { candidates: [] });
    expect(cache.lookup([0, 1])).toBeNull();
    expect(cache.stats.misses).toBe(1);
  });

  it('相似度等于阈值时命中（>= 判定）', () => {
    const cache = new SemanticCache({ threshold: 0.5 });
    cache.store('问题A', [1, 1], { candidates: [] });
    // [1,0] 与 [1,1] 余弦 = √2/2 ≈ 0.707
    expect(cache.lookup([1, 0])).not.toBeNull();
  });

  it('同意图变体写入原位更新，不重复占位', () => {
    const cache = new SemanticCache({ threshold: 0.95 });
    cache.store('武理有几个食堂', [1, 2, 3], { candidates: ['旧'] });
    cache.store('学校一共多少个食堂', [1, 2, 3.001], { candidates: ['新'] });
    expect(cache.stats.size).toBe(1);
    expect(cache.lookup([1, 2, 3]).value.candidates).toEqual(['新']);
  });

  it('超过上限淘汰最旧条目', () => {
    const cache = new SemanticCache({ maxEntries: 1, threshold: 0.95 });
    cache.store('问题A', [1, 0], { v: 'A' });
    cache.store('问题B', [0, 1], { v: 'B' });
    expect(cache.stats.size).toBe(1);
    expect(cache.lookup([1, 0])).toBeNull(); // A 已被淘汰
    expect(cache.lookup([0, 1]).value.v).toBe('B');
  });

  it('TTL 过期后不命中', async () => {
    const cache = new SemanticCache({ ttlMs: 15, threshold: 0.95 });
    cache.store('问题A', [1, 0], { v: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cache.lookup([1, 0])).toBeNull();
    expect(cache.stats.size).toBe(0);
  });
});

describe('retrieveCandidates 语义缓存集成', () => {
  const searchResults = [
    { id: 'd1:0', docId: 'd1', chunkIndex: 0, score: 0.9, _retrievalChannels: ['vector'] },
    { id: 'd1:1', docId: 'd1', chunkIndex: 1, score: 0.8, _retrievalChannels: ['vector'] },
  ];
  let retrieval;

  function makeSvc(dense) {
    return {
      searchTopK: 50,
      rrfK: 60,
      // 检索链路走 embedQuery（查询侧带 BGE 指令前缀），文档侧才用 embedHybrid
      embeddingService: {
        embedHybrid: vi.fn().mockResolvedValue({ dense, sparse: {} }),
        embedQuery: vi.fn().mockResolvedValue({ dense, sparse: {} }),
        queryInstructionEnabled: true,
      },
      vectorStore: { search: vi.fn().mockResolvedValue(searchResults) },
      _inferDocCategory: vi.fn().mockReturnValue(null),
      _recordTraceStage: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    config.rag.semanticCacheEnabled = true;
    config.rag.cacheEnabled = true;
    retrieval = getRetrievalModule();
    retrieval.invalidateRetrievalCaches();
    resetCorpusVersionForTest(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.rag.semanticCacheEnabled = false;
  });

  it('不同文本但向量相近的第二个问题命中语义缓存，不再查向量库', async () => {
    const svc = makeSvc([1, 2, 3]);

    const first = await retrieval.retrieveCandidates(svc, '武理有几个食堂', {});
    expect(svc.vectorStore.search).toHaveBeenCalledTimes(1);
    expect(first.trace.semanticCache).toBeUndefined();

    // 不同问法、相同向量（本地 BGE 对近义句给出高相似向量）→ 语义命中
    const second = await retrieval.retrieveCandidates(svc, '学校一共多少个食堂', {});
    expect(svc.vectorStore.search).toHaveBeenCalledTimes(1); // 未增加
    expect(second.trace.semanticCache).toEqual({
      hit: true,
      matchedQuery: '武理有几个食堂',
      similarity: expect.any(Number),
    });
    expect(second.candidates).toEqual(searchResults);
  });

  it('知识库 generation 变化后不复用旧的精确或语义候选池', async () => {
    const svc = makeSvc([1, 2, 3]);

    await retrieval.retrieveCandidates(svc, '武理有几个食堂', {});
    bumpCorpusVersion({ reason: 'test_document_update', docId: 'doc-1' });
    await retrieval.retrieveCandidates(svc, '学校一共多少个食堂', {});

    expect(svc.vectorStore.search).toHaveBeenCalledTimes(2);
  });

  it('开关关闭时行为与原来一致（每次都查向量库）', async () => {
    config.rag.semanticCacheEnabled = false;
    const svc = makeSvc([1, 2, 3]);

    await retrieval.retrieveCandidates(svc, '问题A', {});
    await retrieval.retrieveCandidates(svc, '问题B', {});
    expect(svc.vectorStore.search).toHaveBeenCalledTimes(2);
  });
});
