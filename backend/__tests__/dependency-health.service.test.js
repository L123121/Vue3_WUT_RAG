import { describe, expect, it } from 'vitest';

const { getDependencyHealth } = require('../src/services/observability/dependency-health.service');

describe('dependency-health.service', () => {
  it('核心依赖正常时返回 ready', () => {
    const health = getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'ready' },
      embedding: { status: 'ready' },
      reranker: { status: 'ready' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
    });
    expect(health).toMatchObject({ status: 'ready', ready: true });
  });

  it('Qdrant 启动中或不可用时不报告 ready', () => {
    expect(getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'starting' },
      embedding: { status: 'ready' },
      reranker: { status: 'standby' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
    })).toMatchObject({ status: 'starting', ready: false });

    expect(getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'unavailable' },
      embedding: { status: 'ready' },
      reranker: { status: 'standby' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
    })).toMatchObject({ status: 'unavailable', ready: false });
  });
});
