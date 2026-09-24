import { hydrateMessageFragments } from './messageFragments.js';

const createMessageId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const getMessageText = (msg) => {
  if (!msg) return '';
  // 优先读 content（统一后的规范字段），降级到 text（兼容旧数据）
  return String(msg.content ?? msg.text ?? msg.message ?? '').trim();
};

const normalizeRole = (role) => {
  if (role === 'assistant') return 'model';
  return role || 'model';
};

const createWelcomeMessage = () => hydrateMessageFragments({
  id: 'welcome',
  role: 'model',
  content: '你好！我是武理小精灵，你的校园 AI 助手。有什么我可以帮你的吗？',
  timestamp: new Date(),
});

const normalizeMessage = (msg = {}) => {
  const text = getMessageText(msg);
  return hydrateMessageFragments({
    ...msg,
    id: msg.id || createMessageId(),
    role: normalizeRole(msg.role),
    content: text,
    // 保留 text 字段兼容 Vue 模板中直接引用 message.text 的写法
    text: msg.text ?? text,
    timestamp: msg.timestamp || new Date(),
  });
};

const normalizeMessages = (list) =>
  Array.isArray(list) ? list.map((msg) => normalizeMessage(msg)) : [];

const createLocalConversation = (title, messageCount = 0) => ({
  id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  title: title || `新会话 ${messageCount + 1}`,
  messages: [createWelcomeMessage()],
  createdAt: new Date(),
  updatedAt: new Date(),
});

export {
  createMessageId,
  getMessageText,
  normalizeRole,
  normalizeMessage,
  normalizeMessages,
  createWelcomeMessage,
  createLocalConversation,
};
