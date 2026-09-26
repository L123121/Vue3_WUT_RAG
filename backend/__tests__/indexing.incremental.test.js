import { describe, it, expect, vi, beforeEach } from 'vitest';

function getIndexingService() {
  delete require.cache[require.resolve('../src/services/knowledge/indexing.service')];
  return require('../src/services/knowledge/indexing.service').IndexingService;
}

/**
 * 增量重索引测试：
 * reindexDocument 应按内容 hash 复用未变 chunk 的向量，只对新增/变化的 chunk 调 embedBatch
 */
describe('IndexingService 增量重索引（chunk hash 复用）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const CONTENT = [
    '第一段：武汉理工大学由三校合并而成，历史可追溯至1898年。',
    '第二段：图书馆开放时间为工作日早上八点，周末上午九点。',
    '第三段：校医院提供全科门诊与常见慢性病随访服务。',
  ].join('\n\n');

  // 模拟 Qdrant 返回的旧点（sparse 为 {indices, values} 线上格式）
  const makeOldPoints = (texts) => texts.map((text, i) => ({
    id: `doc_old_sent_${i}`,
    text,
    dense: [i + 1, 0.5],
    sparse: { indices: [i * 10], values: [0.25] },
  }));

  function makeHarness(oldPoints) {
    const vectorStore = {
      getDocPoints: vi.fn().mockResolvedValue(oldPoints),
      deleteByDocId: vi.fn().mockResolvedValue(),
      addChunks: vi.fn().mockResolvedValue(),
      resetCollection: vi.fn().mockResolvedValue(),
    };
    const embeddingService = {
      embedBatch: vi.fn(async (texts) => texts.map((t) => ({ dense: [t.length + 0.1, 1], sparse: { 7: 0.9 } }))),
    };
    const IndexingService = getIndexingService();
    const svc = new IndexingService(vectorStore, embeddingService);
    return { svc, vectorStore, embeddingService };
  }

  it('内容完全未变：零模型调用，全部向量复用旧值', async () => {
    // 旧点文本与切片结果一致（直接用同一切片器生成，保证 hash 对齐）
    const { IndexingService } = { IndexingService: getIndexingService() };
    const probe = new IndexingService(
      { addChunks: vi.fn() },
      { embedBatch: vi.fn() },
    );
    const paras = probe._splitParagraphs(CONTENT);
    const oldTexts = paras.flatMap((p) => probe._splitSentences(p));
    const oldPoints = makeOldPoints(oldTexts);

    const { svc, embeddingService, vectorStore } = makeHarness(oldPoints);
    const count = await svc.reindexDocument('doc_1', '测试文档', CONTENT, 'general');

    expect(count).toBe(oldTexts.length);
    expect(embeddingService.embedBatch).not.toHaveBeenCalled();
    expect(vectorStore.addChunks).toHaveBeenCalledTimes(1);
    const [ids, embeddings] = vectorStore.addChunks.mock.calls[0];
    expect(ids[0]).toBe('doc_1_sent_0');
    // 复用的 dense 与旧点一致（非新算的 length+0.1 形态）
    expect(embeddings[0].dense).toEqual([1, 0.5]);
    expect(svc.lastReuseStats).toEqual({ reused: oldTexts.length, embedded: 0, total: oldTexts.length });
  });

  it('部分段落变化：只有变化的 chunk 走 embedBatch，其余复用', async () => {
    const { IndexingService } = { IndexingService: getIndexingService() };
    const probe = new IndexingService({ addChunks: vi.fn() }, { embedBatch: vi.fn() });
    const oldTexts = probe._splitParagraphs(CONTENT).flatMap((p) => probe._splitSentences(p));
    const oldPoints = makeOldPoints(oldTexts);

    // 只改第二段内容
    const changed = CONTENT.replace('图书馆开放时间为工作日早上八点，周末上午九点。', '图书馆工作日八点开放，周末九点开放，法定节假日另行通知。');

    const { svc, embeddingService, vectorStore } = makeHarness(oldPoints);
    await svc.reindexDocument('doc_1', '测试文档', changed, 'general');

    const calledTexts = embeddingService.embedBatch.mock.calls[0]?.[0] || [];
    expect(calledTexts.length).toBeGreaterThan(0);
    expect(calledTexts.length).toBeLessThan(oldTexts.length);
    // 变化段落的句子一定在重算列表里
    expect(calledTexts.some((t) => t.includes('法定节假日'))).toBe(true);
    // 未变段落（第一段）不在重算列表里
    expect(calledTexts.some((t) => t.includes('1898'))).toBe(false);
    const stats = svc.lastReuseStats;
    expect(stats.reused).toBe(stats.total - stats.embedded);
    expect(vectorStore.addChunks).toHaveBeenCalledTimes(1);
  });

  it('Qdrant 线上 sparse 格式（indices/values）复用时转为 map 形式', async () => {
    const { IndexingService } = { IndexingService: getIndexingService() };
    const probe = new IndexingService({ addChunks: vi.fn() }, { embedBatch: vi.fn() });
    const oldTexts = probe._splitParagraphs(CONTENT).flatMap((p) => probe._splitSentences(p));

    const { svc, vectorStore } = makeHarness(makeOldPoints(oldTexts));
    await svc.reindexDocument('doc_1', '测试文档', CONTENT, 'general');

    const [, embeddings] = vectorStore.addChunks.mock.calls[0];
    expect(embeddings[0].sparse).toEqual({ 0: 0.25 });
    expect(Array.isArray(embeddings[0].sparse.indices)).toBe(false);
  });

  it('向量库不支持 getDocPoints（旧接口）：退化为全量重算，行为不变', async () => {
    const vectorStore = {
      deleteByDocId: vi.fn().mockResolvedValue(),
      addChunks: vi.fn().mockResolvedValue(),
    };
    const embeddingService = {
      embedBatch: vi.fn(async (texts) => texts.map((t) => ({ dense: [t.length + 0.1, 1], sparse: {} }))),
    };
    const IndexingService = getIndexingService();
    const svc = new IndexingService(vectorStore, embeddingService);

    await svc.reindexDocument('doc_1', '测试文档', CONTENT, 'general');

    expect(embeddingService.embedBatch).toHaveBeenCalledTimes(1);
    expect(svc.lastReuseStats.embedded).toBe(svc.lastReuseStats.total);
  });

  it('reindexAll incremental 模式不 reset collection 且逐文档 diff；rebuild 模式保持 reset', async () => {
    const { IndexingService } = { IndexingService: getIndexingService() };
    const probe = new IndexingService({ addChunks: vi.fn() }, { embedBatch: vi.fn() });
    const oldTexts = probe._splitParagraphs(CONTENT).flatMap((p) => probe._splitSentences(p));

    const docs = [{ id: 'doc_1', title: '测试文档', content: CONTENT, category: 'general' }];

    // incremental
    const inc = makeHarness(makeOldPoints(oldTexts));
    await inc.svc.reindexAll(docs, { mode: 'incremental' });
    expect(inc.vectorStore.resetCollection).not.toHaveBeenCalled();
    expect(inc.vectorStore.getDocPoints).toHaveBeenCalledWith('doc_1');
    expect(inc.embeddingService.embedBatch).not.toHaveBeenCalled();

    // rebuild（默认，修复语义）
    const reb = makeHarness(makeOldPoints(oldTexts));
    await reb.svc.reindexAll(docs);
    expect(reb.vectorStore.resetCollection).toHaveBeenCalledTimes(1);
    expect(reb.embeddingService.embedBatch).toHaveBeenCalled();
  });
});
