/**
 * useMessageActions — 消息操作 composable
 *
 * 处理消息删除、清空、获取历史等操作
 */

import { useConversationStore } from '../stores/conversation.store.js';
import { clearConversationMessages } from '../api/conversations.js';
import { createWelcomeMessage } from '../utils/chatHelpers.js';
import { toLlmHistoryMessage } from '../utils/messageFragments.js';

export function useMessageActions() {
  const deleteMessage = (id) => {
    const convStore = useConversationStore();
    const conv = convStore.currentConversation;
    if (!conv || id === 'welcome') return;
    const index = conv.messages?.findIndex((m) => m.id === id);
    if (index > -1) {
      conv.messages.splice(index, 1);
      convStore.unregisterMessage(id);
      convStore.scheduleSaveCache(true);
    }
  };

  const setMessageFeedback = (id, feedback) => {
    const convStore = useConversationStore();
    const conv = convStore.currentConversation;
    if (!conv || id === 'welcome') return;
    const index = conv.messages?.findIndex((m) => m.id === id);
    if (index > -1) {
      conv.messages[index] = {
        ...conv.messages[index],
        feedback,
      };
      // 消息对象被替换（spread），重新注册以更新引用
      convStore.registerMessage(conv.id, conv.messages[index]);
      convStore.scheduleSaveCache(true);
    }
  };

  const clearMessages = async () => {
    const convStore = useConversationStore();
    const conv = convStore.currentConversation;
    if (!conv) return;

    // 清空消息前，先 unregister 旧消息（保留欢迎消息）
    for (const msg of conv.messages) {
      if (msg.id !== 'welcome') convStore.unregisterMessage(msg.id);
    }

    // 清空消息：保留统一结构的欢迎消息
    conv.messages = [createWelcomeMessage()];
    convStore.scheduleSaveCache(true);

    if (!convStore.isLocalSession(conv.id) && convStore.isBackendAvailable()) {
      try {
        await clearConversationMessages(conv.id);
      } catch (error) {
        console.error('清空消息失败:', error);
      }
    }
  };

  const getConversationHistory = () => {
    const convStore = useConversationStore();
    const messages = convStore.currentConversation?.messages || [];
    return messages
      .map((message) => {
        const item = toLlmHistoryMessage(message);
        return item ? { ...item, timestamp: message.timestamp } : null;
      })
      .filter(Boolean);
  };

  return {
    deleteMessage,
    setMessageFeedback,
    clearMessages,
    getConversationHistory,
  };
}
