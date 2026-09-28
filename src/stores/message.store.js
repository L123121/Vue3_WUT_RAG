import { defineStore } from 'pinia';
import { useStreaming } from '../composables/useStreaming.js';
import { useMessageActions } from '../composables/useMessageActions.js';
import { useConversationStore } from './conversation.store.js';

export const useMessageStore = defineStore('message', () => {
  const streaming = useStreaming();
  const actions = useMessageActions();

  // 依赖反转：conversation.store 不再 import 本模块（消除 conversation →
  // message → useStreaming → conversation 的模块循环），改为这里把"流式
  // 进行中"的判定与中止能力注册过去。注册用裸 ref 的 getter，避免依赖
  // pinia 代理的解包时机。
  useConversationStore().registerStreamGuard({
    isLoading: () => streaming.isLoading.value,
    activeStreamingConversationId: () => streaming.activeStreamingConversationId.value,
    abortCurrentRequest: streaming.abortCurrentRequest,
  });

  return {
    // 流式状态（由 useStreaming 管理）
    isLoading: streaming.isLoading,
    currentStreamingId: streaming.currentStreamingId,
    decisionDraft: streaming.decisionDraft,
    activeStreamingConversationId: streaming.activeStreamingConversationId,
    activeRunId: streaming.activeRunId,
    runsById: streaming.runsById,
    isConnected: streaming.isConnected,
    isReconnecting: streaming.isReconnecting,
    reconnectAttempt: streaming.reconnectAttempt,

    // 流式操作
    sendMessage: streaming.sendMessage,
    retryMessage: streaming.retryMessage,
    editAndResendMessage: streaming.editAndResendMessage,
    abortCurrentRequest: streaming.abortCurrentRequest,
    abortRun: streaming.abortRun,

    // 消息操作
    deleteMessage: actions.deleteMessage,
    setMessageFeedback: actions.setMessageFeedback,
    clearMessages: actions.clearMessages,
    getConversationHistory: actions.getConversationHistory,
  };
});
