"use strict";

// ==================== Wiki 优先检索管道 ====================
// 从 rag.service.js 拆出：Wiki 导航短路检索与 Wiki/Qdrant 双管道合并。
// 函数经 svc 派发（与 rag-pipeline/rag-generation 模式一致），测试 mock 与运行时覆盖行为不变。

const { logEvent } = require('../observability/observability.service');
const { clipEvidenceSources } = require('../campus/evidence.service');

/**
 * Wiki 优先管道：已上架且未漂移的词条直接作为导航型来源，
 * 失败只告警并返回 null（上层回退 Qdrant 检索）。
 * @returns {Promise<Object|null>} 管道结果，无命中或关闭时为 null
 */
async function tryWikiPipeline(svc, message, options = {}) {
  if (options.wikiFirst === false || svc.wikiFirstEnabled === false) return null;
  try {
    const entries = await svc.wikiService.searchPublished(message, { limit: svc.wikiFirstMaxEntries });
    if (!entries.length) return null;
    const sources = entries.map((entry, index) => ({
      id: entry.id,
      docId: entry.id,
      title: entry.title,
      category: entry.category,
      slug: entry.slug,
      score: Math.max(0.5, 1 - index * 0.05),
      sourceType: 'wiki',
      sourceRevision: entry.currentRevision || entry.sourceRevision || null,
      snippet: entry.body.slice(0, 1500),
      stale: false,
    }));
    const context = entries.map((entry, index) => `【文档 ${index + 1}】${entry.title}（Wiki）\n${entry.body}`).join('\n\n').slice(0, options.maxContextLength || svc.maxContextLength);
    let position = 0;
    const evidenceSources = entries.map((entry, index) => {
      const start = position + `【文档 ${index + 1}】${entry.title}（Wiki）\n`.length;
      position = start + entry.body.length + 2;
      return {
        docId: entry.id, title: entry.title, revision: entry.currentRevision || entry.sourceRevision || null,
        start, text: entry.body.slice(0, Math.max(0, context.length - start)),
        sourceLabel: entry.sourceLabel, reviewedAt: entry.updatedAt,
        effectiveFrom: entry.effectiveFrom, effectiveUntil: entry.effectiveUntil, scope: entry.scope, simulated: entry.simulated,
      };
    }).filter(source => source.text);
    return {
      context,
      sources,
      evidenceSources,
      topChunks: entries.map((entry, index) => ({ id: entry.id, docId: entry.id, title: entry.title, text: entry.body.slice(0, 1200), score: sources[index].score })),
      retrieval: { mode: 'wiki_navigation', topK: entries.length, sourceType: 'wiki' },
      questionType: svc.classifyQuestion(message),
      rewrittenQuery: message,
      hasReliableCandidates: Boolean(context),
      sourceKind: 'wiki',
      fallbackReason: null,
    };
  } catch (error) {
    logEvent('warn', 'rag_wiki_first_failed_fallback_qdrant', { error: error.message });
    return null;
  }
}

/**
 * 合并 Wiki 与 Qdrant 两条管道的结果：
 * - 来源列表拼接（Wiki 在前），RAG 上下文中的【文档 N】序号整体后移避免冲突
 * - 上下文按 40/60 预算截断（Wiki 优先占 40%），分隔线长度计入预算
 * - sourceKind 标记为 hybrid，retrieval 记录双方命中数
 */
function mergeWikiAndRagPipelines(wikiPipeline, ragPipeline, maxContextLength) {
  if (!wikiPipeline) return ragPipeline;
  if (!ragPipeline) return wikiPipeline;

  const wikiSources = Array.isArray(wikiPipeline.sources) ? wikiPipeline.sources : [];
  const ragSources = Array.isArray(ragPipeline.sources) ? ragPipeline.sources : [];
  const offset = wikiSources.length;
  const wikiContext = String(wikiPipeline.context || '');
  const ragContext = String(ragPipeline.context || '').replace(/【文档\s+(\d+)】/g, (_, index) => (
    `【文档 ${Number(index) + offset}】`
  ));
  const separator = wikiContext && ragContext ? `\n\n${'='.repeat(40)}\n\n` : '';
  const wikiBudget = ragContext ? Math.floor(maxContextLength * 0.4) : maxContextLength;
  const ragBudget = ragContext ? Math.max(maxContextLength - wikiBudget - separator.length, 200) : 0;
  const context = `${wikiContext.slice(0, wikiBudget)}${separator}${ragContext.slice(0, ragBudget)}`.slice(0, maxContextLength);
  const ragStart = wikiContext.slice(0, wikiBudget).length + separator.length;
  const shiftedRagSources = (ragPipeline.evidenceSources || []).map(source => ({
    ...source,
    start: String(ragPipeline.context || '').slice(0, source.start).replace(/【文档\s+(\d+)】/g, (_, index) => `【文档 ${Number(index) + offset}】`).length,
  }));
  const evidenceSources = [
    ...clipEvidenceSources(wikiPipeline.evidenceSources, 0, Math.min(wikiBudget, context.length)),
    ...clipEvidenceSources(shiftedRagSources, 0, Math.min(ragBudget, context.length - ragStart), ragStart),
  ].filter(source => context.slice(source.start, source.start + source.text.length) === source.text);

  return {
    ...ragPipeline,
    context,
    evidenceSources,
    sources: [...wikiSources, ...ragSources],
    topChunks: [
      ...(Array.isArray(wikiPipeline.topChunks) ? wikiPipeline.topChunks : []),
      ...(Array.isArray(ragPipeline.topChunks) ? ragPipeline.topChunks : []),
    ],
    hasReliableCandidates: Boolean(wikiPipeline.hasReliableCandidates || ragPipeline.hasReliableCandidates),
    sourceKind: 'hybrid',
    retrieval: {
      ...(ragPipeline.retrieval || {}),
      mode: 'wiki_qdrant_hybrid',
      wikiCount: wikiSources.length,
      qdrantCount: ragSources.length,
    },
    fallbackReason: null,
  };
}

module.exports = { tryWikiPipeline, mergeWikiAndRagPipelines };
