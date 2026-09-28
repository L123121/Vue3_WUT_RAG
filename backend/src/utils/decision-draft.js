"use strict";

/**
 * 决策草稿（decision draft）协议 —— 单一实现。
 *
 * Agent 在决策阶段会实时吐出"思考文本"（content 带 decision:true 标记）：
 * - 若模型随后发起 tool_call，这段文本是被废弃的草稿，必须丢弃；
 * - 若模型直接回答（无 tool_call），这段文本就是最终回答。
 *
 * 这条"累积 → 遇 tool_call 作废 → 无 tool_call 时转正"的状态机此前在
 * chat.controller / agent.service(非流式 drain) / conversation-orchestrator
 * 里各写了一份，三处必须保持一致否则会出现"草稿混入正文"或"正文被误删"。
 * 抽成纯函数后只有一份实现，且可单测。
 */

const emptyDraft = () => ({ pending: "", reply: "" });

/**
 * 累积一条 content 事件。
 * @param {{pending:string, reply:string}} draft
 * @param {{content?:string, decision?:boolean, done?:boolean}} event
 */
function accumulate(draft = emptyDraft(), event = {}) {
  if (event?.done) return draft;
  const text = String(event?.content || "");
  if (!text) return draft;
  if (event?.decision) return { ...draft, pending: `${draft.pending}${text}` };
  // 非 decision 内容（真正开始回答）→ 取代草稿
  return { ...draft, pending: "", reply: `${draft.reply}${text}` };
}

/** tool_call 出现 → 草稿作废（不计入最终回答） */
function discard(draft = emptyDraft()) {
  return draft.pending ? { ...draft, pending: "" } : draft;
}

/** 收尾：未作废的草稿转为正文（直答场景） */
function finalize(draft = emptyDraft()) {
  if (!draft.pending) return draft;
  return { pending: "", reply: `${draft.reply}${draft.pending}` };
}

/**
 * 事件流便捷入口：按事件类型分派。
 * 返回新 draft 对象（不原地修改），便于在 for-await 里逐事件累积。
 */
function applyEvent(draft, event) {
  if (!event) return draft;
  if (event.type === "tool_call") return discard(draft);
  if (event.type === "content") return accumulate(draft, event);
  return draft;
}

module.exports = {
  emptyDraft,
  accumulate,
  discard,
  finalize,
  applyEvent,
};
