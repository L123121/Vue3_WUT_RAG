/**
 * SSE 流式请求的回调契约。
 *
 * 形状来源：src/api/chat.js sendMessageStream 第三参数（useStreaming.js 是唯一
 * 全量消费方）。onEvent 与具体回调二选一或并用：onEvent 收到原始 RunEvent，
 * 由 dispatchRunEvent 投影到具体回调。
 */

import type { RunEvent } from './runEvents';
import type { SourceRef, UsageInfo } from './chat';

/** onChunk 元信息：decision=true 表示 agent 决策阶段思考草稿（不进正文） */
export interface StreamChunkMeta {
  decision?: boolean;
  [key: string]: unknown;
}

/** sendMessageStream 请求选项（第四参数） */
export interface StreamRequestOptions {
  signal?: AbortSignal;
  conversationId?: string;
  files?: Array<Record<string, unknown>> | null;
  runId?: string;
  streamVersion?: number;
  attempt?: number;
  [key: string]: unknown;
}

export interface StreamCallbacks {
  /** 增量正文/草稿内容 */
  onChunk?: (content: string, meta?: StreamChunkMeta) => void;
  onSources?: (sources: SourceRef[]) => void;
  onIntent?: (intent: Record<string, unknown>) => void;
  onDecision?: (decision: Record<string, unknown>) => void;
  onToolCall?: (toolCall: unknown) => void;
  onToolResult?: (toolResult: unknown) => void;
  /** agent/agenticRag/rag 三条链路的 trace（channel 区分） */
  onTrace?: (payload: Record<string, unknown>) => void;
  onProcess?: (processCard: Record<string, unknown>) => void;
  onGrounding?: (grounding: Record<string, unknown> | null) => void;
  onUsage?: (usage: UsageInfo | null) => void;
  onFollowups?: (items: unknown[]) => void;
  /** 连接重试（后端断线重连）；从头重发流，前端需清空半截内容 */
  onRetry?: (attempt: number) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
  onAbort?: () => void;
  /** 原始 RunEvent 分发入口（与具体回调并存） */
  onEvent?: (event: RunEvent) => void;
}
