"use strict";

/**
 * 敏感字段名判定策略 —— 唯一事实来源。
 *
 * 此前 observability（日志）与 run-event-log（回放）各自维护一份正则且已经
 * 漂移：日志用 /key|.../i（任何含 key 的字段都隐藏），回放用 /...|api.?key/i
 * （更精确，漏掉了裸 key）。同一字段在日志里被隐藏、在回放文件里却明文出现，
 * 这是隐私治理上的真实不一致。
 *
 * 这里取两者的并集（更严格的一侧）：宁可在回放里多隐藏一个 benign 的
 * `keyword` 字段，也不能让任何一侧漏隐藏。新增敏感键时只改这一处。
 *
 * 截断长度、数组上限、嵌套深度是两套各自调优过的档位（日志要短小有界、
 * 回放要保留调试信息），不在此统一。
 */
const SENSITIVE_KEY_RE = /key|token|secret|password|cookie|authorization|api.?key/i;

const isSensitiveKey = (key) => SENSITIVE_KEY_RE.test(String(key || ''));

module.exports = { SENSITIVE_KEY_RE, isSensitiveKey };
