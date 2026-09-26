"use strict";

const { AiService } = require("../llm/ai.service");
const { RagService } = require("../rag/rag.service");
const config = require("../../config");
const { logEvent } = require('../observability/observability.service');

const REWRITE_PROMPT = `你是校园知识库检索查询改写器。

任务：根据原问题和上一轮检索摘要，生成一个更适合知识库检索的新查询。

规则：
1. 保留原问题中的学校、课程、政策、时间、地点等关键实体
2. 补充可能出现在正式文档中的同义词，但不要编造事实
3. 新查询必须与上一轮不同，长度不超过 200 个字符
4. 只返回 JSON：{"query":"改写后的查询","reason":"简短原因"}

原问题：{question}
上一轮查询：{query}
检索摘要：{summary}`;

function mergeSources(target, incoming) {
  const seen = new Set(target.map((source) => source.docId || source.title || JSON.stringify(source)));
  for (const source of incoming || []) {
    const key = source.docId || source.title || JSON.stringify(source);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(source);
  }
  return target;
}

function parseRewrite(content, previousQuery) {
  const match = String(content || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const query = String(parsed.query || "").trim().slice(0, 200);
    if (!query || query === String(previousQuery || "").trim()) return null;
    return { query, reason: String(parsed.reason || "证据不足，扩大检索表达").slice(0, 200) };
  } catch {
    return null;
  }
}

class AgenticRagService {
  constructor(dependencies = {}) {
    this.aiService = dependencies.aiService || new AiService();
    this.ragService = dependencies.ragService || new RagService(this.aiService);
    this.agenticEnabled = dependencies.enabled ?? config.agenticRag?.enabled === true;
    this.maxRounds = Math.min(Math.max(dependencies.maxRounds || config.agenticRag?.maxRounds || 2, 1), 3);
    this.maxDurationMs = dependencies.maxDurationMs || config.agenticRag?.maxDurationMs || 20000;
    this.rewriteTimeoutMs = dependencies.rewriteTimeoutMs || config.agenticRag?.rewriteTimeoutMs || 8000;
    this.minSources = Math.max(dependencies.minSources || config.agenticRag?.minSources || 1, 1);
  }

  get enabled() {
    return this.agenticEnabled;
  }

  _hasEnoughEvidence(result) {
    return Boolean(
      result?.context
      && Array.isArray(result.sources)
      && result.sources.length >= this.minSources
    );
  }

  _retrievalSummary(result) {
    const sources = Array.isArray(result?.sources) ? result.sources : [];
    const titles = sources.map((source) => source.title).filter(Boolean).slice(0, 5);
    const contextPreview = String(result?.context || "").replace(/\s+/g, " ").slice(0, 600);
    return `来源数量=${sources.length}；标题=${titles.join("、") || "无"}；上下文=${contextPreview || "无"}`;
  }

  async _rewriteQuery(question, previousQuery, result, options = {}) {
    const prompt = REWRITE_PROMPT
      .replace("{question}", String(question || ""))
      .replace("{query}", String(previousQuery || ""))
      .replace("{summary}", this._retrievalSummary(result));
    const response = await this.aiService.getCompletion(prompt, [], {
      signal: options.signal,
      timeout: this.rewriteTimeoutMs,
      retries: 0,
    });
    return parseRewrite(response?.content, previousQuery);
  }

  _createTrace(message, options) {
    return {
      traceId: options.traceId || `agentic_rag_${Date.now().toString(36)}`,
      message,
      rounds: 0,
      queries: [],
      toolCalls: [],
      matchedDocs: 0,
      totalMs: 0,
      finishReason: "no_evidence",
      fallbackReason: null,
    };
  }

  async *chatStream(message, history = [], options = {}) {
    const startedAt = Date.now();
    const trace = this._createTrace(message, options);
    const collectedSources = [];
    let query = String(message || "");
    let evidence = null;
    let lastResult = null;

    try {
      for (let round = 1; round <= this.maxRounds; round++) {
        if (Date.now() - startedAt >= this.maxDurationMs) {
          trace.finishReason = "time_budget";
          break;
        }

        trace.rounds = round;
        trace.queries.push(query);
        yield {
          type: "tool_call",
          tool_call: { name: "search_knowledge_base", arguments: { query }, round },
        };

        const retrievalStartedAt = Date.now();
        lastResult = await this.ragService.localSearchChat(query, history, {
          retrieveOnly: true,
          category: options.category,
          traceId: trace.traceId,
          userId: options.userId,
          conversationId: options.conversationId,
          signal: options.signal,
        });
        const roundSources = Array.isArray(lastResult?.sources) ? lastResult.sources : [];
        mergeSources(collectedSources, roundSources);
        const enoughEvidence = this._hasEnoughEvidence(lastResult);
        const retrievalDurationMs = Date.now() - retrievalStartedAt;

        trace.toolCalls.push({
          name: "search_knowledge_base",
          args: { query },
          ok: enoughEvidence,
          durationMs: retrievalDurationMs,
          sourceCount: roundSources.length,
        });
        trace.matchedDocs = collectedSources.length;
        yield {
          type: "tool_result",
          tool_result: {
            name: "search_knowledge_base",
            content: enoughEvidence ? "已获得足够的知识库证据" : "当前证据不足，准备调整检索查询",
            uiSummary: `第 ${round} 轮检索完成，命中 ${roundSources.length} 个来源`,
            durationMs: retrievalDurationMs,
            round,
          },
        };

        if (enoughEvidence) {
          evidence = lastResult;
          trace.finishReason = "evidence_found";
          break;
        }

        if (round >= this.maxRounds) {
          trace.finishReason = "round_limit";
          break;
        }
        if (Date.now() - startedAt >= this.maxDurationMs) {
          trace.finishReason = "time_budget";
          break;
        }

        yield {
          type: "tool_call",
          tool_call: { name: "rewrite_knowledge_query", arguments: { query }, round },
        };
        const rewriteStartedAt = Date.now();
        const rewritten = await this._rewriteQuery(message, query, lastResult, options);
        const rewriteDurationMs = Date.now() - rewriteStartedAt;
        trace.toolCalls.push({
          name: "rewrite_knowledge_query",
          args: { query },
          ok: Boolean(rewritten),
          durationMs: rewriteDurationMs,
        });
        yield {
          type: "tool_result",
          tool_result: {
            name: "rewrite_knowledge_query",
            content: rewritten?.reason || "查询改写失败，停止继续检索",
            uiSummary: rewritten ? `查询已改写为：${rewritten.query}` : "未生成有效的新查询",
            durationMs: rewriteDurationMs,
            round,
          },
        };
        if (!rewritten) {
          trace.finishReason = "rewrite_unavailable";
          break;
        }
        query = rewritten.query;
      }
    } catch (error) {
      if (error.name === "AbortError" || options.signal?.aborted) throw error;
      trace.finishReason = "retrieval_error";
      trace.fallbackReason = error.message;
      logEvent('warn', 'agentic_rag_orchestration_failed_fallback', { error: error.message });
    }

    if (!evidence) {
      trace.totalMs = Date.now() - startedAt;
      trace.fallbackReason ||= trace.finishReason;
      yield { type: "trace", channel: "agentic_rag", trace };
      yield* this.ragService.chatStream(message, history, options);
      return;
    }

    const evidenceSources = Array.isArray(evidence.sources) ? evidence.sources : [];
    trace.matchedDocs = evidenceSources.length;
    if (evidenceSources.length > 0) {
      yield { type: "sources", sources: evidenceSources };
    }

    const isProcess = typeof this.ragService.isProcessQuestion === "function"
      && this.ragService.isProcessQuestion(message);
    const enhancedPrompt = isProcess
      ? this.ragService.buildProcessPrompt(message, evidence.context)
      : this.ragService.buildParentChildPrompt(message, evidence.context);
    let fullReply = "";

    try {
      for await (const chunk of this.aiService.getCompletionStream(enhancedPrompt, history, {
        signal: options.signal,
      })) {
        if (chunk.done) {
          if (isProcess && typeof this.ragService.parseProcessCard === "function") {
            const processCard = this.ragService.parseProcessCard(fullReply);
            if (processCard) yield { type: "process", processCard };
          }
          trace.totalMs = Date.now() - startedAt;
          yield { type: "trace", channel: "agentic_rag", trace };
          yield { type: "content", content: "", done: true };
          return;
        }
        if (chunk.content) {
          fullReply += chunk.content;
          yield { type: "content", content: chunk.content, done: false };
        }
      }
    } catch (error) {
      if (error.code === "INCOMPLETE_STREAM") throw error;
      if (error.name === "AbortError" || options.signal?.aborted) throw error;
      trace.finishReason = "generation_error";
      trace.fallbackReason = error.message;
      trace.totalMs = Date.now() - startedAt;
      logEvent('warn', 'agentic_rag_generation_failed', { error: error.message });
      yield { type: "trace", channel: "agentic_rag", trace };
      if (!fullReply) {
        yield* this.ragService.chatStream(message, history, options);
        return;
      }
      yield { type: "content", content: "", done: true };
    }
  }

  async chat(message, history = [], options = {}) {
    let reply = "";
    let sources = [];
    let processCard = null;
    let agenticRag = null;
    for await (const event of this.chatStream(message, history, options)) {
      if (event.type === "content" && !event.done) reply += event.content || "";
      if (event.type === "sources") sources = event.sources || [];
      if (event.type === "process") processCard = event.processCard || null;
      if (event.type === "trace" && event.channel === "agentic_rag") agenticRag = event.trace;
    }
    return {
      reply,
      sources,
      context: "",
      isMock: false,
      model: "agentic-rag",
      processCard,
      agenticRag,
    };
  }
}

module.exports = { AgenticRagService, mergeSources, parseRewrite };
