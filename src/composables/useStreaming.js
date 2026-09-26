/**
 * useStreaming — 流式消息处理 composable
 *
 * 管理 SSE 流式请求的建立、chunk 处理、重连、中断。
 * 机制拆分：RAF 缓冲见 streaming/runBuffer.js，字段补丁回调见 streaming/messagePatches.js，
 * 纯辅助函数见 streaming/streamHelpers.js
 */

import { ref, onUnmounted } from 'vue';
import { sendMessageStream, connectionManager } from '../api/chat.js';
import { useConversationStore } from '../stores/conversation.store.js';
import {
  createMessageId,
  getMessageText,
  normalizeMessages,
  createLocalConversation,
} from '../utils/chatHelpers.js';
import {
  createRunId,
  dispatchRunEvent,
  TERMINAL_RUN_EVENT_TYPES,
} from '../utils/runEvents.js';
import {
  clearMessageAttemptState,
  hydrateMessageFragments,
} from '../utils/messageFragments.js';
import { createRunBuffer } from './streaming/runBuffer.js';
import { createMessagePatchHandlers } from './streaming/messagePatches.js';
import {
  buildHistory,
  autoRenameConversationIfNeeded,
  createFirstFrameRecorder,
} from './streaming/streamHelpers.js';

const STREAM_STALL_TIMEOUT = 60000;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'aborted']);

const isTerminalRun = (status) => TERMINAL_RUN_STATUSES.has(status);

/**
 * 模块级「当前已注册的 visibilitychange handler」引用。
 *
 * useStreaming() 在 message.store（app 级单例）里调用，其 onUnmounted 清理
 * 在 store 上永不触发。HMR 重载 store 模块时，旧实例的 cleanup 不会被调用，
 * 新实例又 addEventListener，导致 document 上监听器逐次叠加。
 *
 * 解决：每次 setupVisibilityHandler 注册前，先移除「上一次注册的 handler」。
 * 这样无论 useStreaming 被实例化多少次，document 上恒为最多一个监听器。
 */
let registeredVisibilityHandler = null;

/**
 * 更新消息对象的辅助函数
 * 用新数组替换 conv.messages（属性赋值），触发 Vue 响应式链
 *
 * 关键：按 conversationId 在调用时重新解析会话下标，不缓存 convIndex。
 * 流式过程中会话列表可能被 loadConversations / unshift 重排，缓存的下标
 * 会指向错误的会话，导致消息写进别的会话。
 *
 * 持久化交给 convStore.scheduleSaveCache()（300ms 防抖的增量保存），
 * 不再在此处对整个会话列表做 JSON.parse(JSON.stringify(...)) 全量序列化——
 * 流式每个 chunk 都触发一次会阻塞主线程。
 */
function updateMessage(convStore, conversationId, msgId, updater) {
  const convIndex = convStore.conversations.findIndex((c) => c.id === conversationId);
  if (convIndex === -1) return null;
  const conv = convStore.conversations[convIndex];
  if (!conv) return null;
  const msgs = conv.messages;
  if (!msgs) return null;
  const msgIdx = msgs.findIndex((m) => m.id === msgId);
  if (msgIdx === -1) return null;
  const updatedMsg = hydrateMessageFragments(updater(msgs[msgIdx]));
  const newMessages = msgs.map((m, i) => (i === msgIdx ? updatedMsg : m));
  // 替换 messages 属性（而非整个 conv 对象），触发 conv.messages 的响应式追踪
  conv.messages = newMessages;
  // 同步消息索引：updater 可能返回新对象（spread），需更新 map 引用
  convStore.registerMessage(conversationId, updatedMsg);
  // 防抖增量持久化（非每帧全量同步写）
  convStore.scheduleSaveCache();
  return msgIdx;
}

export function useStreaming() {
  const isLoading = ref(false);
  const currentStreamingId = ref(null);
  const isConnected = ref(true);
  const isReconnecting = ref(false);
  const reconnectAttempt = ref(0);
  // agent 决策阶段的"思考草稿"：对外仍暴露当前活跃 run 的草稿，
  // 但真实状态按 runId 存放，迟到回调不能覆盖新请求。
  const decisionDraft = ref('');
  const runsById = ref({});
  const activeRunId = ref(null);

  let currentAbortController = null;
  const controllersByRunId = new Map();
  // 当前正在流式的会话 id（响应式，供 store 层在切换会话时判断是否需中止）
  const activeStreamingConversationId = ref(null);
  let unsubscribeConnection = null;
  let visibilityHandler = null;
  // 每次 sendMessage 设置的 TTFT 首帧记录器（runBuffer 是 composable 级共享的）
  let firstFrameHandler = null;

  const getRun = (runId) => runsById.value[runId] || null;
  const patchRun = (runId, patch) => {
    const run = getRun(runId);
    if (!run) return null;
    Object.assign(run, patch);
    return run;
  };
  const isCurrentRun = (runId) => {
    const run = getRun(runId);
    return activeRunId.value === runId && !!run && !isTerminalRun(run.status);
  };
  const setRunDecisionDraft = (runId, value) => {
    const run = patchRun(runId, { decisionDraft: value });
    if (run && activeRunId.value === runId) decisionDraft.value = value;
    return run;
  };
  const clearRunDecisionDraft = (runId) => setRunDecisionDraft(runId, '');
  const finishRun = (runId, status) => {
    const run = getRun(runId);
    if (!run || isTerminalRun(run.status)) return false;
    patchRun(runId, { status, finishedAt: Date.now() });
    controllersByRunId.delete(runId);
    if (activeRunId.value === runId) {
      activeRunId.value = null;
      activeStreamingConversationId.value = null;
      currentStreamingId.value = null;
      currentAbortController = null;
      isLoading.value = false;
      isReconnecting.value = false;
      reconnectAttempt.value = 0;
      decisionDraft.value = '';
    }
    return true;
  };

  // 流式 chunk 缓冲：缓冲内容按 runId 落地为消息正文追加
  const runBuffer = createRunBuffer({
    isCurrentRun,
    applyFlush: (runId, content) => {
      const run = getRun(runId);
      if (!run) return;
      updateMessage(useConversationStore(), run.conversationId, run.assistantMessageId, (m) => {
        const newText = getMessageText(m) + content;
        return { ...m, text: newText, content: newText };
      });
    },
    onFirstFramePainted: () => firstFrameHandler?.(),
  });
  // 保留默认参数语义：缺省时作用于当前活跃 run
  const cancelPendingRaf = (flushToMessage = false, runId = activeRunId.value) => (
    runBuffer.cancelPendingRaf(flushToMessage, runId)
  );

  const abortRun = (runId = activeRunId.value, { persist = true } = {}) => {
    const run = getRun(runId);
    if (!run || isTerminalRun(run.status)) return false;
    const affectedConversationId = run.conversationId;
    clearRunDecisionDraft(runId);
    cancelPendingRaf(true, runId);
    const controller = controllersByRunId.get(runId) || currentAbortController;
    finishRun(runId, 'aborted');
    try { controller?.abort(); } catch { /* 已中止 */ }
    if (persist && affectedConversationId) {
      try {
        useConversationStore().scheduleSaveCache(true, affectedConversationId);
      } catch {
        // store 未就绪时忽略（缓存会由 beforeunload 兜底）
      }
    }
    return true;
  };

  // 后台 Tab RAF 兜底：浏览器暂停 rAF 时，当前 run 的缓冲内容立即落盘。
  const setupVisibilityHandler = () => {
    if (registeredVisibilityHandler) {
      document.removeEventListener('visibilitychange', registeredVisibilityHandler);
      registeredVisibilityHandler = null;
    }
    visibilityHandler = () => {
      if (document.visibilityState === 'hidden' && activeRunId.value) {
        cancelPendingRaf(true, activeRunId.value);
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
    registeredVisibilityHandler = visibilityHandler;
  };
  setupVisibilityHandler();

  unsubscribeConnection = connectionManager.subscribe((event) => {
    if (event === 'connected') {
      isConnected.value = true;
      isReconnecting.value = false;
      reconnectAttempt.value = 0;
    } else if (event === 'disconnected') {
      isConnected.value = false;
    }
  });

  const cleanup = () => {
    if (activeRunId.value) abortRun(activeRunId.value, { persist: false });
    for (const controller of controllersByRunId.values()) controller.abort();
    controllersByRunId.clear();
    decisionDraft.value = '';
    cancelPendingRaf();
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      if (registeredVisibilityHandler === visibilityHandler) {
        registeredVisibilityHandler = null;
      }
      visibilityHandler = null;
    }
    activeStreamingConversationId.value = null;
    currentStreamingId.value = null;
    activeRunId.value = null;
    isLoading.value = false;
    isReconnecting.value = false;
    reconnectAttempt.value = 0;
    if (unsubscribeConnection) {
      unsubscribeConnection();
      unsubscribeConnection = null;
    }
  };

  onUnmounted(() => {
    cleanup();
  });

  const sendMessage = async (text, retryMsgId = null, fileData = null, onStreamEvent) => {
    const trimmedText = text.trim();
    const convStore = useConversationStore();
    // 空消息守卫必须先于会话创建，否则空提交也会凭空生成一个「本地会话」
    if (!trimmedText && !fileData) return;
    if (isLoading.value) return;

    let conv = convStore.currentConversation;

    if (!conv) {
      // 必须用 local_ 前缀的本地会话：isLocalSession 靠前缀识别本地会话，
      // 普通 id 会被当成服务端会话反复 PUT 同步失败，且 loadConversations 合并时被静默丢弃
      conv = createLocalConversation('本地会话');
      convStore.adoptLocalConversation(conv);
    }

    const conversationId = conv.id;
    let convIndex = convStore.conversations.findIndex((c) => c.id === conversationId);
    if (convIndex === -1) {
      convStore.conversations.push({ ...conv, messages: normalizeMessages(conv.messages) });
      convIndex = convStore.conversations.findIndex((c) => c.id === conversationId);
      if (convIndex === -1) return;
    }

    let userMsg;
    if (retryMsgId) {
      const idx = convStore.conversations[convIndex].messages?.findIndex((m) => m.id === retryMsgId);
      if (idx > -1) {
        userMsg = convStore.conversations[convIndex].messages[idx];
        // 重试时移除用户消息 + 对应 AI 回复（2 条），同步清理索引
        const removedUser = convStore.conversations[convIndex].messages[idx];
        const removedAi = convStore.conversations[convIndex].messages[idx + 1];
        convStore.conversations[convIndex].messages.splice(idx, 2);
        convStore.unregisterMessage(removedUser?.id);
        convStore.unregisterMessage(removedAi?.id);
      }
    }

    if (!userMsg) {
      userMsg = hydrateMessageFragments({
        id: createMessageId(),
        role: 'user',
        content: trimmedText,
        timestamp: new Date(),
        files: fileData ? [fileData] : [],
      });
      if (!convStore.conversations[convIndex].messages) convStore.conversations[convIndex].messages = [];
      convStore.conversations[convIndex].messages.push(userMsg);
      convStore.registerMessage(conversationId, userMsg);
    } else {
      userMsg = hydrateMessageFragments(userMsg);
      convStore.conversations[convIndex].messages.push(userMsg);
      convStore.registerMessage(conversationId, userMsg);
    }
    convStore.conversations[convIndex].updatedAt = new Date();
    convStore.scheduleSaveCache(true);

    const runId = createRunId();
    const abortController = new AbortController();
    isLoading.value = true;
    decisionDraft.value = '';
    activeStreamingConversationId.value = conversationId;
    activeRunId.value = runId;
    currentAbortController = abortController;
    controllersByRunId.set(runId, abortController);

    // TTFT 埋点变量
    const streamStartTime = performance.now();
    let firstChunkReceived = false;
    firstFrameHandler = createFirstFrameRecorder(streamStartTime, text);

    const history = buildHistory(convStore.conversations[convIndex].messages || [], userMsg.id);

    const aiMsgId = createMessageId();
    const aiMsg = hydrateMessageFragments({
      id: aiMsgId,
      role: 'model',
      content: '',
      timestamp: new Date(),
      sources: [],
    });
    convStore.conversations[convIndex].messages.push(aiMsg);
    convStore.registerMessage(conversationId, aiMsg);
    currentStreamingId.value = aiMsgId;
    runsById.value[runId] = {
      runId,
      conversationId,
      userMessageId: userMsg.id,
      assistantMessageId: aiMsgId,
      attempt: 0,
      lastSeq: 0,
      status: 'connecting',
      decisionDraft: '',
      startedAt: Date.now(),
    };

    let messageToSend = trimmedText;
    if (fileData?.textContent) {
      const fileBlock = `[文件: ${fileData.name}]\n\`\`\`\n${fileData.textContent}\n\`\`\``;
      messageToSend = trimmedText
        ? `${fileBlock}\n\n用户问题: ${trimmedText}`
        : `${fileBlock}\n\n请根据以上文件内容回答。`;
    }

    // 以下九类事件都只是"整体替换/整体追加某个字段"，合并策略声明在
    // messageFragments.js::MESSAGE_EVENT_PATCH_RULES 里，新增一种同类事件
    // 只需在那张表里加一行，不必在这里再手写一个 updater。
    const patchHandlers = createMessagePatchHandlers({
      writeMessage: (convId, msgId, updater) => updateMessage(convStore, convId, msgId, updater),
      conversationId,
      aiMsgId,
      runId,
      clearRunDecisionDraft,
    });

    return new Promise((resolve, reject) => {
      let resolved = false;
      // 活动型安全超时：任何回调活动都重置计时。此前是一次性总时长定时器，
      // 会误杀健康但偏慢的流（首 token 6-8s、agent 多轮 15s/轮、重试退避累计可达 2 分钟），
      // 且触发时不中止请求——reject 后 isLoading 卡死、内容仍继续写入消息
      let safetyTimer = null;
      const armSafetyTimeout = () => {
        if (safetyTimer) clearTimeout(safetyTimer);
        safetyTimer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          if (!isCurrentRun(runId)) {
            markResolved();
            resolve();
            return;
          }
          cancelPendingRaf(true, runId);
          clearRunDecisionDraft(runId);
          finishRun(runId, 'failed');
          try { abortController.abort(); } catch { /* 已清理 */ }
          reject(new Error('响应超时，请检查网络连接后重试'));
        }, STREAM_STALL_TIMEOUT + 5000);
      };
      const markResolved = () => { resolved = true; if (safetyTimer) clearTimeout(safetyTimer); };
      armSafetyTimeout();

      const callbacks = {
        onChunk: (content, meta) => {
          // 切换会话自中止检测：用户已切到别的会话时，停止向旧会话写消息并中止请求，
          // 否则 currentStreamingId 仍指向旧会话消息，新会话 UI 状态会错乱
          if (convStore.currentConversationId !== conversationId) {
            if (import.meta.env.DEV) console.debug('[Stream] 检测到会话已切换，中止旧流式');
            abortRun(runId);
            return;
          }
          // agent 决策阶段内容 → 写入该 run 的思考草稿（不进消息正文）；
          // 直答回答也走这里，done 时转正为正文
          if (meta?.decision) {
            const nextDraft = `${getRun(runId)?.decisionDraft || ''}${content}`;
            setRunDecisionDraft(runId, nextDraft);
            onStreamEvent?.('chunk', content);
            return;
          }
          // 非 decision 内容（RAG/chat 路径或 agent 收尾生成）→ 取代草稿，进入正文
          clearRunDecisionDraft(runId);
          // 首字上屏埋点：第一个 chunk 到达时记录时间
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            const firstChunkMs = Math.round(performance.now() - streamStartTime);
            if (import.meta.env.DEV) console.debug(`[TTFT] 首字上屏(RAF前): ${firstChunkMs}ms`);
          }
          runBuffer.bufferChunk(runId, content);
          onStreamEvent?.('chunk', content);
        },
        onSources: patchHandlers.onSources,
        onIntent: patchHandlers.onIntent,
        onDecision: patchHandlers.onDecision,
        onToolCall: patchHandlers.onToolCall,
        onToolResult: patchHandlers.onToolResult,
        onTrace: patchHandlers.onTrace,
        onProcess: patchHandlers.onProcess,
        onGrounding: patchHandlers.onGrounding,
        onUsage: patchHandlers.onUsage,
        onFollowups: patchHandlers.onFollowups,
        onRetry: (nextAttempt) => {
          const currentAttempt = getRun(runId)?.attempt || 0;
          const attempt = Number.isInteger(nextAttempt) ? nextAttempt : currentAttempt + 1;
          patchRun(runId, { attempt, lastSeq: 0, status: 'retrying' });
          isReconnecting.value = true;
          reconnectAttempt.value = attempt;
          // 重试会从头开始流：清空已写入的部分内容，避免"半截+完整"重复拼接
          cancelPendingRaf(false, runId);
          // 决策草稿同理：新尝试会重新流式输出决策内容，不清空会拼接成两份
          clearRunDecisionDraft(runId);
          updateMessage(convStore, conversationId, aiMsgId, (m) => clearMessageAttemptState(m));
        },
        onDone: () => {
          cancelPendingRaf(true, runId);
          // 直答回答：决策草稿即正文，done 时转正
          const draftText = getRun(runId)?.decisionDraft || '';
          if (draftText) {
            clearRunDecisionDraft(runId);
            updateMessage(convStore, conversationId, aiMsgId, (m) => {
              const newText = getMessageText(m) + draftText;
              return { ...m, text: newText, content: newText };
            });
          }
          autoRenameConversationIfNeeded(conv, convStore, trimmedText);
          convStore.scheduleSaveCache(true);
          onStreamEvent?.('done');
          markResolved();
          resolve();
        },
        onError: (error) => {
          console.debug('[Stream] onError callback fired:', error.message);
          cancelPendingRaf(false, runId);
          clearRunDecisionDraft(runId);

          // 空内容的 AI 消息标记为错误
          updateMessage(convStore, conversationId, aiMsgId, (m) => {
            if (getMessageText(m)) return m;
            return { ...m, content: '抱歉，连接服务器失败，请检查后端服务是否启动。', isError: true };
          });
          // 用户的失败消息标记可重试
          updateMessage(convStore, conversationId, userMsg.id, (m) => ({ ...m, canRetry: true }));

          convStore.scheduleSaveCache(true);
          onStreamEvent?.('error');
          markResolved();
          resolve();
        },
        onAbort: () => {
          cancelPendingRaf(false, runId);
          clearRunDecisionDraft(runId);
          markResolved();
          resolve();
        },
      };

      callbacks.onEvent = (event) => {
        const run = getRun(runId);
        if (!run || !isCurrentRun(runId) || event?.runId !== runId) return;
        if (event.attempt !== run.attempt || event.seq <= run.lastSeq) return;
        patchRun(runId, { lastSeq: event.seq });
        dispatchRunEvent(event, {
          onStarted: () => patchRun(runId, { status: 'streaming' }),
          onChunk: (content, meta) => callbacks.onChunk(content, meta),
          onIntent: (intent) => callbacks.onIntent(intent),
          onDecision: (decision) => callbacks.onDecision?.(decision),
          onTrace: (trace) => callbacks.onTrace(trace),
          onSources: (sources) => callbacks.onSources(sources),
          onToolCall: (toolCall) => callbacks.onToolCall(toolCall),
          onToolResult: (toolResult) => callbacks.onToolResult(toolResult),
          onProcess: (processCard) => callbacks.onProcess(processCard),
          onGrounding: (grounding) => callbacks.onGrounding(grounding),
          onUsage: (usage) => callbacks.onUsage(usage),
          onFollowups: (followups) => callbacks.onFollowups(followups),
          onDone: () => callbacks.onDone(),
          onError: (error) => callbacks.onError(error),
          onUnknown: (fragment) => patchHandlers.onUnknown(fragment),
        });
      };

      const terminalStatusByCallback = {
        onDone: 'completed',
        onError: 'failed',
        onAbort: 'aborted',
      };
      // 流仍在推进时重置超时；迟到的旧 run 只能结束自己的 Promise，不能再写 UI。
      for (const key of Object.keys(callbacks)) {
        const fn = callbacks[key];
        if (typeof fn !== 'function') continue;
        callbacks[key] = (...args) => {
          if (!isCurrentRun(runId)) {
            const lateRunEventType = key === 'onEvent' ? args[0]?.type : null;
            if (terminalStatusByCallback[key] || TERMINAL_RUN_EVENT_TYPES.has(lateRunEventType)) {
              markResolved();
              resolve();
            }
            return undefined;
          }
          if (!resolved) armSafetyTimeout();
          const result = fn(...args);
          const terminalStatus = terminalStatusByCallback[key];
          if (terminalStatus) finishRun(runId, terminalStatus);
          return result;
        };
      }

      try {
        const streamPromise = sendMessageStream(messageToSend, history, callbacks, {
          signal: abortController.signal,
          conversationId,
          files: fileData ? [fileData] : [],
          runId,
          streamVersion: 1,
          attempt: 0,
        });
        if (streamPromise && typeof streamPromise.catch === 'function') {
          void streamPromise.catch((error) => callbacks.onError(error));
        }
      } catch (err) {
        if (isCurrentRun(runId)) finishRun(runId, 'failed');
        markResolved();
        reject(err);
      }
    });
  };

  const retryMessage = async (msgId) => {
    const convStore = useConversationStore();
    const conv = convStore.currentConversation;
    if (!conv) return;
    const msg = conv.messages?.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'user' || !msg.canRetry) return;
    msg.canRetry = false;
    // 带上原消息的附件：文件内容只在 fileData.textContent 里拼进请求体，
    // 丢失附件的重试等于换了一个问题再问一遍
    await sendMessage(getMessageText(msg), msgId, msg.files?.[0] || null);
  };

  /**
   * 编辑用户消息并重发：更新消息文本后复用 retry 通道
   * （sendMessage 会移除旧的用户消息+AI 回复再重新流式生成）
   */
  const editAndResendMessage = async (msgId, newText) => {
    const convStore = useConversationStore();
    const conv = convStore.currentConversation;
    const trimmed = String(newText || '').trim();
    if (!conv || !trimmed || isLoading.value) return;
    const msg = conv.messages?.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'user') return;
    msg.content = trimmed;
    msg.text = trimmed; // 兼容旧渲染字段
    await sendMessage(trimmed, msgId, msg.files?.[0] || null);
  };

  const abortCurrentRequest = () => abortRun(activeRunId.value);

  return {
    isLoading,
    currentStreamingId,
    activeStreamingConversationId,
    activeRunId,
    runsById,
    isConnected,
    isReconnecting,
    reconnectAttempt,
    decisionDraft,
    sendMessage,
    retryMessage,
    editAndResendMessage,
    abortCurrentRequest,
    abortRun,
    cleanup,
  };
}
