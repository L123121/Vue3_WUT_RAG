import { describe, expect, it, vi } from 'vitest';

const retrieval = require('../src/services/rag/rag-retrieval.service');
const queryRewrite = require('../src/services/rag/rag-query-rewrite.service');
const { selectRerankCount } = require('../src/services/rag/rag-pipeline.service');

describe('检索关键路径', () => {
  it('原问题检索与改写同时执行，仍合并改写候选', async () => {
    let finishOriginal;
    let finishRewrite;
    const original = new Promise(resolve => { finishOriginal = resolve; });
    const rewrite = new Promise(resolve => { finishRewrite = resolve; });
    const shouldRewrite = vi.spyOn(queryRewrite, 'shouldRewriteQuery').mockReturnValue(true);
    const rewriteQuery = vi.spyOn(queryRewrite, 'rewriteQuery').mockReturnValue(rewrite);
    const svc = {
      searchTopK: 10,
      queryDecomposeEnabled: false,
      hydeEnabled: false,
      stepBackEnabled: false,
      aiService: {},
      _recordTraceStage: vi.fn(),
      retrieveCandidates: vi.fn(q => q === '原问题' ? original : Promise.resolve({
        candidates: [{ id: 'rewritten', score: 0.8 }],
        trace: { queryVariant: 'rewritten' },
      })),
    };
    try {
      const pending = retrieval.dualRetrieve(svc, '原问题', [], {});
      expect(svc.retrieveCandidates).toHaveBeenCalledWith('原问题', expect.objectContaining({ queryVariant: 'original' }));
      expect(rewriteQuery).toHaveBeenCalled();
      finishOriginal({ candidates: [{ id: 'original', score: 0.9 }], trace: {} });
      finishRewrite('改写问题');
      const result = await pending;
      expect(result.candidates.map(c => c.id)).toEqual(['original', 'rewritten']);
      expect(result.rewrittenQuery).toBe('改写问题');
      expect(result.trace.queryRewrite.mergedCount).toBe(2);
    } finally {
      shouldRewrite.mockRestore();
      rewriteQuery.mockRestore();
    }
  });

  it('没有改写时原问题只检索一次', async () => {
    const shouldRewrite = vi.spyOn(queryRewrite, 'shouldRewriteQuery').mockReturnValue(false);
    const svc = {
      queryDecomposeEnabled: false,
      hydeEnabled: false,
      stepBackEnabled: false,
      retrieveCandidates: vi.fn().mockResolvedValue({ candidates: [], trace: {} }),
    };
    try {
      await retrieval.dualRetrieve(svc, '普通问题', [], {});
      expect(svc.retrieveCandidates).toHaveBeenCalledTimes(1);
    } finally {
      shouldRewrite.mockRestore();
    }
  });

  it('原问题检索失败时传播错误，不留下未处理的拒绝', async () => {
    const shouldRewrite = vi.spyOn(queryRewrite, 'shouldRewriteQuery').mockReturnValue(true);
    const rewriteQuery = vi.spyOn(queryRewrite, 'rewriteQuery').mockResolvedValue(null);
    const failure = new Error('vector store unavailable');
    const svc = {
      queryDecomposeEnabled: false,
      hydeEnabled: false,
      stepBackEnabled: false,
      _recordTraceStage: vi.fn(),
      retrieveCandidates: vi.fn().mockRejectedValue(failure),
    };
    try {
      await expect(retrieval.dualRetrieve(svc, '原问题', [], {})).rejects.toBe(failure);
    } finally {
      shouldRewrite.mockRestore();
      rewriteQuery.mockRestore();
    }
  });
});

describe('父段重排预算', () => {
  const scores = values => values.map(score => ({ bestChunk: { score } }));

  it('分数平坦时保留原来的 20 个上限', () => {
    expect(selectRerankCount(scores(Array.from({ length: 24 }, (_, i) => 1 - i * 0.01)))).toBe(20);
  });

  it('明显断层时至少保留 12 个父段', () => {
    expect(selectRerankCount(scores([...Array(12).fill(0.9), ...Array(10).fill(0.3)]))).toBe(12);
    expect(selectRerankCount(scores([0.9, 0.3, ...Array(18).fill(0.2)]))).toBe(20);
  });

  it('少于预算或分数无效时不裁剪', () => {
    expect(selectRerankCount(scores(Array(8).fill(0.8)))).toBe(8);
    expect(selectRerankCount(scores([NaN, ...Array(19).fill(0.2)]))).toBe(20);
  });
});
