// ==================== 流式链路共享常量 ====================
// 此前 STREAM_STALL_TIMEOUT 在 api/chat.js 与 useStreaming.js 各定义一份，
// 改一处会静默失配（网络层等待 60s、状态机却按另一个阈值判定 stall）。
// 收敛到单一来源，两侧都从这里导入。

/**
 * 流式"无活动"判定阈值（毫秒）。
 * 注意是活动型超时：任何回调活动都会重置计时，不是一次请求的总时长上限——
 * 健康但偏慢的流（首 token 6-8s、agent 多轮 15s/轮、重试退避累计可达 2 分钟）
 * 不能被误杀。
 */
export const STREAM_STALL_TIMEOUT = 60000;

/** 状态机在 STREAM_STALL_TIMEOUT 之上额外给的宽限（等待网络层自己先超时） */
export const STREAM_STALL_GRACE_MS = 5000;

/**
 * 保留的 run 状态条数上限。
 * runsById 只增不减会让长会话下这个响应式对象无限增长（每个 run 都被深层代理），
 * 而 run 状态只在流式期间与"当前/最近一次"有用，终态后即可回收。
 */
export const MAX_RETAINED_RUNS = 20;
