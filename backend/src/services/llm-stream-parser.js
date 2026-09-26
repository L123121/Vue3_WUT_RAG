"use strict";

// ==================== LLM SSE 流式解析 ====================
// 从 ai.service.js 拆出：OpenAI 兼容与 Anthropic 两种 SSE 流的解析、
// tool_calls 增量拼接与收尾组装、流式请求 payload 构建。

const { StringDecoder } = require('string_decoder');
const { operationalMetrics } = require('./operational-metrics.service');
const { setLlmUsage } = require('./otel-tracing.service');
const { logEvent } = require('./observability.service');

/**
 * @typedef {Object} LlmStreamChunk
 * 解析器 yield 的流式片段
 * @property {string} content 增量正文（终态片段为空串）
 * @property {boolean} done 是否终态（[DONE] / message_stop / 流自然结束）
 * @property {Object|null} [usage] token 用量（出现且终态时携带）
 * @property {Array<{id: string, type: 'function', function: {name: string, arguments: string}}>|null} [tool_calls]
 *   终态时组装完成的工具调用；未声明 tools、流中无分片或全部分片无效时为 null
 */

/**
 * @typedef {Object} ToolCallAccumulator
 * 单个 tool_calls 分片的累积态（OpenAI 兼容流式按 index 分片）
 * @property {string} id 调用 ID（首个携带 id 的分片生效）
 * @property {string} name 工具名（首个携带 name 的分片生效）
 * @property {string} arguments 增量拼接的 JSON 参数文本（流中断时可能残缺，组装时降级 '{}'）
 */

class IncompleteStreamError extends Error {
  constructor(provider = 'upstream') {
    super(`${provider} 流在收到终态前提前结束`);
    this.name = 'IncompleteStreamError';
    this.code = 'INCOMPLETE_STREAM';
    this.retryable = true;
  }
}

/**
 * 构建流式请求 payload。messages 由调用方先做边界控制
 * （boundContextMessages(opts.messages || buildHistoryMessages(...))），
 * 本函数只关心模型参数与协议差异。
 */
function buildStreamPayload(provider, messages, opts = {}) {
  const payload = {
    model: provider.model,
    messages,
    max_tokens: provider.maxTokens,
    temperature: provider.temperature,
    stream: true,
  };
  // 推理模型（如 step-3.7-flash）默认关闭思考链，避免思考 token 耗尽预算导致 content 为空
  if (!provider.anthropicMode && !provider.enableThinking) {
    payload.enable_thinking = false;
  }
  const supportsStreamUsage = /api\.(stepfun|openai)\.com/i.test(provider.baseUrl || '');
  if (!provider.anthropicMode && supportsStreamUsage) {
    payload.stream_options = { include_usage: true };
  }
  // 原生 function calling（OpenAI 兼容）：调用方传 opts.tools 时携带工具描述
  if (!provider.anthropicMode && Array.isArray(opts.tools) && opts.tools.length > 0) {
    payload.tools = opts.tools;
  }
  return payload;
}

/**
 * 把流式累积的 tool_calls 分片组装为完整数组（供解析器收尾）
 * - 按 index 升序
 * - name 为空的分片丢弃（首片丢失无法执行，避免"未知工具"）
 * - arguments 残缺（流中断）降级为 {}，不静默用残缺 JSON
 */
function assembleToolCalls(toolCallMap, hasToolCalls, needsTools) {
  if (!needsTools || !hasToolCalls || toolCallMap.size === 0) return null;
  const toolCalls = Array.from(toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([_, tc]) => ({
      id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments || '{}' },
    }))
    .filter((tc) => {
      if (!tc.function.name) {
        logEvent('warn', 'ai_stream_tool_call_empty_name_dropped', { id: tc.id });
        return false;
      }
      if (tc.function.arguments && tc.function.arguments !== '{}') {
        try {
          JSON.parse(tc.function.arguments);
        } catch {
          logEvent('warn', 'ai_stream_tool_call_args_incomplete', { tool: tc.function.name });
          tc.function.arguments = '{}';
        }
      }
      return true;
    });
  return toolCalls.length > 0 ? toolCalls : null;
}

/**
 * 解析 LLM SSE 流：yield { content, done } 增量片段，终态时附带 usage 与 tool_calls。
 * res 为 httpClient.requestStream 返回的可迭代响应。
 */
async function* parseSseStream(res, provider, opts = {}, llmSpan = null, assembleToolCallsFn = assembleToolCalls) {
  let buf = '';
  let streamUsage = null;
  let usageRecorded = false;
  let terminalSeen = false;
  const decoder = new StringDecoder('utf8');
  // tool_calls 增量拼接（OpenAI 兼容流式：delta.tool_calls 按 index 分片）
  const toolCallMap = new Map();
  let hasToolCalls = false;
  const needsTools = Array.isArray(opts.tools) && opts.tools.length > 0;
  const recordUsage = () => {
    if (usageRecorded || !streamUsage) return;
    usageRecorded = true;
    operationalMetrics.recordLlmUsage({ model: provider.model, usage: streamUsage, traceId: opts.traceId });
    setLlmUsage(llmSpan, streamUsage);
  };

  for await (const chunk of res) {
    buf += decoder.write(chunk);
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('event:')) continue;
      if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (d === '[DONE]') {
        terminalSeen = true;
        recordUsage();
        yield { content: '', done: true, usage: streamUsage || null, tool_calls: assembleToolCallsFn(toolCallMap, hasToolCalls, needsTools) };
        return;
      }
      try {
        const j = JSON.parse(d);
        if (j.usage) streamUsage = j.usage;
        let content = '';
        let done = false;
        if (provider.anthropicMode) {
          if (j.type === 'content_block_delta' && j.delta?.text) content = j.delta.text;
          if (j.type === 'message_stop' || j.type === 'message_delta') {
            done = true;
            terminalSeen = true;
          }
        } else {
          const choice = j.choices?.[0];
          content = choice?.delta?.content || '';
          // tool_calls 增量：{index, id?, function:{name?, arguments?}}
          if (choice?.delta?.tool_calls) {
            hasToolCalls = true;
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              let entry = toolCallMap.get(idx);
              if (!entry) {
                entry = { id: tc.id || '', name: tc.function?.name || '', arguments: '' };
                toolCallMap.set(idx, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }
        }
        if (content) yield { content, done: false };
        if (done) {
          recordUsage();
          yield { content: '', done: true, usage: streamUsage || null, tool_calls: assembleToolCallsFn(toolCallMap, hasToolCalls, needsTools) };
          return;
        }
      } catch (err) {
        logEvent('warn', 'ai_stream_sse_parse_failed', { error: err.message });
      }
    }
  }
  // 冲刷 decoder 中残留的不完整多字节序列；最后一行可能没有换行符。
  buf += decoder.end();
  if (buf.trim()) {
    const t = buf.trim();
    if (t.startsWith('data:')) {
      const data = t.slice(5).trim();
      if (data === '[DONE]') {
        terminalSeen = true;
      } else {
        try {
          const j = JSON.parse(data);
          if (j.usage) streamUsage = j.usage;
          const content = provider.anthropicMode
            ? (j.type === 'content_block_delta' ? (j.delta?.text || '') : (j.delta?.text || ''))
            : (j.choices?.[0]?.delta?.content || '');
          if (content) yield { content, done: false };
          if (provider.anthropicMode && (j.type === 'message_stop' || j.type === 'message_delta')) {
            terminalSeen = true;
          }
        } catch (err) {
          logEvent('warn', 'ai_stream_trailing_sse_parse_failed', { error: err.message });
        }
      }
    }
  }
  if (!terminalSeen) {
    recordUsage();
    throw new IncompleteStreamError(provider.anthropicMode ? 'Anthropic' : 'OpenAI');
  }
  recordUsage();
  yield { content: '', done: true, usage: streamUsage || null, tool_calls: assembleToolCallsFn(toolCallMap, hasToolCalls, needsTools) };
}

module.exports = {
  IncompleteStreamError,
  buildStreamPayload,
  assembleToolCalls,
  parseSseStream,
};
