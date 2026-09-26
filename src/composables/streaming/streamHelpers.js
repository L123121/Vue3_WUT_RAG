// ==================== 流式辅助函数 ====================
// 从 useStreaming.js 拆出的纯函数：LLM 历史构建、会话标题自动生成、TTFT 埋点。

import { toLlmHistoryMessage } from '../../utils/messageFragments.js';

const TTFT_STORAGE_KEY = 'ttft_frame_measurements';
const TTFT_MAX_SAMPLES = 100;

/**
 * 从会话消息构建 LLM 请求历史：
 * 排除当前用户消息 → 转 LLM 格式 → 最近 20 条 → 去除相邻同角色 → 去除末尾悬空 user
 */
export function buildHistory(msgs, currentUserMessageId) {
  const rawHistory = (msgs || [])
    .filter((m) => m.id !== currentUserMessageId)
    .map(toLlmHistoryMessage)
    .filter(Boolean)
    .slice(-20);

  const history = [];
  let lastRole = '';
  for (const m of rawHistory) {
    if (m.role === lastRole && history.length > 0) history.pop();
    history.push(m);
    lastRole = m.role;
  }
  if (history.length > 0 && history[history.length - 1].role === 'user') history.pop();
  return history;
}

/**
 * 首轮会话的标题自动生成：从用户首条消息提炼短语（问候语给通用标题）。
 * 仅处理"新会话/默认会话"默认标题，用户或系统命名过的标题不动。
 */
export function autoRenameConversationIfNeeded(conv, convStore, userText) {
  if (!conv || !(conv.title.startsWith('新会话') || conv.title === '默认会话')) return;
  if (!userText) return;
  const cleanText = userText
    .replace(/[【】《》「」『』""'']/g, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/[#*_~`\\]/g, '')
    .trim();
  const greeting = /^(你好|您好|hi|hello|嗨|hey|在吗|在不在|早上好|晚上好|下午好)[!！.。]?$/i;
  const title = greeting.test(cleanText) ? '新对话' : (cleanText.slice(0, 10) || '新对话');
  conv.title = title;
  convStore.renameConversation(conv.id, title);
  convStore.scheduleSaveCache(true);
}

/**
 * TTFT 埋点：首帧渲染（RAF 回调 = 真正写 DOM）耗时写入 localStorage 滚动窗口。
 * 返回一个"只生效一次"的首帧处理器，供 runBuffer.onFirstFramePainted 使用。
 */
export const createFirstFrameRecorder = (streamStartTime, messageText) => {
  let painted = false;
  return () => {
    if (painted) return;
    painted = true;
    const firstFrameMs = Math.round(performance.now() - streamStartTime);
    if (import.meta.env.DEV) console.debug(`[TTFT] 首字渲染(DOM写入): ${firstFrameMs}ms`);
    try {
      const arr = JSON.parse(localStorage.getItem(TTFT_STORAGE_KEY) || '[]');
      arr.push({ ts: Date.now(), firstFrame: firstFrameMs, msg: messageText.substring(0, 30) });
      while (arr.length > TTFT_MAX_SAMPLES) arr.shift();
      localStorage.setItem(TTFT_STORAGE_KEY, JSON.stringify(arr));
    } catch {}
  };
};
