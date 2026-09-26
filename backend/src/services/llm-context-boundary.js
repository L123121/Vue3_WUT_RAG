"use strict";

// ==================== LLM 上下文边界控制 ====================
// 从 ai.service.js 拆出：历史窗口预算（C 方案）、消息边界（含 Agent 工具消息）、
// 滚动摘要压缩（B 方案）。纯逻辑，不感知 HTTP/provider 细节。

const crypto = require('crypto');
const config = require('../config');
const { QueryCache } = require('../utils/query-cache');
const { logEvent } = require('./observability.service');

// history compaction 缓存：由调用方创建并持有（通常为 AiService 实例级别，
// 便于测试隔离）；独立调用 compactHistory 时使用模块级默认缓存
const createCompactCache = () => new QueryCache(
  config?.rag?.compactCacheMaxEntries || 200,
  config?.rag?.compactCacheTtlMs || 1800000,
);

const compactCache = createCompactCache();

/**
 * C 方案：token 预算分配（history / RAG 资料 / 当前问题+输出 互不挤占）
 * - history 总预算：6000 字符（≈3000-4000 token，中文 1 字 ≈ 0.6-1 token）
 * - RAG 资料预算：由 rag.service 的 maxContextLength=6000 字符独立控制
 * - 输出预算：max_tokens=4000
 * 预算按"从最近消息往回取"累积，超预算即停，保证最近的对话优先保留
 */
function buildHistoryMessages(message, history = []) {
  // 防御：调用方可能传 null/非数组
  if (!Array.isArray(history)) history = [];
  const MAX_HISTORY_MESSAGES = 12;
  const MAX_MESSAGE_CHARS = 2000;
  const MAX_TOTAL_HISTORY_CHARS = 6000;

  const recent = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0 && recent.length < MAX_HISTORY_MESSAGES; i--) {
    const h = history[i];
    const content = String(h?.content || '').slice(0, MAX_MESSAGE_CHARS);
    if (!content) continue;
    // 至少保留 1 条；之后超总预算则停止（最近的对话优先）
    if (recent.length > 0 && total + content.length > MAX_TOTAL_HISTORY_CHARS) break;
    const role = h.role === 'assistant' ? 'assistant' : h.role === 'system' ? 'system' : 'user';
    recent.unshift({ role, content });
    total += content.length;
  }
  return [
    ...recent,
    { role: 'user', content: String(message || '').slice(0, 4000) },
  ];
}

/**
 * 对显式 opts.messages 也执行上下文边界控制。
 * Agent 的工具调用历史必须在 provider 入口统一限额，不能因为绕过 history 参数而失去预算保护。
 */
function boundContextMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  const maxChars = config.ai?.contextMaxChars || 12000;
  const maxMessageChars = config.ai?.contextMessageMaxChars || 4000;
  const normalized = messages.map((message) => {
    const role = ['system', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user';
    const content = message?.content == null ? null : String(message.content).slice(0, maxMessageChars);
    const next = { ...message, role, content };
    if (role === 'tool') {
      next.tool_call_id = String(message.tool_call_id || '').slice(0, 160);
    }
    if (Array.isArray(message?.tool_calls)) {
      next.tool_calls = message.tool_calls.slice(0, 8).map((call) => ({
        id: String(call?.id || '').slice(0, 160),
        type: call?.type || 'function',
        function: {
          name: String(call?.function?.name || '').slice(0, 120),
          arguments: String(call?.function?.arguments || '{}').slice(0, 2000),
        },
      }));
    }
    return next;
  });

  const system = normalized.filter((message) => message.role === 'system');
  const body = normalized.filter((message) => message.role !== 'system');
  const systemBudget = Math.min(Math.floor(maxChars * 0.35), 5000);
  let used = 0;
  const boundedSystem = [];
  for (const message of system) {
    if (used >= systemBudget) break;
    const remaining = Math.max(systemBudget - used, 0);
    const content = String(message.content || '').slice(0, remaining);
    if (!content) continue;
    boundedSystem.push({ ...message, content });
    used += content.length;
  }

  const blocks = [];
  for (let i = 0; i < body.length; i += 1) {
    const message = body[i];
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const group = [message];
      let j = i + 1;
      while (j < body.length && body[j].role === 'tool') group.push(body[j++]);
      blocks.push(group);
      i = j - 1;
    } else {
      blocks.push([message]);
    }
  }

  const selected = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    const blockChars = block.reduce((sum, item) => sum + String(item.content || '').length, 0);
    if (selected.length > 0 && used + blockChars > maxChars) continue;
    if (selected.length === 0 && used + blockChars > maxChars) {
      const last = block[block.length - 1];
      const remaining = Math.max(maxChars - used, 1);
      selected.unshift([{ ...last, content: String(last.content || '').slice(-remaining) }]);
      used = maxChars;
      break;
    }
    selected.unshift(block);
    used += blockChars;
    if (used >= maxChars) break;
  }
  return [...boundedSystem, ...selected.flat()];
}

/** 将早期消息列表 hash 为短字符串，用于 compaction 缓存 key */
function compactHash(messages) {
  if (!messages || !messages.length) return 'empty';
  const normalized = messages.map((message) => ({
    role: message?.role || 'user',
    content: String(message?.content || ''),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

/**
 * 滚动摘要压缩（B 方案）：history 超过窗口时，把被裁掉的早期消息
 * 用独立小模型压缩成摘要，摘要作为一条 system 消息置于对话前，
 * 保留早期关键背景（专业/偏好/已办事项），同时 token 可控。
 * 压缩失败时降级为直接截断（不阻塞主流程）。
 * @param {Array} history 原始历史消息
 * @param {(early: Array) => Promise<string>} summarize 摘要函数（由调用方注入，通常为 JudgeService.summarize）
 * @returns {Promise<Array>} 压缩后的 history（异步）
 */
async function compactHistory(history = [], summarize, cache = compactCache) {
  const MAX_HISTORY_MESSAGES = 12;
  if (!Array.isArray(history)) return [];
  if (history.length === 0) return history;
  const systemMessages = history.filter(message => message?.role === 'system');
  const conversation = history.filter(message => message?.role !== 'system');
  if (conversation.length <= MAX_HISTORY_MESSAGES) return [...systemMessages, ...conversation];

  // 被裁掉的早期消息（超出窗口的部分）
  const early = conversation.slice(0, conversation.length - MAX_HISTORY_MESSAGES);
  const recent = conversation.slice(-MAX_HISTORY_MESSAGES);

  // 缓存拦截：相同的早期消息窗口可直接返回缓存的摘要
  if (config?.rag?.cacheEnabled) {
    const hash = compactHash(early);
    const cached = cache.get(hash);
    if (cached !== undefined) {
      return [
        ...systemMessages,
        { role: 'system', content: `（此前对话摘要）${cached}` },
        ...recent,
      ];
    }
  }

  try {
    const summary = await summarize(early);
    if (summary) {
      logEvent('info', 'ai_summary_compacted', { earlyCount: early.length, summaryChars: summary.length });

      // 缓存写入
      if (config?.rag?.cacheEnabled) {
        cache.set(compactHash(early), summary);
      }

      return [
        ...systemMessages,
        { role: 'system', content: `（此前对话摘要）${summary}` },
        ...recent,
      ];
    }
  } catch (err) {
    logEvent('warn', 'ai_summary_failed_truncate_fallback', { error: err.message });
  }
  return [...systemMessages, ...recent];
}

module.exports = {
  buildHistoryMessages,
  boundContextMessages,
  compactHistory,
  compactHash,
  createCompactCache,
  compactCache,
};
