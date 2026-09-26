"use strict";

/**
 * QueryDecompose — 跨文档问题分解（零 LLM 成本）
 *
 * 背景：官方评测中跨文档推理题（XD 类）只能命中部分相关文档——
 * "A 和 B 的区别"这类问题的 embedding 混合了两个实体语义，
 * 单次检索往往只偏向其中一个文档。
 *
 * 方案：规则识别对比类/列举类问题 → 拆出实体级子查询 →
 * 子查询与原问题并行检索、合并候选池。关键约束：
 *   - 子查询只用于**扩大召回**，reranker 仍按原问题打分，精度不受影响
 *   - 纯正则实现，零 LLM 调用零延迟；低置信返回空数组不硬拆
 *   - 与 query rewrite 正交：rewrite 解决指代省略，本模块解决多实体混合语义
 */

// 对比类："A 和 B 的区别 / 差异 / 对比 / 比较 / 异同 / 关系 / 联系"
const COMPARISON_RE = /(.{2,30}?)\s*(?:和|与|跟|及|同|vs\.?|VS)\s*(.{2,30}?)\s*(?:之间)?(?:的)?(?:主要|核心|根本)?(?:区别|差异|异同|不同点?|对比|比较|联系|关系)/;

// 二选一类："A 还是 B（哪个）更(好/适合/优…)"
const EITHER_OR_RE = /(.{2,30}?)\s*还是\s*(.{2,30}?)\s*[，,？?]?\s*(?:哪个|哪一[种个])?更(?:好|适合|优|推荐|值得|强)/;

// 列举类线索："A、B、C 分别/各自 有哪些/是什么/怎么样"
const ENUMERATION_CUE_RE = /(分别|各自|各|都)(?:有|是|怎么|如何|包含|覆盖)/;

// 实体合法性：至少含一个 CJK 字符或字母数字，且不是纯指代词
const ENTITY_CONTENT_RE = /[\u4e00-\u9fff a-zA-Z0-9]/;
const PURE_PRONOUN_RE = /^(这|那|它|他|她|您|你|我|其|此|该)+(些|们|个|种|边|里)?$|^什么$|^哪些?$/;

// "的"后缀像问句成分时才在"的"处截断（避免误伤"学校的食堂"这类合法实体）
const QUALIFIER_SUFFIX_RE = /[什怎如哪要需能可应有无是求]/;

/**
 * 截断实体后携带的问句限定语：
 * "华中科技大学的校训有什么" → 先按标点切出 "华中科技大学的校训有什么"，
 * 再在"的"处截断（仅当后缀像问句成分）→ "华中科技大学"
 */
function truncateQualifier(entity) {
  // 第一步：按标点/空白切，取第一段（去掉"，两者""。哪个更好"等尾巴）
  let e = String(entity || '').split(/[，,。.？！?!：:；;（）()【】\s]/)[0] || String(entity || '');
  // 第二步：在"的"处截断问句限定语
  const positions = [];
  let idx = e.indexOf('的');
  while (idx !== -1) {
    if (idx >= 2) positions.push(idx);
    idx = e.indexOf('的', idx + 1);
  }
  for (const i of positions) {
    const suffix = e.slice(i + 1);
    if (suffix.length >= 2 && QUALIFIER_SUFFIX_RE.test(suffix)) {
      e = e.slice(0, i);
      break;
    }
  }
  return e.trim();
}

/**
 * 清洗实体片段：去掉句首客套动词、句尾连接词与标点、问句限定语
 */
function cleanEntity(raw) {
  let entity = String(raw || '')
    .replace(/^(请问|请|帮我|麻烦|你知道|告诉我|说说|介绍一下?|讲讲)/, '')
    .replace(/^(对比|比较|分析)(一下)?/, '')
    .replace(/[和与跟及同、,，。.？！?!：:\s]+$/g, '')
    .replace(/^[、,，\s]+/g, '')
    .trim();
  entity = truncateQualifier(entity);
  entity = entity.replace(/\s+/g, ' ').trim();
  return entity;
}

/**
 * 实体是否可用作子查询：
 * 长度 2~30、含实际内容字符、非纯指代词
 */
function isValidEntity(entity) {
  if (!entity || entity.length < 2 || entity.length > 30) return false;
  if (!ENTITY_CONTENT_RE.test(entity)) return false;
  if (PURE_PRONOUN_RE.test(entity)) return false;
  return true;
}

/** 去重（忽略大小写/空白差异），保序 */
function dedupeEntities(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const key = item.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * 拆分单层列表为子串数组（供测试直接复用）
 */
function splitByListSeparators(text) {
  return String(text || '').split(/[、，,;；/]/);
}

/**
 * 对比类拆分："武理和华科的区别" → ["武理", "华科"]
 * @returns {string[]} 实体数组（不含原问题）；非对比类返回 []
 */
function splitComparisonQuery(query) {
  const text = String(query || '').trim();
  for (const re of [COMPARISON_RE, EITHER_OR_RE]) {
    const m = text.match(re);
    if (!m) continue;
    const entities = dedupeEntities(
      [cleanEntity(m[1]), cleanEntity(m[2])].filter(isValidEntity),
    );
    if (entities.length === 2) return entities;
  }
  return [];
}

/**
 * 列举类拆分："保研、考研、就业分别有什么要求" → ["保研", "考研", "就业"]
 * @returns {string[]}
 */
function splitEnumerationQuery(query) {
  const text = String(query || '').trim();
  if (!ENUMERATION_CUE_RE.test(text)) return [];

  // 线索词前的部分是枚举区："保研、考研、就业分别..." → "保研、考研、就业"
  const cueMatch = text.match(/(分别|各自)/);
  const enumZone = cueMatch && cueMatch.index > 0 ? text.slice(0, cueMatch.index) : '';
  if (!enumZone || enumZone.length > 60) return [];

  const parts = splitByListSeparators(enumZone).map(cleanEntity).filter(isValidEntity);
  // 至少 2 个有效实体才算列举
  const entities = dedupeEntities(parts);
  return entities.length >= 2 ? entities : [];
}

/**
 * 问题分解主入口：返回子查询数组（可能为空 = 不分解）
 *
 * @param {string} query - 用户原始问题
 * @param {number} [maxSubQueries=3] - 子查询上限
 * @returns {{ subQueries: string[], type: 'comparison'|'enumeration'|null }}
 */
function decomposeQuery(query, maxSubQueries = 3) {
  const capped = Math.min(Math.max(parseInt(maxSubQueries, 10) || 3, 1), 5);

  const comparison = splitComparisonQuery(query);
  if (comparison.length >= 2) {
    return { subQueries: comparison.slice(0, capped), type: 'comparison' };
  }

  const enumeration = splitEnumerationQuery(query);
  if (enumeration.length >= 2) {
    return { subQueries: enumeration.slice(0, capped), type: 'enumeration' };
  }

  return { subQueries: [], type: null };
}

module.exports = {
  decomposeQuery,
  splitComparisonQuery,
  splitEnumerationQuery,
  cleanEntity,
  truncateQualifier,
  isValidEntity,
  COMPARISON_RE,
  EITHER_OR_RE,
  ENUMERATION_CUE_RE,
};
