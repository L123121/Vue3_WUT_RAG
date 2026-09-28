"use strict";

/**
 * 按来源去重合并（docId → title → 整体 JSON 兜底三级 key），保持出现顺序。
 * 此前在 agent.service 与 agentic-rag.service 各有一份逐字相同的实现，
 * 收敛到这里避免两处漂移（比如一边改去重口径另一边不知道）。
 *
 * @param {Array<object>} target 已收集的来源数组（会被就地追加）
 * @param {Array<object>} [incoming] 新来源
 * @returns {Array<object>} target
 */
function mergeSources(target, incoming) {
  const seen = new Set((target || []).map((source) => source.docId || source.title || JSON.stringify(source)));
  for (const source of incoming || []) {
    const key = source.docId || source.title || JSON.stringify(source);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(source);
  }
  return target;
}

module.exports = { mergeSources };
