import { describe, expect, it } from 'vitest';

const { MetricsService } = require('../src/services/observability/metrics.service');

describe('metrics.service dashboard summary', () => {
  it('聚合引用覆盖率与最近一次 RAG 评测结果', () => {
    const metrics = new MetricsService();

    metrics.recordRagQuery({ usedRag: true, usedParentChild: true, matchedDocs: 3, retrievedChunks: 8, hasSources: true });
    metrics.recordRagQuery({ usedRag: true, usedParentChild: true, matchedDocs: 2, retrievedChunks: 5, hasSources: false });
    metrics.recordLatency('total', 800);
    metrics.recordEvaluation({
      metrics: {
        faithfulness: 0.92,
        answer_relevancy: 0.88,
        context_precision: 0.84,
        context_recall: 0.9,
        overall: 0.885,
      },
      avgLatency: 760,
      sampleCount: 5,
      evaluatedAt: '2026-08-21T00:00:00.000Z',
    });

    const summary = metrics.getSummary();

    expect(summary.rag).toMatchObject({
      totalQueries: 2,
      ragQueries: 2,
      parentChildQueries: 2,
      sourceCoverage: '50.0%',
      avgMatchedDocs: '2.5',
    });
    expect(summary.latency.total.avg).toBe(800);
    expect(summary.evaluation).toEqual(expect.objectContaining({
      context_recall: 0.9,
      overall: 0.885,
      avgLatency: 760,
      sampleCount: 5,
    }));
  });
});