// ==================== 消息索引（加速查找） ====================
// messagesMap: messageId -> { conversationId, message }
// 纯索引结构，非响应式（避免深层依赖追踪开销），O(1) 按 ID 查找消息。
// 从 conversation.store.js 拆出的纯数据结构模块，无 Pinia 依赖。

const messagesMap = new Map();

export function registerMessage(convId, msg) {
  if (msg?.id) messagesMap.set(msg.id, { conversationId: convId, message: msg });
}

export function registerConversationMessages(convId, messages) {
  for (const msg of messages) registerMessage(convId, msg);
}

export function unregisterMessage(msgId) {
  messagesMap.delete(msgId);
}

export function unregisterConversationMessages(convId) {
  for (const [id, entry] of messagesMap) {
    if (entry.conversationId === convId) messagesMap.delete(id);
  }
}

export function rebuildMessagesMap(conversations) {
  messagesMap.clear();
  for (const conv of conversations) {
    for (const msg of (conv.messages || [])) {
      registerMessage(conv.id, msg);
    }
  }
}

export function getMessageById(id) {
  return messagesMap.get(id) || null;
}

export function clearMessagesIndex() {
  messagesMap.clear();
}
