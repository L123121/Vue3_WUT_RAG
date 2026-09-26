"use strict";

// ==================== 非流式 RAG 问答（chat 汇聚层） ====================
// 从 rag.service.js 拆出：统一 drain chatStream()（单一管线驱动，消除两套循环的
// drift 风险，与 agent.service.chat 的收口方式一致），检索管线崩溃时降级纯 LLM。
// 返回形状与历史实现保持对齐。

const config = require('../../config');
const { metrics } = require('../observability/metrics.service');
const { logEvent } = require('../observability/observability.service');

/**
 * drain 流式事件为非流式结果。
 * 返回形状与原实现对齐：context/topChunks/questionType/rewrittenQuery/retrieval 随
 * chatStream 的 done 事件回传（includePipeline 仅此处使用，公开流式端点不受影响）。
 */
async function drainChat(svc, message, history = [], options = {}) {
  const totalStart = Date.now();
  let reply = '';
  let sources = [];
  let usage = null;
  let processCard = null;
  let grounding = null;
  let followups = [];
  let trace = null;
  let pipelineMeta = null;

  try {
    for await (const event of svc.chatStream(message, history, { ...options, includePipeline: true })) {
      if (event.type === 'content') {
        if (event.done) pipelineMeta = event.pipeline || pipelineMeta;
        else reply += event.content || '';
      } else if (event.type === 'sources') {
        sources = event.sources || [];
      } else if (event.type === 'usage') {
        usage = event.usage || null;
      } else if (event.type === 'process') {
        processCard = event.processCard || null;
      } else if (event.type === 'grounding') {
        grounding = event.grounding || null;
      } else if (event.type === 'followups') {
        followups = event.items || [];
      } else if (event.type === 'trace') {
        trace = event.trace || trace;
      }
    }
  } catch (err) {
    if (err.code === 'INCOMPLETE_STREAM') throw err;
    const tracer = svc._createTracer(message, options);
    tracer.markFallback('rag_pipeline_error');
    svc._recordTraceStage(tracer, 'rag_pipeline', Date.now(), false, {}, err);
    logEvent('warn', 'rag_pipeline_fallback', { error: err.message });

    const aiStart = Date.now();
    try {
      const result = await svc.aiService.getCompletion(message, history, options);
      const aiLatency = Date.now() - aiStart;
      metrics.recordLatency('ai', aiLatency);
      svc._recordTraceStage(tracer, 'llm', aiStart, true, {
        model: config.ai.model || 'step-3.7-flash',
        isMock: !!result.isMock,
        outputChars: (result.content || '').length,
        usage: result.usage || null,
      });
      metrics.recordLatency('total', Date.now() - totalStart);
      metrics.recordRagQuery({ usedRag: false, usedParentChild: false });
      svc._recordTraceStage(tracer, 'total', totalStart, true, { usedRag: false });

      return svc._finishTrace(tracer, {
        reply: result.content,
        isMock: result.isMock,
        sources: [],
        context: '',
        model: config.ai.model || 'step-3.7-flash',
        usage: result.usage || null,
      }, { usedRag: false, usedParentChild: false });
    } catch (llmErr) {
      svc._recordTraceStage(tracer, 'llm', aiStart, false, { model: config.ai.model || 'step-3.7-flash' }, llmErr);
      svc._recordTraceStage(tracer, 'total', totalStart, false, { usedRag: false }, llmErr);
      tracer.markError(llmErr);
      tracer.finish({ usedRag: false, usedParentChild: false });
      throw llmErr;
    }
  }

  const context = pipelineMeta?.context || '';
  const topChunks = Array.isArray(pipelineMeta?.topChunks) ? pipelineMeta.topChunks : [];
  const fallbackReason = pipelineMeta?.fallbackReason || null;
  const questionType = pipelineMeta?.questionType ?? null;
  const rewrittenQuery = pipelineMeta?.rewrittenQuery ?? null;
  const retrieval = pipelineMeta?.retrieval ?? null;
  const totalLatency = Date.now() - totalStart;
  const aiLatency = trace?.timings?.find((stage) => stage.name === 'llm')?.durationMs ?? 0;

  return {
    // 知识库为空时保持旧契约（reply=null）；其余路径 drain 到的即最终回复
    reply: fallbackReason === 'no_documents' ? null : reply,
    isMock: false,
    sources,
    context,
    topChunks,
    model: config.ai.model || 'step-3.7-flash',
    usage,
    questionType,
    rewrittenQuery,
    retrieval,
    grounding: grounding || null,
    processCard: processCard || null,
    followups,
    traceId: trace?.traceId || null,
    trace: trace || null,
    _metrics: {
      totalLatency,
      aiLatency,
      matchedDocs: sources.length,
      retrievedChunks: topChunks.length,
      questionType,
      rewrittenQuery,
      retrieval,
    },
  };
}

module.exports = { drainChat };
