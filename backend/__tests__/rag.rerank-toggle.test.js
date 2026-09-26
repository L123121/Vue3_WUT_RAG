import { describe, it, expect, vi, afterEach } from 'vitest';

// RAG_RERANK_ENABLED 开关：小内存机器（2C2G）可关闭 cross-encoder 精排，
// 省 ~300MB 内存与单次 ~2s 推理延迟；融合归一化后排序不依赖 reranker。
// 注意：需在 require config 前设置 env（config 模块加载时读取）。

process.env.VECTOR_STORE_BACKEND = 'file';

function loadRagServiceWithEnv(rerankEnv) {
  if (rerankEnv === undefined) delete process.env.RAG_RERANK_ENABLED;
  else process.env.RAG_RERANK_ENABLED = rerankEnv;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/rag/rag.service')];
  const { RagService } = require('../src/services/rag/rag.service');
  return new RagService({ getCompletion: vi.fn() });
}

describe('RAG_RERANK_ENABLED 精排开关', () => {
  afterEach(() => {
    delete process.env.RAG_RERANK_ENABLED;
    vi.restoreAllMocks();
  });

  it('默认开启（未设置 env 时 rerankEnabled=true）', () => {
    const rag = loadRagServiceWithEnv(undefined);
    expect(rag.rerankEnabled).toBe(true);
  });

  it('RAG_RERANK_ENABLED=false 关闭精排', () => {
    const rag = loadRagServiceWithEnv('false');
    expect(rag.rerankEnabled).toBe(false);
  });
});
