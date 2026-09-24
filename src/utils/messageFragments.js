export const MESSAGE_FRAGMENT_VERSION = 1;

export const MESSAGE_FRAGMENT_TYPES = Object.freeze({
  ATTACHMENTS: 'attachments',
  TEXT: 'text',
  PROCESS_CARD: 'process-card',
  DECISION_BADGE: 'decision-badge',
  INTENT_BADGE: 'intent-badge',
  GROUNDING_BADGE: 'grounding-badge',
  USAGE: 'usage',
  FOLLOWUPS: 'followups',
  AGENT_TOOLS: 'agent-tools',
  RETRIEVAL_TRACE: 'retrieval-trace',
  FALLBACK_GUIDANCE: 'fallback-guidance',
  // 瞬态：agent 决策阶段的思考草稿，只在 MessageFragmentRenderer 渲染时合成，
  // 不经 hydrateMessageFragments 派生、不持久化进 message.fragments / 缓存。
  DECISION_DRAFT: 'decision-draft',
  UNKNOWN: 'unknown',
});

const KNOWN_FRAGMENT_TYPES = new Set(Object.values(MESSAGE_FRAGMENT_TYPES));

// 决策定性了路由，放在 process-card 之后、intent-badge 之前：
// 一次问答的"元信息"顺序是 先决策 → 再路由 → 再检索质量/用量。
const KNOWN_FRAGMENT_ORDER = [
  MESSAGE_FRAGMENT_TYPES.ATTACHMENTS,
  MESSAGE_FRAGMENT_TYPES.TEXT,
  MESSAGE_FRAGMENT_TYPES.PROCESS_CARD,
  MESSAGE_FRAGMENT_TYPES.DECISION_BADGE,
  MESSAGE_FRAGMENT_TYPES.INTENT_BADGE,
  MESSAGE_FRAGMENT_TYPES.GROUNDING_BADGE,
  MESSAGE_FRAGMENT_TYPES.USAGE,
  MESSAGE_FRAGMENT_TYPES.FOLLOWUPS,
  MESSAGE_FRAGMENT_TYPES.AGENT_TOOLS,
  MESSAGE_FRAGMENT_TYPES.RETRIEVAL_TRACE,
  MESSAGE_FRAGMENT_TYPES.FALLBACK_GUIDANCE,
];

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const messageText = (message) => String(
  message?.content ?? message?.text ?? message?.message ?? ''
).trim();

const stableStringify = (value) => {
  try {
    return JSON.stringify(value) || '';
  } catch {
    return String(value ?? '');
  }
};

const fingerprint = (value) => {
  const text = stableStringify(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
};

const normalizeFragmentId = (value, fallback) => {
  const id = String(value || '').trim().slice(0, 160);
  return id || fallback;
};

const normalizeUnknownFragment = (fragment, index) => {
  const raw = asObject(fragment);
  const originalType = String(raw.originalType || raw.type || 'unknown').trim().slice(0, 120) || 'unknown';
  return {
    ...raw,
    id: normalizeFragmentId(raw.id, `unknown:${index}:${originalType}`),
    type: MESSAGE_FRAGMENT_TYPES.UNKNOWN,
    originalType,
    data: raw.data ?? null,
    origin: asObject(raw.origin),
    revision: raw.revision || fingerprint({ originalType, data: raw.data, origin: raw.origin }),
  };
};

export const normalizeMessageFragment = (fragment, index = 0) => {
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) return null;
  const raw = asObject(fragment);
  const type = String(raw.type || '').trim();
  if (!type || type === MESSAGE_FRAGMENT_TYPES.UNKNOWN || !KNOWN_FRAGMENT_TYPES.has(type)) {
    return normalizeUnknownFragment(raw, index);
  }
  return {
    ...raw,
    id: normalizeFragmentId(raw.id, `fragment:${type}`),
    type,
    ref: raw.ref || '',
    revision: raw.revision || fingerprint(raw.data ?? raw.ref ?? type),
  };
};

const getExistingFragments = (message) => {
  const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
  return fragments
    .map((fragment, index) => normalizeMessageFragment(fragment, index))
    .filter(Boolean);
};

export const isAgentTrace = (trace) => Boolean(
  trace
  && typeof trace === 'object'
  && typeof trace.finishReason === 'string'
);

export const shouldShowFallbackGuidance = (message) => {
  if (message?.role !== 'model' || message?.isError || !messageText(message)) return false;
  if (Array.isArray(message?.sources) && message.sources.length > 0) return false;
  return message?.ragTrace?.status === 'fallback'
    || message?.ragTrace?.outcome?.fallbackReason === 'no_reliable_sources'
    || message?.ragTrace?.fallbackReason === 'no_reliable_sources';
};

const getKnownFragmentValues = (message) => ({
  [MESSAGE_FRAGMENT_TYPES.ATTACHMENTS]: Array.isArray(message.files) && message.files.length > 0 ? message.files : null,
  [MESSAGE_FRAGMENT_TYPES.TEXT]: messageText(message) || null,
  [MESSAGE_FRAGMENT_TYPES.PROCESS_CARD]: message.processCard || null,
  [MESSAGE_FRAGMENT_TYPES.DECISION_BADGE]: message.decision || null,
  [MESSAGE_FRAGMENT_TYPES.INTENT_BADGE]: message.intent || null,
  [MESSAGE_FRAGMENT_TYPES.GROUNDING_BADGE]: message.grounding || null,
  [MESSAGE_FRAGMENT_TYPES.USAGE]: message.usage || null,
  [MESSAGE_FRAGMENT_TYPES.FOLLOWUPS]: Array.isArray(message.followups) && message.followups.length > 0 ? message.followups : null,
  [MESSAGE_FRAGMENT_TYPES.AGENT_TOOLS]: (
    (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
    || (Array.isArray(message.toolResults) && message.toolResults.length > 0)
    || isAgentTrace(message.ragTrace)
  ) ? {
    toolCalls: message.toolCalls || [],
    toolResults: message.toolResults || [],
    trace: isAgentTrace(message.ragTrace) ? message.ragTrace : null,
  } : null,
  [MESSAGE_FRAGMENT_TYPES.RETRIEVAL_TRACE]: message.ragTrace && !isAgentTrace(message.ragTrace)
    ? message.ragTrace
    : null,
  [MESSAGE_FRAGMENT_TYPES.FALLBACK_GUIDANCE]: shouldShowFallbackGuidance(message) ? { fallback: true } : null,
});

const createKnownFragment = (type, value, existing) => {
  const previous = existing || {};
  return {
    ...previous,
    id: normalizeFragmentId(previous.id, `fragment:${type}`),
    type,
    ref: type,
    revision: `${type}:${fingerprint(value)}`,
  };
};

/**
 * 为历史消息与实时消息生成同一套可渲染 fragment 描述。
 * 已知 fragment 只引用兼容字段，避免把正文、来源和 trace 再复制一份到缓存。
 */
export const hydrateMessageFragments = (message = {}) => {
  const existing = getExistingFragments(message);
  const existingKnown = new Map();
  const unknown = [];

  for (const fragment of existing) {
    if (fragment.type === MESSAGE_FRAGMENT_TYPES.UNKNOWN) unknown.push(fragment);
    else if (!existingKnown.has(fragment.type)) existingKnown.set(fragment.type, fragment);
  }

  const values = getKnownFragmentValues(message);
  const known = KNOWN_FRAGMENT_ORDER
    .filter((type) => values[type])
    .map((type) => createKnownFragment(type, values[type], existingKnown.get(type)));

  return {
    ...message,
    fragmentVersion: MESSAGE_FRAGMENT_VERSION,
    fragments: [...known, ...unknown],
  };
};

export const patchMessageWithFragments = (message, patch = {}) => hydrateMessageFragments({
  ...message,
  ...patch,
});

/**
 * 决策思考草稿：run 级瞬态展示，done/tool_call 后即被清空，从不写入
 * message.decision 或 message.fragments，因此单独走合成函数而不进
 * getKnownFragmentValues() 的派生管线——避免瞬态文本被当作持久化内容缓存。
 */
export const DECISION_DRAFT_FRAGMENT_ID = 'decision-draft:live';

export const createDecisionDraftFragment = (text) => ({
  id: DECISION_DRAFT_FRAGMENT_ID,
  type: MESSAGE_FRAGMENT_TYPES.DECISION_DRAFT,
  ref: 'decision-draft',
  revision: `decision-draft:${fingerprint(text)}`,
  data: { text },
});

/**
 * 字段级合并策略：把"新增一种内容类型"从"在 useStreaming.js 里手写一段
 * object-spread 合并代码"降级为"声明一条 { field, strategy, extra } 规则"。
 * replace  用 ?? 兜底旧值（对象/数组恒真，等价于原来的 `x || m.x`）
 * append   累加进数组（工具调用/结果类事件）
 */
export const FIELD_MERGE_STRATEGIES = Object.freeze({
  replace: (prev, next) => next ?? prev,
  append: (prev, next) => [...(Array.isArray(prev) ? prev : []), next],
});

export const applyFieldPatch = (message, field, value, strategy = 'replace') => {
  const merge = FIELD_MERGE_STRATEGIES[strategy] || FIELD_MERGE_STRATEGIES.replace;
  return { ...message, [field]: merge(message[field], value) };
};

/**
 * RunEvent 事件名 → message 字段合并规则。新增一种"整体替换/整体追加"型
 * 内容时，只需在这里补一行；不再需要在 useStreaming.js 里为它手写 updater。
 * onTrace 等带分支判断（channel 识别、usedRag 推断）的事件不纳入，
 * 保留在 useStreaming.js 本地处理，避免把判断逻辑硬塞进声明式规则。
 */
export const MESSAGE_EVENT_PATCH_RULES = Object.freeze({
  sources: { field: 'sources', strategy: 'replace', extra: { answerMode: 'rag', usedRag: true } },
  intent: { field: 'intent', strategy: 'replace' },
  decision: { field: 'decision', strategy: 'replace' },
  processCard: { field: 'processCard', strategy: 'replace' },
  grounding: { field: 'grounding', strategy: 'replace' },
  usage: { field: 'usage', strategy: 'replace' },
  followups: { field: 'followups', strategy: 'replace' },
  toolCall: { field: 'toolCalls', strategy: 'append', extra: { answerMode: 'agent' } },
  toolResult: { field: 'toolResults', strategy: 'append' },
});

export const patchMessageForEvent = (message, eventName, value) => {
  const rule = MESSAGE_EVENT_PATCH_RULES[eventName];
  if (!rule) return message;
  const patched = applyFieldPatch(message, rule.field, value, rule.strategy);
  return rule.extra ? { ...patched, ...rule.extra } : patched;
};

export const appendUnknownMessageFragment = (message, { type, data, origin } = {}) => {
  const hydrated = hydrateMessageFragments(message);
  const originalType = String(type || 'unknown').slice(0, 120) || 'unknown';
  const safeOrigin = asObject(origin);
  const id = normalizeFragmentId(
    safeOrigin.seq !== undefined
      ? `unknown:${safeOrigin.attempt ?? 0}:${safeOrigin.seq}:${originalType}`
      : `unknown:${originalType}:${hydrated.fragments.length}`,
    `unknown:${hydrated.fragments.length}`
  );
  const fragment = normalizeUnknownFragment({
    id,
    type: MESSAGE_FRAGMENT_TYPES.UNKNOWN,
    originalType,
    data: data ?? null,
    origin: safeOrigin,
  }, hydrated.fragments.length);
  const index = hydrated.fragments.findIndex((item) => item.id === fragment.id);
  const fragments = index === -1
    ? [...hydrated.fragments, fragment]
    : hydrated.fragments.map((item, itemIndex) => (itemIndex === index ? fragment : item));
  return {
    ...hydrated,
    fragments,
  };
};

/**
 * 重试必须清掉上一次尝试产生的全部派生展示状态，避免旧工具卡/trace 与新正文混排。
 */
export const clearMessageAttemptState = (message = {}) => hydrateMessageFragments({
  ...message,
  content: '',
  text: '',
  sources: [],
  intent: null,
  decision: null,
  toolCalls: [],
  toolResults: [],
  processCard: null,
  ragTrace: null,
  traceId: '',
  grounding: null,
  usage: null,
  followups: [],
  answerMode: '',
  usedRag: false,
  fragments: [],
});

export const getMessageFragments = (message) => hydrateMessageFragments(message).fragments;

export const getMessageFragmentSignature = (message) => getMessageFragments(message)
  .map((fragment) => `${fragment.id}:${fragment.type}:${fragment.revision || ''}`)
  .join('|');

export const hasRenderableMessageContent = (message) => (
  message?.id !== 'welcome'
  && (messageText(message).length > 0 || getMessageFragments(message).length > 0)
);

export const toLlmHistoryMessage = (message) => {
  if (!message || message.id === 'welcome' || message.isError) return null;
  const content = messageText(message);
  if (!content) return null;
  const role = message.role === 'model' || message.role === 'assistant'
    ? 'assistant'
    : message.role === 'user'
      ? 'user'
      : null;
  return role ? { role, content } : null;
};

export const mergeMessageRecords = (first, second) => {
  const firstMessage = hydrateMessageFragments(first || {});
  const secondMessage = hydrateMessageFragments(second || {});
  const score = (message) => {
    const unknownCount = message.fragments.filter((fragment) => fragment.type === MESSAGE_FRAGMENT_TYPES.UNKNOWN).length;
    const knownCount = message.fragments.length - unknownCount;
    return (unknownCount * 100) + (knownCount * 10) + messageText(message).length;
  };
  const rich = score(firstMessage) >= score(secondMessage) ? firstMessage : secondMessage;
  const other = rich === firstMessage ? secondMessage : firstMessage;
  return hydrateMessageFragments({
    ...other,
    ...rich,
    fragments: rich.fragments.length >= other.fragments.length ? rich.fragments : other.fragments,
  });
};

export const mergeMessageLists = (local = [], remote = []) => {
  const localList = Array.isArray(local) ? local.map(hydrateMessageFragments) : [];
  const remoteList = Array.isArray(remote) ? remote.map(hydrateMessageFragments) : [];
  const primary = localList.length > remoteList.length ? localList : remoteList;
  const secondary = primary === localList ? remoteList : localList;
  const secondaryById = new Map(secondary.filter((message) => message.id).map((message) => [message.id, message]));
  return primary.map((message) => {
    const peer = secondaryById.get(message.id);
    return peer ? mergeMessageRecords(message, peer) : message;
  });
};
