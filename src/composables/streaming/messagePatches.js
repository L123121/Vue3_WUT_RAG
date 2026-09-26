// ==================== 流式事件 → 消息字段补丁 ====================
// SSE 各类事件大多只是"整体替换/整体追加消息的某个字段"，补丁策略声明在
// messageFragments.js::MESSAGE_EVENT_PATCH_RULES，这里集中生成对应的回调。
// 从 useStreaming.js 拆出，新增同类事件只需在 PATCH_RULES 表加行。

import { patchMessageForEvent, appendUnknownMessageFragment } from '../../utils/messageFragments.js';

/**
 * @param {Object} deps
 * @param {(conversationId: string, msgId: string, updater: (m: object) => object) => any} deps.writeMessage
 *        写消息的统一入口（useStreaming 的 updateMessage）
 * @param {string} deps.conversationId 当前流式目标会话
 * @param {string} deps.aiMsgId 助手消息 ID
 * @param {string} deps.runId 当前 run（onToolCall 需要收起草稿）
 * @param {() => void} deps.clearRunDecisionDraft
 */
export function createMessagePatchHandlers({ writeMessage, conversationId, aiMsgId, runId, clearRunDecisionDraft }) {
  return {
    onSources: (sources) => {
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'sources', sources));
    },
    onIntent: (intent) => {
      // V2.0 自动路由：记录后端意图识别结果，前端展示"自动路由：知识库检索"等
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'intent', intent));
    },
    onDecision: (decision) => {
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'decision', decision));
    },
    onToolCall: (toolCall) => {
      // 决策草稿被工具调用取代 → 收起该 run 的草稿，前端展示过程卡片
      clearRunDecisionDraft(runId);
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'toolCall', toolCall));
    },
    onToolResult: (toolResult) => {
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'toolResult', toolResult));
    },
    onProcess: (processCard) => {
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'processCard', processCard));
    },
    onGrounding: (grounding) => {
      // 运行时引用校验：溯源覆盖率随收尾下发，MessageBubble 展示"已溯源 xx%"徽标
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'grounding', grounding));
    },
    onUsage: (usage) => {
      // token 用量随收尾下发，MessageBubble 展示输入/输出 token
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'usage', usage));
    },
    onFollowups: (items) => {
      // 追问建议随收尾下发，MessageBubble 渲染为可点击 chips
      writeMessage(conversationId, aiMsgId, (m) => patchMessageForEvent(m, 'followups', items));
    },
    onTrace: (payload) => {
      // agent/agenticRag：Agent 链路的轮次/工具/收尾原因 trace（兼容字段仍共用 ragTrace，
      // Fragment hydration 根据 finishReason 区分 Agent 与 RAG 渲染）
      const trace = payload?.agent || payload?.agenticRag || payload?.trace || null;
      const rag = payload?.rag || trace?.outcome || {};
      const usedRag = rag.usedRag === true;
      const incomingTraceId = payload?.traceId || trace?.traceId || '';
      writeMessage(conversationId, aiMsgId, (m) => {
        const traceId = incomingTraceId || m.traceId;
        const traceWithIdentity = trace ? { ...trace, traceId } : m.ragTrace;
        return {
          ...m,
          traceId,
          ragTrace: traceWithIdentity,
          ...(usedRag ? { answerMode: 'rag', usedRag: true } : {}),
        };
      });
    },
    onUnknown: ({ type, data, origin }) => {
      writeMessage(conversationId, aiMsgId, (m) => appendUnknownMessageFragment(m, { type, data, origin }));
    },
  };
}
