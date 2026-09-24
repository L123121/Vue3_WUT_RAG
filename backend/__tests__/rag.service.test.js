import { describe, it, expect, vi, beforeEach } from 'vitest';

function getRagService() {
  delete require.cache[require.resolve('../src/services/rag.service')];
  return require('../src/services/rag.service').RagService;
}

describe('RagService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('融合向量召回和关键词召回，并保留召回通道信息', () => {
    const RagService = getRagService();
    const rag = new RagService({ getCompletion: vi.fn() });

    // doc-b 双通道命中（vector rank2 + keyword rank1），doc-a 仅 vector rank1
    const fused = rag.fuseRetrievalResults(
      [
        { id: 'doc-a_chunk_0', docId: 'doc-a', title: 'A', text: '语义相关', score: 0.6, chunkIndex: 0 },
        { id: 'doc-b_chunk_0', docId: 'doc-b', title: '学生证补办', text: '学生证补办流程', score: 0.9, chunkIndex: 0 },
      ],
      [{ id: 'doc-b_chunk_0', docId: 'doc-b', title: '学生证补办', text: '学生证补办流程', score: 1, _keywordScore: 1, chunkIndex: 0 }],
      5
    );

    // RRF：doc-b = 1/61(keyword) + 1/62(vector) > doc-a = 1/61(vector)
    expect(fused[0].docId).toBe('doc-b');
    expect(fused[0]._retrievalChannels).toEqual(['vector', 'keyword']);
    expect(fused.map(item => item.docId)).toEqual(['doc-b', 'doc-a']);
  });

  it('Wiki 与 Qdrant 候选合并为统一来源和文档编号', () => {
    const RagService = getRagService();
    const rag = new RagService({ getCompletion: vi.fn() });
    const merged = rag._mergeWikiAndRagPipelines({
      sourceKind: 'wiki',
      context: '【文档 1】校园百科（Wiki）\n办理说明',
      sources: [{ id: 'wiki-1', title: '校园百科' }],
      topChunks: [{ docId: 'wiki-1', text: '办理说明' }],
      hasReliableCandidates: true,
      retrieval: { mode: 'wiki_navigation' },
    }, {
      context: '【文档 1】课程手册（段落 1）\n课程说明',
      sources: [{ id: 'doc-1', title: '课程手册' }],
      topChunks: [{ docId: 'doc-1', text: '课程说明' }],
      hasReliableCandidates: true,
      retrieval: { mode: 'hybrid_vector_bm25_rrf' },
    });

    expect(merged.sourceKind).toBe('hybrid');
    expect(merged.sources.map((source) => source.id)).toEqual(['wiki-1', 'doc-1']);
    expect(merged.context).toContain('【文档 1】校园百科');
    expect(merged.context).toContain('【文档 2】课程手册');
    expect(merged.retrieval).toMatchObject({ mode: 'wiki_qdrant_hybrid', wikiCount: 1, qdrantCount: 1 });
  });

  it('同一切片被多路召回时会合并分数和通道', () => {
    const RagService = getRagService();
    const rag = new RagService({ getCompletion: vi.fn() });

    const fused = rag.fuseRetrievalResults(
      [{ id: 'doc-a_chunk_0', docId: 'doc-a', title: 'A', text: '内容', score: 0.8, chunkIndex: 0 }],
      [{ id: 'doc-a_chunk_0', docId: 'doc-a', title: 'A', text: '内容', score: 1, _keywordScore: 1, chunkIndex: 0 }],
      5
    );

    expect(fused).toHaveLength(1);
    expect(fused[0]._vectorScore).toBeCloseTo(0.8);
    expect(fused[0]._keywordScore).toBeCloseTo(1);
    expect(fused[0]._retrievalChannels).toEqual(['vector', 'keyword']);
  });

  it('按 docId 聚合子块并组装父文档上下文', async () => {
    const RagService = getRagService();
    const rag = new RagService({ getCompletion: vi.fn() });

    rag.documentService = {
      getDocument: vi.fn().mockImplementation(async docId => ({
        id: docId,
        title: docId === 'doc-a' ? '学生证补办流程' : '图书馆开放时间',
        category: '教务相关',
        content: `${docId} 的完整父文档内容`,
        chunkCount: 3,
        metadata: {}
      }))
    };

    // 使用 _buildContextFromParents (assembleParentContext 重构后已合并)
    const result = await rag._buildContextFromParents([
      { docId: 'doc-a', score: 0.9, parentIdx: 0, parentText: '学生证补办需要...', bestChunk: { score: 0.9, text: '学生证补办需要...' }, _rerankScore: 0.9, chunks: [{ chunkIndex: 2, _retrievalChannels: ['keyword'] }, { chunkIndex: 1, _retrievalChannels: ['vector'] }] },
      { docId: 'doc-b', score: 0.5, parentIdx: 0, parentText: '图书馆开放时间是...', bestChunk: { score: 0.5, text: '图书馆开放时间是...' }, _rerankScore: 0.5, chunks: [{ chunkIndex: 0, _retrievalChannels: ['vector'] }] }
    ]);

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.context).toContain('学生证补办流程');
    expect(result.context).toContain('图书馆开放时间');
  });

  it('无可靠候选时返回明确拒答，不调用大模型生成', async () => {
    const RagService = getRagService();
    const aiService = { getCompletion: vi.fn() };
    const rag = new RagService(aiService);

    rag.documentService = {
      hasDocuments: vi.fn().mockResolvedValue(true),
      listDocuments: vi.fn().mockResolvedValue({ documents: [{ id: 'doc-a' }] })
    };
    rag.retrieveCandidates = vi.fn().mockResolvedValue({
      candidates: [],
      trace: { mode: 'hybrid_vector_bm25_rrf', vector: { count: 0 }, keyword: { count: 0 }, fused: { count: 0, topScore: 0 } }
    });

    const result = await rag.localSearchChat('不存在的问题');

    expect(result.reply).toContain('没有检索到足够可靠的来源');
    expect(result.sources).toEqual([]);
    expect(aiService.getCompletion).not.toHaveBeenCalled();
  });

  describe('classifyQuestion', () => {
    it('教务政策类识别为 authoritative', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      expect(rag.classifyQuestion('转专业需要什么条件')).toBe('authoritative');
      expect(rag.classifyQuestion('补考和重修的学分怎么算')).toBe('authoritative');
      expect(rag.classifyQuestion('毕业设计成绩如何评定')).toBe('authoritative');
    });

    it('事实查询类识别为 factual', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      expect(rag.classifyQuestion('武汉理工大学有几个校区')).toBe('factual');
      expect(rag.classifyQuestion('图书馆在哪里')).toBe('factual');
      expect(rag.classifyQuestion('学校电话多少')).toBe('factual');
    });

    it('知识点解释类识别为 knowledge', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      expect(rag.classifyQuestion('什么是多态')).toBe('knowledge');
      expect(rag.classifyQuestion('解释一下二分查找算法')).toBe('knowledge');
      expect(rag.classifyQuestion('说说面向对象和面向过程的区别')).toBe('knowledge');
    });

    it('其他问题默认为 general', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      expect(rag.classifyQuestion('你好')).toBe('general');
      expect(rag.classifyQuestion('今天天气')).toBe('general');
      expect(rag.classifyQuestion('你会做什么')).toBe('general');
    });
  });

  describe('shouldRewriteQuery', () => {
    it('无历史时不需要改写', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      expect(rag.shouldRewriteQuery('它怎么配置', [])).toBe(false);
      expect(rag.shouldRewriteQuery('它怎么配置', null)).toBe(false);
    });

    it('含代词时需要改写', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      const history = [{ role: 'user', content: '语音输入怎么配置' }, { role: 'assistant', content: '在设置里打开' }];
      expect(rag.shouldRewriteQuery('它怎么配置', history)).toBe(true);
      expect(rag.shouldRewriteQuery('这个怎么用', history)).toBe(true);
      expect(rag.shouldRewriteQuery('那费用呢', history)).toBe(true);
    });

    it('短 query 需要改写', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      const history = [{ role: 'user', content: '补考怎么报名' }, { role: 'assistant', content: '在教务系统' }];
      expect(rag.shouldRewriteQuery('条件呢', history)).toBe(true);
      expect(rag.shouldRewriteQuery('费用呢', history)).toBe(true);
    });

    it('完整 query 不需要改写', () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      const history = [{ role: 'user', content: '补考怎么报名' }, { role: 'assistant', content: '在教务系统' }];
      expect(rag.shouldRewriteQuery('补考的条件是什么', history)).toBe(false);
      expect(rag.shouldRewriteQuery('转专业需要什么条件', history)).toBe(false);
    });
  });

  // —— chat() 统一 drain chatStream（非流式单管线驱动） ——
  describe('chat drain chatStream', () => {
    it('聚合回复、来源、管线信息与 trace', async () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      rag.chatStream = async function* (_message, _history, options) {
        expect(options.includePipeline).toBe(true);
        yield { type: 'sources', sources: [{ id: 's1', title: '文档A' }] };
        yield { type: 'content', content: '你好', done: false };
        yield { type: 'process', processCard: { steps: [] } };
        yield { type: 'grounding', grounding: { coverage: 1, level: 'high' } };
        yield { type: 'followups', items: ['追问1'] };
        yield { type: 'usage', usage: { totalTokens: 42 } };
        yield { type: 'trace', trace: { traceId: 't-1', timings: [{ name: 'llm', durationMs: 123, success: true }] } };
        yield {
          type: 'content', content: '', done: true,
          pipeline: {
            context: '上下文', topChunks: [{ id: 'c1' }], questionType: 'factual',
            rewrittenQuery: '改写后的问题', retrieval: { channels: ['vector'], hasResults: true },
            fallbackReason: null,
          },
        };
      };

      const result = await rag.chat('问题', []);

      expect(result.reply).toBe('你好');
      expect(result.sources).toEqual([{ id: 's1', title: '文档A' }]);
      expect(result.context).toBe('上下文');
      expect(result.topChunks).toEqual([{ id: 'c1' }]);
      expect(result.traceId).toBe('t-1');
      expect(result.questionType).toBe('factual');
      expect(result.processCard).toEqual({ steps: [] });
      expect(result.grounding).toEqual({ coverage: 1, level: 'high' });
      expect(result.followups).toEqual(['追问1']);
      expect(result.usage).toEqual({ totalTokens: 42 });
      expect(result._metrics.aiLatency).toBe(123);
    });

    it('知识库为空（no_documents）时保持 reply=null 契约', async () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn() });
      rag.chatStream = async function* () {
        yield { type: 'trace', trace: { traceId: 't-2', timings: [] } };
        yield {
          type: 'content', content: '', done: true,
          pipeline: {
            context: '', topChunks: [], questionType: 'general', rewrittenQuery: '',
            retrieval: { channels: [], hasResults: false }, fallbackReason: 'no_documents',
          },
        };
      };

      const result = await rag.chat('问题', []);
      expect(result.reply).toBeNull();
      expect(result.context).toBe('');
    });

    it('检索管线崩溃时降级纯 LLM', async () => {
      const RagService = getRagService();
      const aiService = { getCompletion: vi.fn().mockResolvedValue({ content: '纯 LLM 回答', isMock: false, usage: null }) };
      const rag = new RagService(aiService);
      rag.chatStream = async function* () {
        throw new Error('向量库不可用');
      };

      const result = await rag.chat('问题', []);

      expect(result.reply).toBe('纯 LLM 回答');
      expect(aiService.getCompletion).toHaveBeenCalledOnce();
      expect(result.sources).toEqual([]);
      expect(result.trace.outcome.usedRag).toBe(false);
    });

    it('降级纯 LLM 也失败时上抛错误', async () => {
      const RagService = getRagService();
      const rag = new RagService({ getCompletion: vi.fn().mockRejectedValue(new Error('LLM 也不可用')) });
      rag.chatStream = async function* () {
        throw new Error('向量库不可用');
      };

      await expect(rag.chat('问题', [])).rejects.toThrow('LLM 也不可用');
    });
  });
});
