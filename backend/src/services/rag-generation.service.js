"use strict";

const config = require('../config');
const { metrics } = require('./metrics.service');
const { logEvent } = require('./observability.service');
const { buildFollowups } = require('./rag-followups.service');

/**
 * RAG 生成层：prompt 组装、非流式/流式 LLM 生成、失败降级与收尾旁路
 * （process 步骤卡片 / grounding 引用校验 / usage / 追问建议）。
 * 从 rag.service 拆出；函数第一个参数为 RagService 实例（svc），
 * 内部仍通过 svc 派发（如 svc.isProcessQuestion），保证测试 mock 与运行时覆盖行为不变。
 */

/**
 * 按问题类型组装 prompt：流程类问题走结构化 JSON 步骤卡片 prompt
 *
 * @returns {{ prompt: string, isProcess: boolean }}
 */
function buildPrompt(svc, message, context) {
  const isProcess = svc.isProcessQuestion(message);
  const prompt = isProcess
    ? svc.buildProcessPrompt(message, context)
    : svc.buildParentChildPrompt(message, context);
  return { prompt, isProcess };
}

/**
 * 非流式生成（localSearchChat 路径）：生成失败不降级纯 LLM，
 * 以拒答文案收尾（RAG 内部自带降级语义）；grounding 校验同在此处旁路完成。
 *
 * @returns {Promise<{ reply: string, aiLatency: number, llmUsage: Object|null,
 *   llmModel: string, processCard: Object|null, grounding: Object|null }>}
 */
async function generateAnswer(svc, { message, history, pipeline, tracer }) {
  let reply = '';
  let aiLatency = 0;
  let llmUsage = null;
  let llmModel = config.ai.model || 'step-3.7-flash';
  let processCard = null;
  if (pipeline.context) {
    const aiStart = Date.now();
    try {
      const { prompt, isProcess } = buildPrompt(svc, message, pipeline.context);
      const llmResult = await svc.aiService.getCompletion(prompt, history);
      aiLatency = Date.now() - aiStart;
      svc._recordTraceStage(tracer, 'llm', aiStart, true, {
        model: config.ai.model || 'step-3.7-flash',
        isMock: !!llmResult.isMock,
        outputChars: (llmResult.content || '').length,
        usage: llmResult.usage || null,
      });
      reply = llmResult.content;
      llmUsage = llmResult.usage || null;
      llmModel = llmResult.model || llmModel;
      if (isProcess) processCard = svc.parseProcessCard(reply);
    } catch (err) {
      aiLatency = svc._recordTraceStage(tracer, 'llm', aiStart, false, { model: config.ai.model || 'step-3.7-flash' }, err);
      logEvent('warn', 'rag_generation_failed', { error: err.message });
      reply = svc._buildNoReliableSourcesReply();
    }
  } else {
    reply = svc._buildNoReliableSourcesReply();
  }

  // 运行时引用校验：生成完成后对照上下文逐句检查（旁路，不阻断）
  const groundingStart = Date.now();
  const grounding = svc._groundingCheck(reply, pipeline.context);
  if (grounding) {
    svc._recordTraceStage(tracer, 'grounding', groundingStart, true, {
      coverage: grounding.coverage,
      level: grounding.level,
      unsupportedCount: grounding.unsupportedCount,
    });
  }

  return { reply, aiLatency, llmUsage, llmModel, processCard, grounding };
}

/**
 * 流式生成（chatStream 路径，通过 yield* 委托，事件契约与拆分前一致）：
 * RAG 上下文流式生成 → 中途失败守卫（已输出内容时礼貌收尾，避免
 * "半截 RAG 回答 + 完整纯 LLM 回答"拼接重发）→ 无内容时降级纯 LLM 重流。
 */
async function* streamAnswer(svc, { message, history, options, pipeline, tracer, totalStart, pipelineMeta }) {
  // 流式生成
  const aiStart = Date.now();
  const { prompt: enhancedPrompt, isProcess } = buildPrompt(svc, message, pipeline.context);
  let outputChars = 0;
  let fullReply = '';

  try {
    for await (const chunk of svc.aiService.getCompletionStream(enhancedPrompt, history, { signal: options.signal })) {
      if (chunk.done) {
        metrics.recordLatency('ai', Date.now() - aiStart);
        svc._recordTraceStage(tracer, 'llm', aiStart, true, {
          model: config.ai.model || 'step-3.7-flash',
          stream: true,
          outputChars,
          usage: chunk.usage || null,
        });

        // token 用量随收尾下发（前端逐条消息展示成本）
        if (chunk.usage) {
          yield { type: 'usage', usage: chunk.usage };
        }

        // 流程类问题：解析步骤卡片并下发给前端
        let processCard = null;
        if (isProcess) processCard = svc.parseProcessCard(fullReply);
        if (processCard) {
          yield { type: 'process', processCard };
        }

        // 运行时引用校验：流式收尾时对照上下文逐句检查（旁路，不阻断）
        const groundingStart = Date.now();
        const grounding = svc._groundingCheck(fullReply, pipeline.context);
        if (grounding) {
          svc._recordTraceStage(tracer, 'grounding', groundingStart, true, {
            coverage: grounding.coverage,
            level: grounding.level,
            unsupportedCount: grounding.unsupportedCount,
          });
          yield { type: 'grounding', grounding };
        }

        metrics.recordLatency('total', Date.now() - totalStart);
        svc._recordTraceStage(tracer, 'total', totalStart, true, {
          usedRag: true,
          matchedDocs: pipeline.sources.length,
          retrievedChunks: pipeline.topChunks.length,
        });

        // 追问建议：从引用文档/章节标题零成本生成（无模型调用）
        const followups = buildFollowups({
          sources: pipeline.sources,
          chunks: pipeline.topChunks,
          question: message,
        });
        if (followups.length > 0) {
          yield { type: 'followups', items: followups };
        }
        tracer.finish({
          usedRag: true,
          usedParentChild: true,
          matchedDocs: pipeline.sources.length,
          retrievedChunks: pipeline.topChunks.length,
          questionType: pipeline.questionType,
          rewrittenQuery: pipeline.rewrittenQuery,
        });
        yield { type: 'trace', trace: tracer.toSummary() };
        yield { type: 'content', content: '', done: true, pipeline: pipelineMeta() };
        return;
      }
      outputChars += (chunk.content || '').length;
      fullReply += chunk.content || '';
      yield { type: 'content', content: chunk.content, done: false };
    }
  } catch (err) {
    tracer?.markFallback('rag_pipeline_error');
    svc._recordTraceStage(tracer, 'llm', aiStart, false, { model: config.ai.model || 'step-3.7-flash' }, err);
    logEvent('warn', 'rag_stream_fallback', { error: err.message });
    if (fullReply) {
      // 已输出部分内容：降级重发会让用户看到 "半截 RAG 回答 + 完整纯 LLM 回答" 拼接。
      // 保持已有内容礼貌收尾（同 agent 收尾失败的处理模式）
      metrics.recordLatency('total', Date.now() - totalStart);
      svc._recordTraceStage(tracer, 'total', totalStart, true, {
        usedRag: true,
        matchedDocs: pipeline.sources.length,
        retrievedChunks: pipeline.topChunks.length,
      });
      tracer?.finish({
        usedRag: true,
        usedParentChild: true,
        matchedDocs: pipeline.sources.length,
        retrievedChunks: pipeline.topChunks.length,
        fallbackReason: 'rag_pipeline_error',
      });
      yield { type: 'trace', trace: tracer.toSummary() };
      yield { type: 'content', content: '', done: true, pipeline: pipelineMeta() };
      return;
    }
  }

  // 流式生成失败时降级:纯 LLM 无 RAG 上下文
  const aiStart2 = Date.now();
  let fallbackOutputChars = 0;
  try {
    for await (const chunk of svc.aiService.getCompletionStream(message, history, { signal: options.signal })) {
      if (chunk.done) {
        metrics.recordLatency('ai', Date.now() - aiStart2);
        svc._recordTraceStage(tracer, 'llm', aiStart2, true, {
          model: config.ai.model || 'step-3.7-flash',
          stream: true,
          outputChars: fallbackOutputChars,
          usage: chunk.usage || null,
        });
        if (chunk.usage) {
          yield { type: 'usage', usage: chunk.usage };
        }
        metrics.recordLatency('total', Date.now() - totalStart);
        metrics.recordRagQuery({ usedRag: false, usedParentChild: false });
        svc._recordTraceStage(tracer, 'total', totalStart, true, { usedRag: false });
        tracer.finish({ usedRag: false, usedParentChild: false });
        yield { type: 'trace', trace: tracer.toSummary() };
        yield { type: 'content', content: '', done: true, pipeline: pipelineMeta() };
        return;
      }
      fallbackOutputChars += (chunk.content || '').length;
      yield { type: 'content', content: chunk.content, done: false };
    }
  } catch (err) {
    svc._recordTraceStage(tracer, 'llm', aiStart2, false, { model: config.ai.model || 'step-3.7-flash', stream: true }, err);
    svc._recordTraceStage(tracer, 'total', totalStart, false, { usedRag: false }, err);
    tracer.markError(err);
    tracer.finish({ usedRag: false, usedParentChild: false });
    throw err;
  }
}

module.exports = { buildPrompt, generateAnswer, streamAnswer };
