"use strict";

/**
 * 路由分类的唯一事实来源。
 *
 * 此前 `ROUTE_MAP`（intent-router：意图 → 路由）与 `ROUTE_TO_INTENT`（jev-decision：
 * 路由 → 意图）是两份互相反向的字符串表，靠字面量耦合 —— 任一侧改名都会静默
 * 产生 undefined 路由。这里合并为单一常量，两侧都从它派生。
 */

const INTENT_TYPES = Object.freeze({
  KNOWLEDGE_QUERY: "knowledge_query", // 校内知识问答 → rag
  GENERAL_CHAT: "general_chat",       // 普通闲聊 → chat
  COMPLEX_TASK: "complex_task",       // 多步/复合任务 → agent
  CALCULATION_TASK: "calculation_task", // 明确数学计算 → agent/calculate
});

const ROUTES = Object.freeze({
  chat: { intent: INTENT_TYPES.GENERAL_CHAT, description: "普通对话" },
  rag: { intent: INTENT_TYPES.KNOWLEDGE_QUERY, description: "知识库检索" },
  agent: { intent: INTENT_TYPES.COMPLEX_TASK, description: "多步任务" },
});

const ROUTE_NAMES = Object.freeze(Object.keys(ROUTES));
const ALLOWED_ROUTES = new Set(ROUTE_NAMES);

// 计算任务复用 agent 链路，单独列出是为了保留 fastRoute 原有的 intent 语义
const INTENT_ROUTE_OVERRIDES = Object.freeze({
  [INTENT_TYPES.CALCULATION_TASK]: "agent",
});

const routeOfIntent = (intent) => {
  if (INTENT_ROUTE_OVERRIDES[intent]) return INTENT_ROUTE_OVERRIDES[intent];
  const entry = ROUTE_NAMES.find((route) => ROUTES[route].intent === intent);
  return entry || "chat";
};

const intentOfRoute = (route) => ROUTES[route]?.intent || INTENT_TYPES.GENERAL_CHAT;

const isAllowedRoute = (route) => ALLOWED_ROUTES.has(route);

const normalizeIntent = (intent) => (
  Object.values(INTENT_TYPES).includes(intent) ? intent : null
);

module.exports = {
  INTENT_TYPES,
  ROUTES,
  ROUTE_NAMES,
  ALLOWED_ROUTES,
  routeOfIntent,
  intentOfRoute,
  isAllowedRoute,
  normalizeIntent,
};
