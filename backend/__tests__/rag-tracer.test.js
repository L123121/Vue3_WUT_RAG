import { describe, it, expect } from 'vitest';

const { RagTracer } = require('../src/services/rag/rag-tracer.service');

describe('RagTracer', () => {
  const userId = 'rag_tracer_test_' + Math.random().toString(36).slice(2);

  it('记录阶段耗时、状态和前端摘要', () => {
    const tracer = new RagTracer({ userId, traceId: 'trace-test-1', message: '查询校训' });

    tracer.recordStage('embedding', 120, true, { model: 'bge-small-zh' });
    tracer.recordStage('milvus_search', 45, false, { topK: 50 }, new Error('milvus timeout'));
    tracer.setRetrieval({ vector: { count: 0, latency: 45 }, fused: { count: 0 } });
    tracer.markError(new Error('request failed'));

    const summary = tracer.toSummary();
    expect(summary.traceId).toBe('trace-test-1');
    expect(summary.timings).toHaveLength(2);
    expect(summary.failedStageCount).toBe(1);
    expect(summary.failedStages[0].name).toBe('milvus_search');
    expect(summary.userId).toBeUndefined();
    expect(summary.message).toBeUndefined();
  });

  it('finish 返回完整 trace 并记录 outcome', () => {
    const tracer = new RagTracer({ userId, traceId: 'trace-test-2', message: '查询校区' });
    tracer.recordStage('embedding', 10, true);
    const trace = tracer.finish({ usedRag: true, matchedDocs: 1 });

    expect(trace.traceId).toBe('trace-test-2');
    expect(trace.outcome.usedRag).toBe(true);
    expect(trace.totalMs).toBeGreaterThanOrEqual(0);
  });
});
