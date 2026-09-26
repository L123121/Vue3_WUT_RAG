// ==================== 流式 chunk 的 RAF 合并缓冲 ====================
// 高频 SSE 增量不逐条写响应式消息，而是进缓冲、每帧合并写一次 DOM。
// 从 useStreaming.js 拆出的纯机制模块：只管缓冲与帧调度，不知道消息与会话结构。

/**
 * @param {Object} deps
 * @param {(runId: string) => boolean} deps.isCurrentRun 该 run 是否仍是当前活跃 run
 * @param {(runId: string, content: string) => void} deps.applyFlush 冲刷落地：把 content 写进消息正文
 * @param {() => void} [deps.onFirstFramePainted] 第一次真正执行 RAF 回调（即将写 DOM）时触发，供 TTFT 埋点
 */
export function createRunBuffer({ isCurrentRun, applyFlush, onFirstFramePainted }) {
  let rafId = null;
  let pendingContent = '';
  let pendingRunId = null;

  const clear = (runId) => {
    if (pendingRunId === runId) {
      pendingContent = '';
      pendingRunId = null;
    }
  };

  const flushPendingContent = (runId) => {
    if (!runId || pendingRunId !== runId || !pendingContent) return false;
    // 被中止或替换的旧 run 不得消费新 run 的共享缓冲
    if (!isCurrentRun(runId)) {
      clear(runId);
      return false;
    }
    const content = pendingContent;
    clear(runId);
    applyFlush(runId, content);
    return true;
  };

  /** 追加 chunk 内容并保证本帧只调度一次 RAF */
  const bufferChunk = (runId, content) => {
    pendingRunId = runId;
    pendingContent += content;
    if (rafId) return;
    const scheduledRunId = runId;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!isCurrentRun(scheduledRunId)) {
        if (pendingRunId === scheduledRunId) clear(scheduledRunId);
        return;
      }
      // RAF 回调执行 = 真正写 DOM 的时刻
      onFirstFramePainted?.();
      flushPendingContent(scheduledRunId);
    });
  };

  /**
   * 取消待执行的帧。flushToMessage=true 时把缓冲内容立即落盘（onDone/后台 Tab 等收尾场景），
   * 否则直接丢弃（onRetry 重发场景，避免"半截+完整"重复拼接）。
   */
  const cancelPendingRaf = (flushToMessage = false, runId = null) => {
    if (rafId && pendingRunId === runId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (flushToMessage) flushPendingContent(runId);
    clear(runId);
  };

  return { bufferChunk, flushPendingContent, cancelPendingRaf };
}
