import { describe, expect, it, vi } from 'vitest';

const { getDependencyHealth, normalizeEmbeddingHealth } = require('../src/services/observability/dependency-health.service');

describe('dependency-health.service', () => {
  it('embedding 模型加载中报 starting，加载失败默认让就绪探针失败', () => {
    expect(normalizeEmbeddingHealth({ status: 'ok', modelState: 'idle' }).status).toBe('ready');
    expect(normalizeEmbeddingHealth({ status: 'ok', modelState: 'loading' }).status).toBe('starting');
    expect(normalizeEmbeddingHealth({ status: 'degraded', modelState: 'failed' }).status).toBe('unavailable');

    vi.stubEnv('READINESS_REQUIRE_EMBEDDING_MODEL', 'false');
    try {
      expect(normalizeEmbeddingHealth({ status: 'degraded', modelState: 'failed' }).status).toBe('degraded');
    } finally {
      vi.unstubAllEnvs();
    }

    const health = getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'ready' },
      embedding: normalizeEmbeddingHealth({ status: 'degraded', modelState: 'failed' }),
      reranker: { status: 'ready' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
      redis: { status: 'disabled', enabled: false },
      storage: { status: 'ready', backend: 'local' },
    });
    expect(health).toMatchObject({ status: 'unavailable', ready: false });
  });

  it('核心依赖正常时返回 ready', () => {
    const health = getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'ready' },
      embedding: { status: 'ready' },
      reranker: { status: 'ready' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
      redis: { status: 'disabled', enabled: false },
      storage: { status: 'ready', backend: 'local' },
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
      redis: { status: 'ready', enabled: true },
      storage: { status: 'ready', backend: 'local' },
    })).toMatchObject({ status: 'starting', ready: false });

    expect(getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'unavailable' },
      embedding: { status: 'ready' },
      reranker: { status: 'standby' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
      redis: { status: 'ready', enabled: true },
      storage: { status: 'ready', backend: 'local' },
    })).toMatchObject({ status: 'unavailable', ready: false });
  });

  it('Redis 已配置但不可用时报告降级而非阻断单机核心依赖', () => {
    expect(getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'ready' },
      embedding: { status: 'ready' },
      reranker: { status: 'ready' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
      redis: { status: 'unavailable', enabled: true },
      storage: { status: 'ready', backend: 'local' },
    })).toMatchObject({ status: 'degraded', ready: true });
  });

  it('对象存储不可用时不报告 ready', () => {
    expect(getDependencyHealth({
      sqlite: { status: 'ready' },
      qdrant: { status: 'ready' },
      embedding: { status: 'ready' },
      reranker: { status: 'ready' },
      uploads: { status: 'ready' },
      llm: { status: 'ready' },
      redis: { status: 'disabled', enabled: false },
      storage: { status: 'unavailable', backend: 's3' },
    })).toMatchObject({ status: 'unavailable', ready: false });
  });
});
