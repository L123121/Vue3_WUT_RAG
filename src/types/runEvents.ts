/**
 * RunEvent v1 协议类型契约。
 *
 * 形状来源：src/utils/runEvents.js（isRunEventV1 校验器与 dispatchRunEvent 分发表）
 * 与后端 backend/src/utils/sse-events.js。事件按 (runId, attempt, seq) 排序去重，
 * 消费端通过 dispatchRunEvent 投影到 UI 回调。
 */

import type { SourceRef, RunTrace, UsageInfo } from './chat';

/** RUN_EVENT_TYPES 登记的协议事件类型；未登记类型走 `(string & {})` 保留补全 */
export type RunEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'message.delta'
  | 'intent'
  | 'decision.applied'
  | 'decision.fallback'
  | 'retrieval'
  | 'sources'
  | 'tool.call'
  | 'tool.result'
  | 'process'
  | 'trace'
  | 'grounding'
  | 'usage'
  | 'followups'
  | (string & {});

/** 单条协议事件：v/runId/attempt/seq/type/data 缺一不可（isRunEventV1 校验） */
export interface RunEvent<TData extends Record<string, unknown> = Record<string, unknown>> {
  v: 1;
  runId: string;
  attempt: number;
  seq: number;
  type: RunEventType;
  traceId?: string;
  data: TData;
}

/** message.delta 事件负载 */
export interface MessageDeltaData extends Record<string, unknown> {
  content?: string;
  /** true 表示 agent 决策阶段的思考草稿（不进消息正文） */
  decision?: boolean;
}

/** sources 事件负载 */
export interface SourcesData extends Record<string, unknown> {
  sources?: SourceRef[];
}

/** trace 事件负载：channel 区分 Agent / Agentic RAG / RAG 三条链路 */
export interface TraceData extends Record<string, unknown> {
  channel?: 'agent' | 'agentic_rag' | 'rag' | string;
  trace?: RunTrace;
  retrieval?: Record<string, unknown>;
}

/** run.failed 事件负载 */
export interface RunFailedData extends Record<string, unknown> {
  message?: string;
  code?: string;
}

/** 未知类型事件的投影（onUnknown 回调入参） */
export interface UnknownEventFragment {
  type: string;
  data: Record<string, unknown>;
  origin: {
    attempt: number;
    seq: number;
    traceId?: string;
  };
}

/** dispatchRunEvent 的回调映射（全部可选） */
export interface RunEventHandlerMap {
  onStarted?: (event: RunEvent) => void;
  onChunk?: (content: string, meta: { decision: boolean }, event: RunEvent<MessageDeltaData>) => void;
  onIntent?: (intent: Record<string, unknown>, event: RunEvent) => void;
  onDecision?: (decision: Record<string, unknown>, event: RunEvent) => void;
  onTrace?: (payload: { traceId?: string; agent?: RunTrace; agenticRag?: RunTrace; rag?: Record<string, unknown>; retrieval?: Record<string, unknown> }, event: RunEvent) => void;
  onSources?: (sources: SourceRef[], event: RunEvent<SourcesData>) => void;
  onToolCall?: (toolCall: unknown, event: RunEvent) => void;
  onToolResult?: (toolResult: unknown, event: RunEvent) => void;
  onProcess?: (processCard: Record<string, unknown> | null, event: RunEvent) => void;
  onGrounding?: (grounding: Record<string, unknown> | null, event: RunEvent) => void;
  onUsage?: (usage: UsageInfo | null, event: RunEvent) => void;
  onFollowups?: (items: unknown[], event: RunEvent) => void;
  onDone?: (event: RunEvent) => void;
  onError?: (error: Error, event: RunEvent<RunFailedData>) => void;
  onUnknown?: (fragment: UnknownEventFragment, event: RunEvent) => void;
}
