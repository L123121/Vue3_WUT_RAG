// ==================== 单次流式调用的 Promise 装配 ====================
// 从 useStreaming.js 的 sendMessage 拆出：活动型安全超时、13 个回调表、
// 迟到回调守卫包装、sendMessageStream 的调用与兜底 catch。
// 逻辑为逐字迁移（非重写），行为由 useStreaming.test.js 的黑盒用例锁定。
// useStreaming.js 只负责"准备这一次调用的上下文"，本模块负责"驱动它直到收敛"。

import { sendMessageStream } from '../../api/chat.js';
import {
  dispatchRunEvent,
  TERMINAL_RUN_EVENT_TYPES,
} from '../../utils/runEvents.js';
import { clearMessageAttemptState } from '../../utils/messageFragments.js';
import { getMessageText } from '../../utils/chatHelpers.js';
import { autoRenameConversationIfNeeded } from './streamHelpers.js';
import {
  STREAM_STALL_GRACE_MS,
  STREAM_STALL_TIMEOUT,
} from '../../utils/streamConstants.js';

/**
 * 发起一次流式请求并驱动到终态（done/error/abort/超时）。
 *
 * @param {Object} deps sendMessage 装配好的本次调用上下文
 * @param {string} deps.runId 本次 run 的 id
 * @param {Object} deps.convStore 会话 store 实例
 * @param {string} deps.conversationId 目标会话 id
 * @param {string} deps.aiMsgId AI 消息 id
 * @param {string} deps.userMsgId 用户消息 id
 * @param {Object} deps.conv 会话对象（自动命名用）
 * @param {string} deps.trimmedText 用户原始文本（自动命名用）
 * @param {string} deps.messageToSend 发送的消息体（含附件文本块）
 * @param {Array} deps.history 构建好的历史
 * @param {Object|null} deps.fileData 附件数据
 * @param {Function} [deps.onStreamEvent] 外部事件监听（chunk/done/error）
 * @param {number} deps.streamStartTime 流起始时间（TTFT 埋点）
 * @param {Object} deps.abortController 本次请求的 AbortController
 * @param {Object} deps.isReconnecting 重连状态 ref
 * @param {Object} deps.reconnectAttempt 重试计数 ref
 * @param {Object} deps.runBuffer RAF 合并缓冲
 * @param {Object} deps.patchHandlers 字段补丁回调集（streaming/messagePatches）
 * @param {Object} deps.patchHandlers.onUnknown 未知事件兜底
 * @param {Function} deps.getRun / deps.patchRun / deps.isCurrentRun / deps.finishRun
 * @param {Function} deps.setRunDecisionDraft / deps.clearRunDecisionDraft
 * @param {Function} deps.cancelPendingRaf / deps.abortRun
 * @param {Function} deps.updateMessage 写消息的辅助函数
 * @returns {Promise<void>} 流收敛后 resolve；超时/同步异常 reject
 */
export function createStreamInvocation({
  runId,
  convStore,
  conversationId,
  aiMsgId,
  userMsgId,
  conv,
  trimmedText,
  messageToSend,
  history,
  fileData,
  onStreamEvent,
  streamStartTime,
  abortController,
  isReconnecting,
  reconnectAttempt,
  runBuffer,
  patchHandlers,
  getRun,
  patchRun,
  isCurrentRun,
  finishRun,
  setRunDecisionDraft,
  clearRunDecisionDraft,
  cancelPendingRaf,
  abortRun,
  updateMessage,
}) {
  let firstChunkReceived = false;

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
      }, STREAM_STALL_TIMEOUT + STREAM_STALL_GRACE_MS);
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
        updateMessage(convStore, conversationId, userMsgId, (m) => ({ ...m, canRetry: true }));

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
}
