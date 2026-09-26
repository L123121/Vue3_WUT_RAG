"use strict";

const fs = require("fs");
const path = require("path");
const { AiService } = require("../llm/ai.service");
const { executeToolDetailed, getToolSchemas, getToolNames } = require("./agent-tools.service");
const { spillToolResult, compactHistoricalToolResults } = require("../conversation/context-compaction.service");
const config = require("../../config");
const { logEvent } = require('../observability/observability.service');

function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    if (Number.isFinite(Number(usage[key]))) total[key] = (total[key] || 0) + Number(usage[key]);
  }
  return total;
}

/**
 * AgentService — 轻量 Agent 工具调度层（V2.0，面试官反馈②）
 *
 * 吸取存档回退教训（2026-07-21：ReAct 多步循环延迟高、前端展示思考过程对校园用户是减分项），
 * 不做 ReAct 多步循环，做**有界工具调度（tool routing）+ 原生 function calling**：
 *
 *   用户问题
 *     ↓
 *   ① LLM 原生工具调用（opts.tools 携带 schema，流式解析 delta.tool_calls）
 *     → 决定调 search_knowledge_base / calculate / 直接回答
 *     ↓
 *   ② 确定性执行工具（本地/秒级，含超时闸门，多工具并行）
 *     ↓
 *   ③ 工具结果以 tool 角色消息回注（assistant tool_calls + tool result）
 *     → LLM 二次流式生成最终答案
 *
 * 2026-08-15 优化：
 *   - search_knowledge_base 改为仅检索（retrieveOnly），全链路只生成一次，sources 透传前端
 *   - chat() 统一 drain chatStream()，消除两套循环逻辑 drift 风险
 *   - 决策失败且未输出内容时 yield error 事件（AgentDecisionError），控制器据此降级 RAG
 *   - trace 持久化 data/agent-traces.jsonl（灰度分析：finishReason 分布/工具失败率）
 *
 * 2026-09-03 优化（上下文压缩分层，借鉴 AgentHarness 四层压缩中的两层）：
 *   - L1 大结果落盘：单条 tool result 超阈值写盘 data/tool-spills/，上下文留摘要+引用
 *   - L2 历史 tool result 替换：仅保留最近一轮完整 tool 消息，更早轮次换占位符
 *   - 压缩统计随 trace 持久化（spilled/compactedGroups/savedChars），灰度分析 token 节省量
 *   - 开关：AGENT_CONTEXT_COMPACTION=false 一键回退
 *
 * 开关：默认启用；AGENT_TOOL_ENABLED=false 可回退到 RAG 链路。
 */

// 系统提示：只注入工具名+简述（参数 schema 已由 API tools 参数携带，不再重复注入 JSON，省 token）
const SYSTEM_PROMPT = `你是"武理小精灵"，武汉理工大学校园助手。

你可以调用以下工具来获取信息（工具参数定义已通过 function calling 提供）：
{tool_list}

规则：
1. 如果问题需要检索校园知识库（食堂/图书馆/宿舍/课程/政策/奖学金/面试题等）→ 调用 search_knowledge_base
2. 如果问题需要数学计算 → 调用 calculate
3. 如果不需要任何工具，直接回答即可
4. 调用工具后，必须基于工具结果给出最终回答；如果工具结果不足以回答，请如实说明
5. 回答用简洁的中文`;

/**
 * Agent 决策失败专用错误：控制器据 agentShouldFallback 标记降级回 RAG 链路
 */
class AgentDecisionError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = "AgentDecisionError";
    this.agentShouldFallback = true;
    this.cause = cause;
  }
}

/**
 * trace 持久化（JSONL，fire-and-forget）：灰度期分析 finishReason 分布、工具失败率
 * 测试环境（NODE_ENV=test / VITEST）跳过，避免污染数据
 */
const TRACE_LOG_PATH = path.join(__dirname, "..", "..", "data", "agent-traces.jsonl");
// 轮转闸门：超过 10MB 重命名为 .1（覆盖旧轮转文件），防止文件无界增长
const TRACE_LOG_MAX_BYTES = 10 * 1024 * 1024;
let traceRotating = false;
function persistTrace(trace) {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  try {
    const line = JSON.stringify({ ...trace, ts: new Date().toISOString() }) + "\n";
    fs.appendFile(TRACE_LOG_PATH, line, (err) => {
      if (err || traceRotating) return;
      fs.stat(TRACE_LOG_PATH, (statErr, stat) => {
        if (statErr || !stat || stat.size < TRACE_LOG_MAX_BYTES) return;
        traceRotating = true;
        fs.rename(TRACE_LOG_PATH, `${TRACE_LOG_PATH}.1`, () => { traceRotating = false; });
      });
    });
  } catch {
    // 持久化失败不影响主链路
  }
}

/**
 * 稳定序列化（key 排序）：无进展检测签名用，避免 JSON key 顺序/空白差异绕过检测
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * 合并 sources（按 docId/title 去重），保持出现顺序
 */
function mergeSources(target, incoming) {
  const seen = new Set(target.map((s) => s.docId || s.title || JSON.stringify(s)));
  for (const s of incoming || []) {
    const key = s.docId || s.title || JSON.stringify(s);
    if (!seen.has(key)) {
      seen.add(key);
      target.push(s);
    }
  }
  return target;
}

/**
 * 会话级结构化记忆提取（L3，无 Redis）
 *
 * 从 history 中提取跨轮上下文，注入 system prompt，解决多轮指代断裂
 * （如"上一轮说的高数，这轮问'那道题'"）。不引入工作记忆存储，
 * 只做"最近几轮的结构化摘要"，随每次请求重新计算——零持久化成本。
 *
 * @param {Array} history - 对话历史 [{role, content}]
 * @returns {string|null} 记忆摘要文本，无历史时返回 null
 */
function buildMemorySummary(history = []) {
  if (!Array.isArray(history) || history.length === 0) return null;

  // 只看最近 6 条（历史本身已有 _compactHistory 压缩，这里只做摘要）
  const recent = history.slice(-6);
  const lastUser = [...recent].reverse().find((h) => h.role === "user");
  const lastAssistant = [...recent].reverse().find((h) => h.role === "assistant");

  const parts = [];
  // 最近提问主题（取前 60 字）
  if (lastUser?.content) {
    const topic = String(lastUser.content).replace(/\s+/g, " ").trim().slice(0, 60);
    if (topic) parts.push(`最近提问：${topic}`);
  }
  // 上一轮回答结论（取前 120 字）
  if (lastAssistant?.content) {
    const conclusion = String(lastAssistant.content).replace(/\s+/g, " ").trim().slice(0, 120);
    if (conclusion) parts.push(`上一轮回答结论：${conclusion}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * 组装首次调用的 messages：system（含会话记忆）+ history + 当前问题
 */
function buildDecisionMessages(message, history = []) {
  // 只注入工具名+简述（schema 由 API tools 参数携带，避免每次决策重复烧几百 token）
  const toolLines = getToolSchemas().map((s) => `- ${s.function.name}：${s.function.description}`);
  let system = SYSTEM_PROMPT.replace("{tool_list}", toolLines.length ? toolLines.join("\n") : "（无可用工具）");
  // L3 会话记忆：跨轮指代（"那道题"）依赖它
  const memory = buildMemorySummary(history);
  if (memory) {
    system += `\n\n以下是此前对话的摘要（用于理解指代，不是新问题）：\n${memory}`;
  }

  const hist = Array.isArray(history) ? history : [];
  const messages = [{ role: "system", content: system }];
  const bounded = [];
  let historyChars = 0;
  for (let i = hist.length - 1; i >= 0 && bounded.length < 12; i -= 1) {
    const h = hist[i];
    // system 只能来自 Agent 自己的 system prompt，客户端 history 的 system 不可信。
    const role = h?.role === "assistant" ? "assistant" : h?.role === "user" ? "user" : null;
    if (!role) continue;
    const content = String(h.content || "").slice(0, 2000);
    if (!content || (bounded.length > 0 && historyChars + content.length > 6000)) continue;
    bounded.unshift({ role, content });
    historyChars += content.length;
  }
  messages.push(...bounded);
  messages.push({ role: "user", content: String(message || "").slice(0, 4000) });
  return messages;
}

/**
 * 解析工具调用参数（arguments 为 JSON 字符串）
 */
function parseToolArgs(rawArgs) {
  if (!rawArgs || rawArgs === "{}") return {};
  try {
    const parsed = JSON.parse(rawArgs);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    logEvent('warn', 'agent_tool_args_parse_failed', { error: err.message });
    return {};
  }
}

/**
 * 把原生 tool_calls 转为 assistant 消息格式（用于回注）
 */
function toAssistantToolCalls(toolCalls) {
  return (toolCalls || []).map((tc) => ({
    id: tc.id,
    type: tc.type || "function",
    function: {
      name: tc.function?.name || "",
      arguments: tc.function?.arguments || "{}",
    },
  }));
}

class AgentService {
  constructor(aiService = null) {
    this.aiService = aiService || new AiService();
    this.toolEnabled = config.agent?.toolEnabled === true;
  }

  get enabled() {
    return this.toolEnabled;
  }

  get toolNames() {
    return getToolNames();
  }

  /**
   * ① 原生 function calling 决策：返回 { toolCalls, content }
   * 优先走 getCompletion（非流式，一次拿全 tool_calls）；无 Key 时返回空
   * （单轮决策 API，agent 评测脚本复用）
   */
  async decide(message, history = []) {
    const tools = getToolSchemas();
    const messages = buildDecisionMessages(message, history);
    const decideTimeoutMs = config.agent?.decideTimeoutMs || 15000;

    let timer;
    const decisionPromise = this.aiService.getCompletion(message, [], { tools, messages, timeout: decideTimeoutMs, retries: 0 });
    // 超时胜出后 decisionPromise 不再被 race 观察，必须吞掉其迟到的 rejection，
    // 否则 unhandledRejection 会击穿进程（同 tool-registry withTimeout 的处理）
    decisionPromise.catch(() => {});
    const response = await Promise.race([
      decisionPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ content: "", toolCalls: null, _timeout: true }), decideTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (response._timeout) {
      logEvent('warn', 'agent_decide_timeout', { timeoutMs: decideTimeoutMs });
      return { toolCalls: null, content: "", reason: "决策超时，直接回答" };
    }
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return { toolCalls: null, content: response.content || "", reason: "LLM 直接回答" };
    }
    return { toolCalls: response.toolCalls, content: response.content || "", reason: "原生 function calling" };
  }

  /**
   * ② 确定性执行工具（结构化返回 { ok, content, data }）
   */
  async runTool(name, args, context = {}) {
    logEvent('info', 'agent_tool_execute_start', { tool: name, args });
    const result = await executeToolDetailed(name, args, context);
    logEvent('info', 'agent_tool_execute_result', { tool: name, ok: result.ok, content: String(result.content).substring(0, 300) });
    return result;
  }

  /**
   * ③ 多轮工具调度 → 流式回答（原生 function calling，L2）
   *
   * 最多 maxToolRounds 轮（AGENT_MAX_TOOL_ROUNDS，默认 2）：
   *   - 每轮：LLM 原生工具调用 → 若调工具则执行并回注 tool 结果，继续下一轮
   *   - LLM 直接回答（无 tool_calls）→ 立即收尾
   *   - 无进展检测：连续 2 轮相同工具调用签名 → 强制收尾（防死循环）
   *   - 达到轮次上限 → 最后不带 tools 生成最终答案（强制收尾）
   *
   * @param {string} message
   * @param {Array} history
   * @param {Object} options { userId, traceId, conversationId }
   * @yields {type: 'tool_call'|'tool_result'|'sources'|'trace'|'content'|'error'}
   */
  async *chatStream(message, history = [], options = {}) {
    const totalStart = Date.now();
    const tools = getToolSchemas();
    const maxRounds = config.agent?.maxToolRounds || 2;
    let messages = buildDecisionMessages(message, history);

    // agent tracer（可观测性，L4）：记录轮次/工具调用/耗时/收尾原因，结束时随 SSE 下发
    const trace = {
      traceId: options.traceId || `agent_${Date.now().toString(36)}`,
      userId: options.userId || null,
      conversationId: options.conversationId || null,
      message,
      rounds: 0,
      toolCalls: [],
      totalMs: 0,
      finishReason: "direct_answer", // direct_answer | round_limit | no_progress | error
      // 上下文压缩统计（L1 落盘次数 / L2 压缩组数 / 节省字符数），随 trace 持久化
      compaction: { spilled: 0, compactedGroups: 0, savedChars: 0 },
      usage: {},
    };

    let lastSignature = null;
    let repeatCount = 0;
    let toolSummary = [];
    let collectedSources = [];
    let reachedLimit = false;

    for (let round = 0; round < maxRounds; round++) {
      trace.rounds = round + 1;
      let toolCalls = null;
      let streamedText = "";
      try {
        for await (const chunk of this.aiService.getCompletionStream("", [], { tools, messages, signal: options.signal })) {
          if (chunk.done) {
            toolCalls = chunk.tool_calls || null;
            addUsage(trace.usage, chunk.usage);
          } else if (chunk.content) {
            // 决策阶段内容实时透传（decision: true 标记）。模型可能在输出文本后
            // 又发起 tool_calls，因此前端把 decision 内容先渲染到"思考草稿区"；
            // 若随后出现 tool_call，前端丢弃草稿渲染过程卡片，不会泄露半截决策文本。
            streamedText += chunk.content;
            yield { type: "content", content: chunk.content, done: false, decision: true };
          }
        }
      } catch (err) {
        if (err.code === 'INCOMPLETE_STREAM') throw err;
        logEvent('warn', 'agent_round_decide_failed', { round: round + 1, error: err.message });
        trace.finishReason = "error";
        trace.totalMs = Date.now() - totalStart;
        persistTrace(trace);
        if (!streamedText) {
          // 尚未输出任何内容 → 通知控制器降级 RAG 链路（而非误导性的兜底文案）
          yield { type: "error", error: new AgentDecisionError(`agent 决策失败: ${err.message}`, err) };
        } else {
          // 已有部分内容流出，无法回退 → 保留已输出内容，礼貌收尾
          yield { type: "trace", trace };
          yield { type: "content", content: "", done: true };
        }
        return;
      }

      const maxToolCallsPerRound = config.agent?.maxToolCallsPerRound || 4;
      const validCalls = (toolCalls || []).filter((tc) => tc.function?.name).slice(0, maxToolCallsPerRound);
      if ((toolCalls || []).length > validCalls.length) {
        logEvent('warn', 'agent_tool_call_limit_applied', { requested: toolCalls.length, limit: maxToolCallsPerRound });
      }

      // LLM 直接回答（无工具调用）→ 内容已在决策阶段实时透传，此处直接收尾
      if (validCalls.length === 0) {
        if (!streamedText) {
          yield { type: "content", content: "抱歉，我没有理解您的问题。", done: false };
        }
        trace.totalMs = Date.now() - totalStart;
        persistTrace(trace);
        yield { type: "trace", trace };
        yield { type: "content", content: "", done: true };
        logEvent('info', 'agent_done_direct_answer', { round: round + 1, totalMs: Date.now() - totalStart });
        return;
      }

      // 下发 tool_call 事件（前端展示）
      for (const tc of validCalls) {
        yield { type: "tool_call", tool_call: { name: tc.function.name, arguments: parseToolArgs(tc.function.arguments) } };
      }

      // 执行工具（并行：多工具延迟从求和降为取最大值；单工具独立计时；含超时闸门）
      const results = await Promise.all(
        validCalls.map(async (tc) => {
          const start = Date.now();
          let r;
          try {
            r = await this.runTool(tc.function.name, parseToolArgs(tc.function.arguments), {
              userId: options.userId,
              conversationId: options.conversationId,
              traceId: trace.traceId,
              signal: options.signal,
            });
          } catch (err) {
            if (err.name === "AbortError" || options.signal?.aborted) throw err;
            r = { ok: false, content: `工具执行失败: ${err.message}`, data: null };
          }
          return {
            tc,
            ok: r.ok,
            result: r.content,
            uiSummary: r.uiSummary,
            data: r.data,
            durationMs: Date.now() - start,
          };
        })
      );
      for (const r of results) {
        trace.toolCalls.push({
          name: r.tc.function.name,
          args: parseToolArgs(r.tc.function.arguments),
          ok: r.ok,
          durationMs: r.durationMs,
        });
        mergeSources(collectedSources, r.data?.sources);
      }

      // L1 大结果落盘后再下发 tool_result，让 UI 获得 artifactId/hasMore 等完整元数据。
      const spilledResults = await Promise.all(
        results.map(({ tc, result }, idx) =>
          spillToolResult(tc.function.name, result, {
            traceId: trace.traceId,
            userId: options.userId,
            conversationId: options.conversationId,
            round: round + 1,
            index: idx,
          })
        )
      );
      for (const s of spilledResults) {
        if (s.spilled) {
          trace.compaction.spilled += 1;
          trace.compaction.savedChars += Math.max(s.originalLength - s.content.length, 0);
        }
      }

      // 下发 tool_result 事件（前端展示，单工具独立耗时）
      for (const [index, { tc, result, uiSummary, data, durationMs }] of results.entries()) {
        const spilled = spilledResults[index];
        const artifactId = spilled.artifactId || data?.artifactId || null;
        const totalChars = spilled.spilled ? spilled.originalLength : (data?.totalChars ?? spilled.originalLength);
        const offset = Number.isFinite(Number(data?.offset)) ? Number(data.offset) : 0;
        const hasMore = spilled.spilled === true
          || data?.hasMore === true
          || spilled.originalLength > spilled.content.length;
        yield {
          type: "tool_result",
          tool_result: {
            name: tc.function.name,
            content: uiSummary || String(result || '').slice(0, 1000),
            uiSummary: uiSummary || null,
            status: "done",
            durationMs,
            artifactId,
            spilled: spilled.spilled === true,
            totalChars,
            offset,
            hasMore,
          },
        };
      }
      // 知识库检索命中 → 透传 sources（前端引用展示，与 RAG 路径一致）
      if (collectedSources.length > 0) {
        yield { type: "sources", sources: collectedSources };
      }
      toolSummary.push(validCalls.map((t) => t.function.name).join(","));

      // 工具结果回注（tool 角色消息，供下一轮决策/最终生成）
      messages = [
        ...messages,
        { role: "assistant", content: null, tool_calls: toAssistantToolCalls(validCalls) },
        ...results.map(({ tc }, idx) => ({
          role: "tool",
          tool_call_id: tc.id,
          content: spilledResults[idx].content,
        })),
      ];

      // L2 历史 tool result 替换：仅保留最近一轮完整结果，更早轮次替换为占位符
      const compaction = compactHistoricalToolResults(messages);
      if (compaction.compactedGroups > 0) {
        messages = compaction.messages;
        trace.compaction.compactedGroups += compaction.compactedGroups;
        trace.compaction.savedChars += compaction.savedChars;
      }

      // ---- 无进展检测：连续 2 轮相同工具调用 → 强制收尾 ----
      // 签名用 stableStringify 规范化（解析后 key 排序），避免 JSON key 顺序/空白差异绕过检测
      const signature = validCalls.map((t) => `${t.function.name}:${stableStringify(parseToolArgs(t.function.arguments))}`).join("|");
      if (signature === lastSignature) {
        repeatCount++;
        if (repeatCount >= 2) {
          logEvent('warn', 'agent_no_progress_forced_finish', { signature });
          trace.finishReason = "no_progress";
          messages = [
            ...messages,
            { role: "user", content: "你已多次调用相同工具。请基于已有信息直接给出最终回答，不要再调用任何工具。" },
          ];
          reachedLimit = true;
          break;
        }
      } else {
        lastSignature = signature;
        repeatCount = 1;
      }

      // 达到最大轮次 → 强制收尾（最后生成不带 tools，杜绝继续调工具）
      if (round >= maxRounds - 1) {
        trace.finishReason = "round_limit";
        reachedLimit = true;
      }
    }

    // 收尾生成：不带 tools，强制 LLM 基于已回注的工具结果给出最终答案。
    // 工具已执行但收尾 LLM 失败时不能裸抛 500/裸 error——沿用决策期的降级机制
    const finalTools = reachedLimit ? [] : tools;
    let finalStreamed = false;
    try {
      for await (const chunk of this.aiService.getCompletionStream("", [], { messages, tools: finalTools, signal: options.signal })) {
          if (chunk.done) {
          addUsage(trace.usage, chunk.usage);
          trace.totalMs = Date.now() - totalStart;
          logEvent('info', 'agent_done', { tools: toolSummary.join(";"), totalMs: trace.totalMs });
          persistTrace(trace);
          // token 用量随收尾下发（与 rag.service.chatStream 一致，前端逐条消息展示成本）
          if (chunk.usage) yield { type: "usage", usage: chunk.usage };
          yield { type: "trace", trace };
          yield { type: "content", content: "", done: true };
          return;
        }
        if (chunk.content) {
          finalStreamed = true;
          yield { type: "content", content: chunk.content, done: false };
        }
      }
    } catch (err) {
      if (err.code === 'INCOMPLETE_STREAM') throw err;
      logEvent('warn', 'agent_final_answer_failed', { error: err.message });
      trace.finishReason = "error";
      trace.totalMs = Date.now() - totalStart;
      persistTrace(trace);
      if (!finalStreamed) {
        // 尚未输出任何内容 → 通知控制器降级 RAG 链路
        yield { type: "error", error: new AgentDecisionError(`agent 收尾生成失败: ${err.message}`, err) };
      } else {
        // 已有部分内容流出，无法回退 → 保留已输出内容，礼貌收尾
        yield { type: "trace", trace };
        yield { type: "content", content: "", done: true };
      }
    }
  }

  /**
   * 非流式调度：统一 drain chatStream()（单一实现，消除两套循环逻辑的 drift 风险）
   * AgentDecisionError 原样上抛，由控制器降级 RAG 链路
   */
  async chat(message, history = [], options = {}) {
    let reply = "";
    // 决策阶段内容带 decision 标记实时透传；若随后出现 tool_call，说明这段是
    // 被废弃的"思考草稿"（前端也会丢弃），不能计入最终 reply
    let pendingDecisionText = "";
    const toolNames = [];
    let sources = [];
    let trace = null;

    for await (const ev of this.chatStream(message, history, options)) {
      if (ev.type === "content") {
        if (!ev.done) {
          if (ev.decision) {
            pendingDecisionText += ev.content || "";
          } else {
            reply += ev.content || "";
            pendingDecisionText = "";
          }
        }
      } else if (ev.type === "tool_call") {
        pendingDecisionText = ""; // 草稿被工具调用取代
        if (ev.tool_call?.name) toolNames.push(ev.tool_call.name);
      } else if (ev.type === "sources") {
        sources = ev.sources || [];
      } else if (ev.type === "trace") {
        trace = ev.trace || null;
      } else if (ev.type === "error") {
        throw ev.error; // AgentDecisionError（agentShouldFallback=true）→ 控制器降级 RAG
      }
    }
    // 直接回答路径：内容全部以 decision 标记透传，收尾时即为最终回答
    reply += pendingDecisionText;

    return {
      reply: reply || "抱歉，我没有理解您的问题。",
      isMock: false,
      model: config.ai.model || "step-3.7-flash",
      sources,
      trace,
      tool: {
        name: toolNames.join(";") || null,
        args: [],
        result: null,
      },
    };
  }
}

module.exports = { AgentService, AgentDecisionError, SYSTEM_PROMPT, buildDecisionMessages, buildMemorySummary, parseToolArgs, stableStringify, mergeSources };
