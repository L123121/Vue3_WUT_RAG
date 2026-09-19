import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function getEmbeddingService() {
  return getEmbeddingModule().EmbeddingService;
}

/** 取整个模块（含 SparseStats / setSparseStats），保证与服务实例是同一个模块闭包 */
function getEmbeddingModule() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/embedding.service')];
  return require('../src/services/embedding.service');
}

describe('EmbeddingService', () => {
  it('查询 embedding 固定使用本地 BGE-small-zh，不再调用远程 API', async () => {
    const previousModel = process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_MODEL;

    try {
      const EmbeddingService = getEmbeddingService();
      const service = new EmbeddingService();
      service._localHybridEmbed = vi.fn().mockResolvedValue({
        dense: [1, 0, 0],
        sparse: { 1: 1 },
        model: 'BGE-small-zh:local-onnx',
        dimensions: 3,
      });

      const result = await service.embedHybrid('校历');

      expect(service.model).toBe('Xenova/bge-small-zh-v1.5');
      expect(service._callApiBatch).toBeUndefined();
      // 文档侧走 doc 模式：不加查询指令前缀
      expect(service._localHybridEmbed).toHaveBeenCalledWith('校历', { queryMode: false });
      expect(result.model).toBe('BGE-small-zh:local-onnx');
    } finally {
      if (previousModel === undefined) {
        delete process.env.EMBEDDING_MODEL;
      } else {
        process.env.EMBEDDING_MODEL = previousModel;
      }
    }
  });
});

/**
 * 造一个可控的假 ONNX 模型：数组入参按批返回 [n,3] 张量，字符串入参返回单条。
 * 用于在不加载真实模型的前提下验证批量路径的调用次数与结果切片。
 */
function makeFakeModel({ failBatch = false, failAll = false } = {}) {
  return vi.fn(async (input) => {
    if (failAll) throw new Error('infer failed');
    if (Array.isArray(input)) {
      if (failBatch) throw new Error('batch infer failed');
      const n = input.length;
      return { dims: [n, 3], data: Float32Array.from(Array.from({ length: n * 3 }, (_, i) => i)) };
    }
    return { dims: [3], data: Float32Array.from([9, 9, 9]) };
  });
}

describe('BGE 查询指令前缀（非对称检索）', () => {
  it('查询侧走带前缀路径，且前缀不进 sparse 通道', async () => {
    const EmbeddingService = getEmbeddingService();
    const service = new EmbeddingService();

    service._localDense = vi.fn().mockResolvedValue({ vector: [1, 0, 0], degraded: false });
    const sparseSpy = vi.spyOn(service, '_localSparse');

    await service.embedQuery('缓考怎么申请');

    expect(service._localDense).toHaveBeenCalledWith('缓考怎么申请', { queryMode: true });
    // sparse 必须基于原始文本——否则指令词会与全库文档产生字面重叠
    expect(sparseSpy).toHaveBeenCalledWith('缓考怎么申请');
  });

  it('_encodeText 只在 queryMode 时拼前缀', () => {
    const EmbeddingService = getEmbeddingService();
    const service = new EmbeddingService();

    expect(service._encodeText('校历', true)).toContain('为这个句子生成表示以用于检索相关文章：');
    expect(service._encodeText('校历', true)).toContain('校历');
    expect(service._encodeText('校历', false)).toBe('校历');
  });

  it('EMBEDDING_QUERY_INSTRUCTION=false 时查询退回 doc 模式，便于 A/B 对比', async () => {
    const previous = process.env.EMBEDDING_QUERY_INSTRUCTION;
    process.env.EMBEDDING_QUERY_INSTRUCTION = 'false';
    try {
      const EmbeddingService = getEmbeddingService();
      const service = new EmbeddingService();
      service._localHybridEmbed = vi.fn().mockResolvedValue({ dense: [1, 0, 0], sparse: {} });

      await service.embedQuery('校历');

      expect(service.queryInstructionEnabled).toBe(false);
      expect(service._localHybridEmbed).toHaveBeenCalledWith('校历', { queryMode: false });
    } finally {
      if (previous === undefined) delete process.env.EMBEDDING_QUERY_INSTRUCTION;
      else process.env.EMBEDDING_QUERY_INSTRUCTION = previous;
    }
  });

  it('缓存 key 区分 query/doc，同一文本两种模式不会互相命中', async () => {
    const EmbeddingService = getEmbeddingService();
    const service = new EmbeddingService();
    service._localHybridEmbed = vi.fn().mockResolvedValue({ dense: [1, 0, 0], sparse: {} });

    await service.embedHybrid('同一句话');
    await service.embedQuery('同一句话');
    await service.embedHybrid('同一句话');

    // 第三次是 doc 模式重复 → 命中缓存，共 2 次真实编码
    expect(service._localHybridEmbed).toHaveBeenCalledTimes(2);
  });
});

describe('embedBatch 真实批量推理', () => {
  it('按 batchSize 分组，一次前向处理一批并保持结果顺序', async () => {
    const previous = process.env.EMBEDDING_BATCH_SIZE;
    process.env.EMBEDDING_BATCH_SIZE = '2';
    try {
      const EmbeddingService = getEmbeddingService();
      const service = new EmbeddingService();
      expect(service.batchSize).toBe(2);

      const fakeModel = makeFakeModel();
      service._ensureLocalModel = vi.fn().mockResolvedValue(fakeModel);

      const texts = ['a', 'b', 'c', 'd', 'e'];
      const results = await service.embedBatch(texts);

      expect(results).toHaveLength(5);
      expect(results.every(r => r && r.dense)).toBe(true);
      // 2+2 走数组批量，最后 1 条复用单条路径 → 共 3 次前向
      expect(fakeModel).toHaveBeenCalledTimes(3);
      const batchCalls = fakeModel.mock.calls.filter(c => Array.isArray(c[0]));
      expect(batchCalls).toHaveLength(2);
      expect(batchCalls[0][0]).toEqual(['a', 'b']);
      // 切片正确：第一批张量 [0..5] → 前两条分别是 [0,1,2] / [3,4,5]
      expect(results[0].dense).toEqual([0, 1, 2]);
      expect(results[1].dense).toEqual([3, 4, 5]);
      expect(results[0].degraded).toBe(false);
      expect(results[0].model).toBe('BGE-small-zh:local-onnx');
    } finally {
      if (previous === undefined) delete process.env.EMBEDDING_BATCH_SIZE;
      else process.env.EMBEDDING_BATCH_SIZE = previous;
    }
  });

  it('批次推理失败时回退逐条并如实标记 degraded', async () => {
    const previous = process.env.EMBEDDING_BATCH_SIZE;
    process.env.EMBEDDING_BATCH_SIZE = '4';
    try {
      const EmbeddingService = getEmbeddingService();
      const service = new EmbeddingService();

      const fakeModel = makeFakeModel({ failAll: true });
      service._ensureLocalModel = vi.fn().mockResolvedValue(fakeModel);

      const results = await service.embedBatch(['a', 'b', 'c']);

      expect(results).toHaveLength(3);
      // 批量失败 → 回退逐条；逐条推理同样失败 → n-gram 降级，语义必须如实反映
      expect(results.every(r => r.degraded === true)).toBe(true);
      expect(results.every(r => r.model === 'ngram-fallback')).toBe(true);
      expect(results[0].dense).toHaveLength(512);
    } finally {
      if (previous === undefined) delete process.env.EMBEDDING_BATCH_SIZE;
      else process.env.EMBEDDING_BATCH_SIZE = previous;
    }
  });
});

/** 造一份"高频词 vs 稀有词"的语料统计 */
function makeStatsFixture(service) {
  // 10 篇：9 篇都在说"学校课程"，仅 1 篇提到"缓考"
  const corpus = [...Array(9).fill('学校课程安排'), '缓考申请流程'];
  return service.buildSparseStats(corpus);
}

describe('稀疏通道 BM25（idf + 长度归一化）', () => {
  let mod;
  let svc;

  beforeEach(() => {
    mod = getEmbeddingModule();
    svc = new mod.EmbeddingService();
  });

  afterEach(() => {
    mod.setSparseStats(null);
  });

  it('无语料统计时退回纯 tf —— 文档侧与查询侧一致，绝不单侧带 idf', () => {
    const weights = svc._localSparse('缓考怎么申请');

    expect(Object.keys(weights).length).toBeGreaterThan(0);
    // 纯 tf：每个词项权重都是正整数词频
    expect(Object.values(weights).every(v => Number.isInteger(v) && v > 0)).toBe(true);
  });

  it('有语料统计时按 idf 加权：稀有词项权重高于高频词项', () => {
    const stats = makeStatsFixture(svc);
    mod.setSparseStats(stats);

    const commonKey = [...svc._tokenize('学校').keys()][0];
    const rareKey = [...svc._tokenize('缓考').keys()][0];
    expect(stats.idf(rareKey)).toBeGreaterThan(stats.idf(commonKey));

    const weights = svc._localSparse('缓考学校');
    expect(weights[rareKey]).toBeGreaterThan(weights[commonKey]);
  });

  it('长度归一化：同一词项在长块里的权重低于短块', () => {
    mod.setSparseStats(makeStatsFixture(svc));
    const key = [...svc._tokenize('缓考').keys()][0];

    const shortText = svc._localSparse('缓考');
    const longText = svc._localSparse(`缓考${'额外内容'.repeat(30)}`);

    expect(longText[key]).toBeLessThan(shortText[key]);
  });

  it('EMBEDDING_SPARSE_IDF=false 时即使有统计也退回纯 tf（便于 A/B）', () => {
    const previous = process.env.EMBEDDING_SPARSE_IDF;
    process.env.EMBEDDING_SPARSE_IDF = 'false';
    try {
      const m = getEmbeddingModule();
      const service = new m.EmbeddingService();
      expect(service.sparseIdfEnabled).toBe(false);
      m.setSparseStats(makeStatsFixture(service));

      const weights = service._localSparse('缓考学校');
      expect(Object.values(weights).every(v => Number.isInteger(v) && v > 0)).toBe(true);
      m.setSparseStats(null);
    } finally {
      if (previous === undefined) delete process.env.EMBEDDING_SPARSE_IDF;
      else process.env.EMBEDDING_SPARSE_IDF = previous;
    }
  });

  it('激活语料统计后向量缓存自动失效，避免新旧 idf 混用', async () => {
    svc._localHybridEmbed = vi.fn().mockResolvedValue({ dense: [1, 0, 0], sparse: {} });

    await svc.embedHybrid('同一句话');
    await svc.embedHybrid('同一句话');   // doc 模式重复 → 命中缓存
    expect(svc._localHybridEmbed).toHaveBeenCalledTimes(1);

    mod.setSparseStats(makeStatsFixture(svc));
    await svc.embedHybrid('同一句话');   // 统计版本变化 → 必须重新编码
    expect(svc._localHybridEmbed).toHaveBeenCalledTimes(2);
  });

  it('SparseStats 可序列化往返（持久化后查询侧能拿到同一份 idf）', () => {
    const { SparseStats } = mod;
    const stats = makeStatsFixture(svc);
    const restored = SparseStats.fromJSON(JSON.parse(JSON.stringify(stats.toJSON())));

    expect(restored.docCount).toBe(stats.docCount);
    expect(restored.avgLen).toBeCloseTo(stats.avgLen, 6);
    const key = [...svc._tokenize('缓考').keys()][0];
    expect(restored.idf(key)).toBeCloseTo(stats.idf(key), 10);
  });
});
