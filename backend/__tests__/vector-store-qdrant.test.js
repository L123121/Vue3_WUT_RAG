import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * QdrantVectorStore 单元测试 — 独立服务版向量库
 * 覆盖 addChunks / search（dense+sparse 融合、过滤、空 embedding）/ deleteByDocId / count / resetCollection。
 * 通过 spyOn _createClient 注入 fake QdrantClient，不依赖真实服务。
 */

function makeFakeClient() {
  let pointCount = 0; // 模拟 Qdrant 服务端计数：upsert 增加、delete 减少
  return {
    collectionExists: vi.fn().mockResolvedValue({ exists: true }),
    createCollection: vi.fn().mockResolvedValue({}),
    createPayloadIndex: vi.fn().mockResolvedValue({}),
    updateCollection: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockImplementation((name, { points }) => {
      pointCount += points.length;
      return { status: 'completed' };
    }),
    query: vi.fn().mockResolvedValue({ points: [] }),
    count: vi.fn().mockImplementation(() => ({ count: pointCount })),
    delete: vi.fn().mockImplementation(() => {
      pointCount = 0; // 简化：删除后计数清零
      return { status: 'completed' };
    }),
    deleteCollection: vi.fn().mockResolvedValue({}),
  };
}

function getQdrantStore() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/knowledge/vector-store-qdrant.service')];
  return require('../src/services/knowledge/vector-store-qdrant.service').QdrantVectorStore;
}

/** 等待构造函数里的异步 _connect 完成 */
async function waitReady(store) {
  for (let i = 0; i < 50; i++) {
    if (store._ready) return;
    await new Promise(r => setTimeout(r, 1));
  }
  throw new Error('store not ready');
}

describe('QdrantVectorStore', () => {
  let QdrantVectorStore;
  let fakeClient;
  let store;

  beforeEach(async () => {
    vi.clearAllMocks();
    QdrantVectorStore = getQdrantStore();
    fakeClient = makeFakeClient();
    vi.spyOn(QdrantVectorStore.prototype, '_createClient').mockReturnValue(fakeClient);
    store = new QdrantVectorStore();
    await waitReady(store);
  });

  it('初始化时检查并复用已存在 collection', async () => {
    expect(fakeClient.collectionExists).toHaveBeenCalledWith('wuli_elf_chunks');
    expect(fakeClient.createCollection).not.toHaveBeenCalled();
    expect(store._ready).toBe(true);
  });

  it('collection 不存在时自动创建（dense 512d + sparse）', async () => {
    fakeClient.collectionExists.mockResolvedValue({ exists: false });
    const s = new QdrantVectorStore();
    await waitReady(s);
    expect(fakeClient.createCollection).toHaveBeenCalledTimes(1);
    const [name, schema] = fakeClient.createCollection.mock.calls[0];
    expect(name).toBe('wuli_elf_chunks');
    expect(schema.vectors.dense.size).toBe(512);
    expect(schema.vectors.dense.distance).toBe('Cosine');
    expect(schema.sparse_vectors.sparse).toBeDefined();
  });

  it('addChunks 将 dense + sparse 与 payload 写入 Qdrant', async () => {
    await store.addChunks(
      ['doc-a_sent_0', 'doc-a_sent_1'],
      [
        { dense: [1, 0, 0], sparse: { 100: 1, 200: 2 } },
        { dense: [0, 1, 0], sparse: { 300: 1 } },
      ],
      ['句子一', '句子二'],
      [
        { docId: 'doc-a', parentId: 'doc-a_para_0', parentIdx: 0, parentText: '段落一', title: '文档A', category: '教务', chunkIndex: 0 },
        { docId: 'doc-a', parentId: 'doc-a_para_1', parentIdx: 1, parentText: '段落二', title: '文档A', category: '教务', chunkIndex: 1 },
      ]
    );

    expect(fakeClient.upsert).toHaveBeenCalledTimes(1); // 2 条 < BATCH_SIZE=128
    const [, { points }] = fakeClient.upsert.mock.calls[0];
    expect(points).toHaveLength(2);
    // dense 向量 + sparse 向量（indices/values 排序）
    expect(points[0].vector.dense).toEqual([1, 0, 0]);
    expect(points[0].vector.sparse.indices).toEqual([100, 200]);
    expect(points[0].vector.sparse.values).toEqual([1, 2]);
    // payload 全量元数据
    expect(points[0].payload).toMatchObject({
      id: 'doc-a_sent_0',
      text: '句子一',
      docId: 'doc-a',
      parentId: 'doc-a_para_0',
      parentIdx: 0,
      parentText: '段落一',
      title: '文档A',
      category: '教务',
      chunkIndex: 0,
    });
    expect(await store.count()).toBe(2);
  });

  it('search 融合 dense+sparse：通道内归一化后 0.6·dense + 0.4·sparse', async () => {
    // dense 路返回 c1（0.9）+ c2（0.6）
    fakeClient.query
      .mockResolvedValueOnce({
        points: [
          { id: 111, score: 0.9, payload: { id: 'c1', docId: 'doc-a', parentId: 'doc-a_para_0', parentText: '段落', title: 'A', category: '教务', chunkIndex: 0, text: '内容' } },
          { id: 222, score: 0.6, payload: { id: 'c2', docId: 'doc-b', parentId: 'doc-b_para_0', parentText: '段落', title: 'B', category: '图书馆', chunkIndex: 0, text: '内容' } },
        ],
      })
      // sparse 路返回 c2（0.8）
      .mockResolvedValueOnce({
        points: [
          { id: 222, score: 0.8, payload: { id: 'c2', docId: 'doc-b', parentId: 'doc-b_para_0', parentText: '段落', title: 'B', category: '图书馆', chunkIndex: 0, text: '内容' } },
        ],
      });

    const result = await store.search({ dense: [1, 0, 0], sparse: { 100: 1 } }, 10);

    // 归一化：maxDense=0.9、maxSparse=0.8
    // c1: 0.6·(0.9/0.9) = 0.6；c2: 0.6·(0.6/0.9) + 0.4·(0.8/0.8) = 0.8 → c2 排第一
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('c2');
    expect(result[0]._vectorScore).toBeCloseTo(0.6);
    expect(result[0]._sparseScore).toBeCloseTo(0.8);
    expect(result[0].score).toBeCloseTo(0.8);
    expect(result[1].id).toBe('c1');
    expect(result[1].score).toBeCloseTo(0.6);
    expect(result[0]._retrievalChannels).toEqual(['vector', 'sparse']);
  });

  it('search 归一化使稀疏大分数量纲不再淹没稠密通道', async () => {
    // c1：dense 强命中（0.9）无 sparse；c2：稀疏 rare-token 大分（40）
    // 旧原始加权和下 c2 = 0.4·40 = 16 碾压 c1 = 0.54（稠密通道形同虚设）
    fakeClient.query
      .mockResolvedValueOnce({
        points: [
          { id: 111, score: 0.9, payload: { id: 'c1', docId: 'doc-a', parentId: 'doc-a_para_0', parentText: '材料清单正文', title: 'A', category: '教务', chunkIndex: 0, text: '成绩单、在读证明、中英文简历、个人陈述' } },
          { id: 222, score: 0.2, payload: { id: 'c2', docId: 'doc-b', parentId: 'doc-b_para_0', parentText: '标题', title: 'B', category: '教务', chunkIndex: 0, text: '推免保研准备与材料清单' } },
        ],
      })
      .mockResolvedValueOnce({
        points: [
          { id: 222, score: 40, payload: { id: 'c2', docId: 'doc-b', parentId: 'doc-b_para_0', parentText: '标题', title: 'B', category: '教务', chunkIndex: 0, text: '推免保研准备与材料清单' } },
        ],
      });

    const result = await store.search({ dense: [1, 0, 0], sparse: { 100: 1 } }, 10);

    // 归一化后：c1 = 0.6·(0.9/0.9) = 0.6 > c2 = 0.6·(0.2/0.9) + 0.4·1 = 0.533
    expect(result[0].id).toBe('c1');
    expect(result[0].score).toBeCloseTo(0.6);
    expect(result[1].score).toBeCloseTo(0.6 * (0.2 / 0.9) + 0.4, 3);
  });

  it('search 在 RAG_FUSION_NORM=false 时回退原始加权和', async () => {
    process.env.RAG_FUSION_NORM = 'false';
    QdrantVectorStore = getQdrantStore();
    vi.spyOn(QdrantVectorStore.prototype, '_createClient').mockReturnValue(fakeClient);
    const rawStore = new QdrantVectorStore();
    await waitReady(rawStore);
    delete process.env.RAG_FUSION_NORM;

    fakeClient.query
      .mockResolvedValueOnce({
        points: [
          { id: 111, score: 0.9, payload: { id: 'c1', docId: 'doc-a', parentId: 'doc-a_para_0', parentText: '段落', title: 'A', category: '教务', chunkIndex: 0, text: '内容' } },
        ],
      })
      .mockResolvedValueOnce({
        points: [
          { id: 222, score: 40, payload: { id: 'c2', docId: 'doc-b', parentId: 'doc-b_para_0', parentText: '段落', title: 'B', category: '教务', chunkIndex: 0, text: '内容' } },
        ],
      });

    const result = await rawStore.search({ dense: [1, 0, 0], sparse: { 100: 1 } }, 10);

    // 旧行为：c2 = 0.4·40 = 16 碾压 c1 = 0.6·0.9 = 0.54
    expect(result[0].id).toBe('c2');
    expect(result[0].score).toBeCloseTo(16);
    expect(result[1].score).toBeCloseTo(0.54);
  });

  it('search 支持 metadata 过滤（category）', async () => {
    await store.search({ dense: [1, 0, 0], sparse: {} }, 10, { category: '教务' });

    // sparse 为空 → 只发一次 dense 查询
    expect(fakeClient.query).toHaveBeenCalledTimes(1);
    const [, options] = fakeClient.query.mock.calls[0];
    expect(options.filter).toEqual({ must: [{ key: 'category', match: { value: '教务' } }] });
    expect(options.using).toBe('dense');
  });

  it('sparse 为空时不发 sparse 查询，仅走 dense', async () => {
    fakeClient.query.mockResolvedValueOnce({ points: [] });
    await store.search({ dense: [1, 0, 0], sparse: {} }, 10);
    expect(fakeClient.query).toHaveBeenCalledTimes(1);
    expect(fakeClient.query.mock.calls[0][1].using).toBe('dense');
  });

  it('search 空 embedding 返回空数组', async () => {
    expect(await store.search(null, 10)).toEqual([]);
    expect(await store.search([], 10)).toEqual([]);
    expect(fakeClient.query).not.toHaveBeenCalled();
  });

  it('search 自定义 weights 生效', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ points: [{ id: 111, score: 1.0, payload: { id: 'c1', docId: 'doc-a', parentId: 'p', parentText: 't', title: 'A', category: 'x', chunkIndex: 0, text: 'x' } }] })
      .mockResolvedValueOnce({ points: [] });
    const result = await store.search({ dense: [1, 0, 0], sparse: {} }, 10, null, { vector: 0.9, sparse: 0.1 });
    expect(result[0].score).toBeCloseTo(0.9);
  });

  it('deleteByDocId 通过 docId payload 过滤删除', async () => {
    await store.deleteByDocId('doc-a');
    expect(fakeClient.delete).toHaveBeenCalledWith('wuli_elf_chunks', {
      filter: { must: [{ key: 'docId', match: { value: 'doc-a' } }] },
    });
  });

  it('resetCollection 删除并重建 collection', async () => {
    await store.resetCollection();
    expect(fakeClient.deleteCollection).toHaveBeenCalledWith('wuli_elf_chunks');
    expect(store._pointCount).toBe(0);
    expect(store._ready).toBe(true);
  });

  it('count 反映 collection 点数', async () => {
    expect(await store.count()).toBe(0);
    await fakeClient.upsert('wuli_elf_chunks', { points: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] });
    expect(await store.count()).toBe(3);
  });

  // ==================== payload 索引 + 量化 ====================

  it('连接后为 docId/category 创建 payload 索引', async () => {
    const fields = fakeClient.createPayloadIndex.mock.calls.map(([_, opts]) => opts.field_name);
    expect(fields).toEqual(expect.arrayContaining(['docId', 'category']));
    expect(fakeClient.createPayloadIndex).toHaveBeenCalledTimes(2);
  });

  it('QDRANT_PAYLOAD_INDEX=false 时不创建 payload 索引', async () => {
    process.env.QDRANT_PAYLOAD_INDEX = 'false';
    try {
      const Cls = getQdrantStore();
      const client = makeFakeClient();
      vi.spyOn(Cls.prototype, '_createClient').mockReturnValue(client);
      const s = new Cls();
      await waitReady(s);
      expect(client.createPayloadIndex).not.toHaveBeenCalled();
    } finally {
      delete process.env.QDRANT_PAYLOAD_INDEX;
    }
  });

  it('新建 collection 时 QDRANT_QUANTIZATION=int8 写入量化配置', async () => {
    process.env.QDRANT_QUANTIZATION = 'int8';
    try {
      const Cls = getQdrantStore();
      const client = makeFakeClient();
      client.collectionExists.mockResolvedValue({ exists: false });
      vi.spyOn(Cls.prototype, '_createClient').mockReturnValue(client);
      const s = new Cls();
      await waitReady(s);
      const [name, schema] = client.createCollection.mock.calls[0];
      expect(name).toBe('wuli_elf_chunks');
      expect(schema.quantization_config).toEqual({
        scalar: { type: 'int8', quantile: 0.99, always_ram: true },
      });
      // 新建路径不需要 updateCollection
      expect(client.updateCollection).not.toHaveBeenCalled();
    } finally {
      delete process.env.QDRANT_QUANTIZATION;
    }
  });

  it('已存在的 collection 配置 int8 时走 updateCollection 补配', async () => {
    process.env.QDRANT_QUANTIZATION = 'int8';
    try {
      const Cls = getQdrantStore();
      const client = makeFakeClient(); // exists=true
      vi.spyOn(Cls.prototype, '_createClient').mockReturnValue(client);
      const s = new Cls();
      await waitReady(s);
      expect(client.createCollection).not.toHaveBeenCalled();
      expect(client.updateCollection).toHaveBeenCalledWith('wuli_elf_chunks', {
        quantization_config: { scalar: { type: 'int8', quantile: 0.99, always_ram: true } },
      });
    } finally {
      delete process.env.QDRANT_QUANTIZATION;
    }
  });

  it('连接失败降级放行(search 返回空),重连成功后恢复检索与就绪检查', async () => {
    // 阶段一:Qdrant 不可达——_ready 仍置 true 解除 _waitConnected 阻塞,
    // 但 _client 置空,search 按降级契约返回空而不是抛 ECONNREFUSED
    fakeClient.collectionExists.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const broken = new QdrantVectorStore();
    await waitReady(broken);

    expect(broken._connected).toBe(false);
    expect(broken._client).toBeNull();
    expect(await broken.isAvailable()).toBe(false);
    expect(await broken.search({ dense: [1, 0, 0], sparse: {} }, 10)).toEqual([]);
    expect(fakeClient.query).not.toHaveBeenCalled();

    // 阶段二:模拟后台重连定时器触发(回调即重跑 _connect)
    fakeClient.collectionExists.mockResolvedValue({ exists: true });
    await broken._connect();

    expect(broken._connected).toBe(true);
    expect(broken._reconnectTimer).toBeNull();
    expect(broken._readyChecked).toBe(false); // 已重置:下一次 ensureReady 重新走空库检查/重建
    expect(await broken.search({ dense: [1, 0, 0], sparse: {} }, 10)).toEqual([]); // 空库仍空,但已真正发起查询
    expect(fakeClient.query).toHaveBeenCalled();

    await broken.ensureReady();
    expect(broken._readyChecked).toBe(true);
  });
});
