import { describe, expect, it, vi } from 'vitest';

const { buildContextFromParents } = require('../src/services/rag/rag-context-builder.service');
const { tryWikiPipeline, mergeWikiAndRagPipelines } = require('../src/services/rag/rag-wiki-pipeline.service');
const { generateAnswer, streamAnswer } = require('../src/services/rag/rag-generation.service');
const { drainChat } = require('../src/services/rag/rag-chat-drain.service');
const { buildEvidenceReport, revisionOf } = require('../src/services/campus/evidence.service');
const { createStreamContext, writeStreamEvent } = require('../src/utils/sse-events');

const makeSvc = answer => ({
  isProcessQuestion: () => false,
  buildParentChildPrompt: (_question, context) => context,
  _groundingCheck: () => null,
  _recordTraceStage: vi.fn(),
  _buildNoReliableSourcesReply: () => '资料不足',
  aiService: {
    getCompletion: async () => ({ content: answer }),
    async *getCompletionStream() { yield { content: answer, done: false }; yield { content: '', done: true }; },
  },
});

async function makePipeline(text, maxContextLength = 6000) {
  const result = await buildContextFromParents([{ docId: 'doc_abc', parentText: text, parentIdx: 0, bestChunk: { score: 0.9 } }], {
    maxContextLength,
    getDocument: async () => ({ id: 'doc_abc', title: '办理说明', category: '演示', content: text }),
  });
  return { ...result, topChunks: [], questionType: 'process', rewrittenQuery: '怎么申请' };
}

function assertSnapshots(pipeline) {
  for (const source of pipeline.evidenceSources) {
    expect(pipeline.context.slice(source.start, source.start + source.text.length)).toBe(source.text);
  }
}

describe('生成时证据快照', () => {
  it('父段实际裁剪与引用版本一致，截掉的尾部不是生成依据', async () => {
    const text = `${'提交材料后按顺序办理。'.repeat(100)}\n火星环形山观测基地正式开放。`;
    const pipeline = await makePipeline(text, 650);
    expect(pipeline.context.length).toBeLessThanOrEqual(650);
    assertSnapshots(pipeline);
    expect(pipeline.sources[0].sourceRevision).toBe(revisionOf(text));
    expect(pipeline.sources[0].snippet).not.toContain('火星');
    const report = buildEvidenceReport({ answer: '火星环形山观测基地正式开放。', sources: pipeline.evidenceSources });
    expect(report.claims[0].status).toBe('unverified');
  });

  it('Wiki 与向量混合裁剪后偏移仍正确，未进入上下文的来源不产生引文', async () => {
    const svc = { wikiService: { searchPublished: async () => [
      { id: 'wiki1', title: '说明一', body: '办理材料需要准备齐全。'.repeat(70), currentRevision: 'v1' },
      { id: 'wiki2', title: '说明二', body: '不会进入最终上下文。', currentRevision: 'v2' },
    ] }, maxContextLength: 1000, classifyQuestion: () => 'process' };
    const wiki = await tryWikiPipeline(svc, '怎么办');
    const rag = await makePipeline('在服务大厅办理。'.repeat(90));
    const merged = mergeWikiAndRagPipelines(wiki, rag, 700);
    assertSnapshots(wiki);
    assertSnapshots(merged);
    expect(merged.context.length).toBeLessThanOrEqual(700);
    expect(merged.evidenceSources.some(source => source.docId === 'wiki2')).toBe(false);
    expect(merged.evidenceSources.some(source => source.docId === 'doc_abc')).toBe(true);
  });

  it('生成后不重新读取原文，非流式与流式证据口径一致', async () => {
    const text = '需要提交申请表2份。';
    const pipeline = await makePipeline(text);
    const svc = makeSvc(text);
    const tracer = { finish: vi.fn(), toSummary: () => ({ timings: [] }) };
    const direct = await generateAnswer(svc, { message: '材料', history: [], pipeline, tracer });
    const events = [];
    for await (const event of streamAnswer(svc, { message: '材料', history: [], options: {}, pipeline, tracer, totalStart: Date.now(), pipelineMeta: () => pipeline })) events.push(event);
    const report = events.find(event => event.type === 'evidence').evidence;
    expect(report.claims).toEqual(direct.evidence.claims);
    expect(report.evidence).toEqual(direct.evidence.evidence);
    expect(report.sources[0].revision).toBe(revisionOf(text));
    expect(report.contextRevision).toBe(revisionOf(pipeline.context));
    const drained = await drainChat({ async *chatStream() { yield* events; } }, '材料');
    expect(drained.evidence).toEqual(report);
    expect(drained.reply).toBe(text);
  });

  it('损坏或未经位置校验的摘要不当作快照引文', async () => {
    const pipeline = await makePipeline('参考资料中的有效正文。');
    pipeline.evidenceSources[0].text = '伪造的另一份摘要';
    const result = await generateAnswer(makeSvc('伪造的另一份摘要'), { message: '问', pipeline, tracer: {} });
    expect(result.evidence).toBeNull();
  });

  it('SSE 新旧协议都传递 evidence，未改变正文事件', () => {
    const evidence = { claims: [{ id: 'c1', text: '结论' }], evidence: [{ quote: '原文' }], sources: [] };
    const lines = [];
    const response = { write: value => lines.push(value) };
    writeStreamEvent(response, { type: 'evidence', evidence }, createStreamContext({ streamVersion: 1, runId: 'run_evidence_test' }));
    expect(JSON.parse(lines.pop().slice(6))).toMatchObject({ type: 'evidence', data: { evidence } });
    writeStreamEvent(response, { type: 'evidence', evidence }, 'trace1');
    expect(JSON.parse(lines.pop().slice(6))).toMatchObject({ evidence });
  });

  it('未闭合长数字引用不会触发正则回溯，空引用不算证据', () => {
    const source = { docId: 'd', text: '提交活动申请表。', revision: 'v' };
    const report = buildEvidenceReport({ answer: `办理材料[${'1'.repeat(1000)}`, sources: [source] });
    expect(report.claims).toHaveLength(1);
    const empty = buildEvidenceReport({ answer: '[1, 2, 3]', sources: [source] });
    expect(empty.evidence).toEqual([]);
  });

  it('长段末尾的原文匹配必须出现在返回的引用窗口里', () => {
    const claim = '办理时需要提交盖章的申请表。';
    const text = `${'说明文字'.repeat(450)}${claim}`;
    const report = buildEvidenceReport({ answer: claim, sources: [{ docId: 'd', text, revision: 'v' }] });
    const exact = report.evidence.find(item => item.match === 'exact');
    expect(exact.quote).toContain(claim);
    expect(text.slice(exact.start, exact.end)).toBe(exact.quote);
  });

  it('办事进度通过真实 SQLite 存储后可由新服务实例恢复', async () => {
    const { redis } = require('../src/services/memory/memory-store.service');
    const { CampusWorkbenchService } = require('../src/services/campus/campus-workbench.service');
    const { SourceRadarService, SOURCE_KEY, USER_KEY } = require('../src/services/campus/source-radar.service');
    const userId = `test_campus_user_${Date.now()}`;
    const docId = `test_campus_doc_${Date.now()}`;
    const body = '提交活动申请表。';
    const radar = new SourceRadarService({ store: redis, getEntry: async () => ({ id: docId, title: '测试资料', visible: true, body, currentRevision: revisionOf(body) }) });
    const service = new CampusWorkbenchService({ store: redis, radar });
    try {
      let result = await service.create(userId, { originMessageId: 'm', card: { summary: '测试事项', steps: [{ title: '提交', detail: body }] }, sources: [{ docId }] });
      result = await service.update(userId, result.task.id, { action: 'confirm', version: result.version });
      result = await service.update(userId, result.task.id, { action: 'step', stepId: 'step-0', status: 'completed', version: result.version });
      const restored = await new CampusWorkbenchService({ store: redis, radar }).detail(userId, result.task.id);
      expect(restored.task.status).toBe('completed');
      expect(restored.task.evidence.sources[0].revision).toBe(revisionOf(body));
    } finally {
      await redis.hdel(USER_KEY, userId);
      await redis.hdel(SOURCE_KEY, docId);
    }
  });

  it('SQLite 比较写入不会覆盖并发版本', async () => {
    const { redis } = require('../src/services/memory/memory-store.service');
    const key = `test:campus:cas:${Date.now()}`;
    try {
      expect(await redis.hcompareAndSet(key, 'user', null, { version: 1 })).toBe(true);
      expect(await redis.hcompareAndSet(key, 'user', null, { version: 2 })).toBe(false);
      expect(await redis.hcompareAndSet(key, 'user', { version: 0 }, { version: 2 })).toBe(false);
      expect(await redis.hcompareAndSet(key, 'user', { version: 1 }, { version: 2 })).toBe(true);
      expect(await redis.hget(key, 'user')).toEqual({ version: 2 });
    } finally { await redis.del(key); }
  });
});
