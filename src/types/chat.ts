/**
 * 聊天消息与消息 Fragment 的类型契约。
 *
 * 形状来源：src/utils/messageFragments.js（fragment 协议 v1）与
 * src/components/chat/messageFragmentRegistry.js。消息对象在流式过程中
 * 会被整体替换式补丁扩展，这里声明已知的稳定字段，未登记字段走索引签名。
 */

export type MessageRole = 'user' | 'model' | 'system';

/** messageFragmentRegistry 中登记的全部 fragment 类型（MESSAGE_FRAGMENT_TYPES 的值） */
export type MessageFragmentType =
  | 'attachments'
  | 'text'
  | 'process-card'
  | 'decision-badge'
  | 'intent-badge'
  | 'grounding-badge'
  | 'usage'
  | 'followups'
  | 'agent-tools'
  | 'retrieval-trace'
  | 'fallback-guidance'
  | 'decision-draft'
  | 'unknown';

/** 单个渲染片段；data 形状由 registry 中对应组件的 props 决定 */
export interface MessageFragment {
  id?: string;
  type: MessageFragmentType;
  data?: Record<string, unknown>;
  /** UNKNOWN 片段保留的原始事件类型，便于诊断 */
  originalType?: string;
  /** 兼容字段：历史上直接挂载在片段上的数据 */
  [key: string]: unknown;
}

/** 来源引用（RAG 检索 / Wiki 词条 / Agent 工件） */
export interface SourceRef {
  id?: string;
  docId?: string;
  title?: string;
  category?: string;
  slug?: string;
  score?: number;
  sourceType?: 'wiki' | 'qdrant' | 'artifact' | string;
  stale?: boolean;
  snippet?: string;
  [key: string]: unknown;
}

/** 聊天附件（上传后含 attachmentId 与归属元数据） */
export interface MessageFile {
  name?: string;
  size?: number;
  type?: string;
  /** 已解析出的文件文本内容（拼进请求体的部分） */
  textContent?: string | null;
  attachmentId?: string;
  url?: string;
  [key: string]: unknown;
}

/** LLM token 用量（随收尾事件下发） */
export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

/** Agent / RAG 执行轨迹（agent 与 RAG 共用 ragTrace 字段，按 finishReason 区分渲染） */
export interface RunTrace {
  traceId?: string;
  finishReason?: string;
  outcome?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 聊天消息。流式期间字段由 messagePatches / patchMessageForEvent 整体替换，
 * 所有事件字段均为可选；未登记的动态字段（历史遗留字段、实验字段）走索引签名。
 */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** 正文（规范字段） */
  content?: string | null;
  /** 渲染别名（旧字段，与 content 同步写入） */
  text?: string;
  message?: string;
  timestamp?: string | number | Date;
  files?: MessageFile[] | null;
  sources?: SourceRef[] | null;
  fragments?: MessageFragment[];
  /** 事件整体替换字段（形状由对应 Fragment 组件消费） */
  decision?: Record<string, unknown>;
  intent?: Record<string, unknown>;
  grounding?: Record<string, unknown> | null;
  usage?: UsageInfo | null;
  followups?: unknown[];
  toolCalls?: unknown[] | null;
  toolResults?: unknown[] | null;
  ragTrace?: RunTrace | null;
  processCard?: Record<string, unknown> | null;
  /** 运行状态 */
  isError?: boolean;
  canRetry?: boolean;
  traceId?: string;
  answerMode?: string;
  usedRag?: boolean;
  [key: string]: unknown;
}
