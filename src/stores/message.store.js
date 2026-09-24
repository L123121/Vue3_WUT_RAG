import { defineStore } from 'pinia';
import { useStreaming } from '../composables/useStreaming.js';
import { useMessageActions } from '../composables/useMessageActions.js';

export const useMessageStore = defineStore('message', () => {
  const streaming = useStreaming();
  const actions = useMessageActions();

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
