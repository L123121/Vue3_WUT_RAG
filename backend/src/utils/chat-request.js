"use strict";

const MAX_MESSAGE_CHARS = 8000;
const MAX_HISTORY_ITEMS = 100;
const MAX_HISTORY_CONTENT_CHARS = 20000;
// 客户端历史只可能是对话双方的发言；system/tool 角色只能由服务端注入，否则等于把系统指令权交给请求方
const CLIENT_HISTORY_ROLES = new Set(['user', 'assistant']);

class ChatRequestError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ChatRequestError';
    this.statusCode = 400;
    this.code = code;
    this.expose = true;
  }
}

function sanitizeClientHistory(history) {
  if (!Array.isArray(history)) return [];
  const result = [];
  for (const item of history.slice(-MAX_HISTORY_ITEMS)) {
    if (!item || typeof item !== 'object' || !CLIENT_HISTORY_ROLES.has(item.role)) continue;
    if (typeof item.content !== 'string' || !item.content.trim()) continue;
    result.push({ role: item.role, content: item.content.slice(0, MAX_HISTORY_CONTENT_CHARS) });
  }
  return result;
}

function parseChatRequest(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const { message } = payload;
  if (typeof message !== 'string' || !message.trim()) {
    throw new ChatRequestError('消息内容不能为空', 'MESSAGE_REQUIRED');
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new ChatRequestError(`消息内容过长（上限 ${MAX_MESSAGE_CHARS} 字符）`, 'MESSAGE_TOO_LONG');
  }
  if (payload.history !== undefined && payload.history !== null && !Array.isArray(payload.history)) {
    throw new ChatRequestError('history 必须是数组', 'HISTORY_INVALID');
  }
  const category = typeof payload.category === 'string' && payload.category.trim()
    ? payload.category.trim().slice(0, 100)
    : undefined;
  return {
    message,
    history: sanitizeClientHistory(payload.history),
    category,
  };
}

module.exports = {
  ChatRequestError,
  parseChatRequest,
  sanitizeClientHistory,
  MAX_MESSAGE_CHARS,
};
