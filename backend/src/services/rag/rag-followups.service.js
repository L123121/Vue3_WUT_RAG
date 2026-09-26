"use strict";

/**
 * RAG 追问建议 —— 零 LLM 成本的"接下来可以问"
 *
 * 生成策略（按优先级，去重后最多 max 条）：
 *   1. 引用父段落中的章节标题（"一、xxx" / "第X章 xxx" / "### xxx"），
 *      且与用户问题重叠度低（说明本次没展开讲，是天然的下一次提问）→「详细讲讲xxx」
 *   2. 其他被引用文档的标题 →「《title》讲了什么？」
 *
 * 纯字符串处理，无模型调用、无额外延迟；候选来自已随流水线下发的 sources/chunks。
 */

const MAX_HEADING_LEN = 40;

// 章节标题形态：markdown 标题行 / 中文章节序号（一、）/ 数字编号（1. / 第3章）
const HEADING_PATTERNS = [
  /^#{1,4}\s*(\S.{2,})$/,
  /^(?:第?[一二三四五六七八九十百\d]{1,4})[、.．：:]\s*(\S.{2,})$/,
  /^(?:第[一二三四五六七八九十\d]{1,4}章)\s*(\S.{2,})$/,
];

// 无信息量标题：出现在目录/文末，作为追问没有意义
const HEADING_STOPWORDS = /^(目录|参考文献|附录|注释|说明|摘要|引言|前言|结语|后记|致谢)/;

function normalizeHeading(text) {
  return String(text || '').trim().replace(/[。.．!！?？:：\s]+$/, '');
}

function charBigrams(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2));
  if (normalized.length > 0 && normalized.length <= 2) grams.add(normalized);
  return grams;
}

/** 标题与问题的 bigram 重叠率：过高说明本次回答已经覆盖该主题 */
function overlapWithQuestion(heading, question) {
  const qGrams = charBigrams(question);
  if (qGrams.size === 0) return 0;
  const hGrams = charBigrams(heading);
  let hit = 0;
  for (const g of hGrams) {
    if (qGrams.has(g)) hit++;
  }
  return hGrams.size === 0 ? 0 : hit / hGrams.size;
}

/**
 * 从引用文档与父段落中提取追问建议
 *
 * @param {Object} input
 * @param {Array} [input.sources] - 来源列表（含 title/category/snippet）
 * @param {Array} [input.chunks] - 引用子片段（含 parentText，用于提取章节标题）
 * @param {string} [input.question] - 用户原始问题
 * @param {number} [max=3] - 最多返回条数
 * @returns {Array<{ text: string, from: 'heading'|'doc' }>}
 */
function buildFollowups({ sources = [], chunks = [], question = '' } = {}, max = 3) {
  const items = [];
  const seen = new Set();

  const push = (text, from) => {
    const normalized = String(text || '').trim();
    if (!normalized || normalized.length < 4) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ text: normalized, from });
  };

  /** 候选标题通用校验：长度 / 停用词 / 与问题重叠度 */
  const isValidCandidate = (candidate) => {
    const heading = normalizeHeading(candidate);
    if (!heading || heading.length < 4 || heading.length > MAX_HEADING_LEN + 10) return null;
    if (HEADING_STOPWORDS.test(heading)) return null;
    if (overlapWithQuestion(heading, question) > 0.4) return null;
    return heading;
  };

  // 1) 父段落中的章节标题 →「详细讲讲xxx」
  for (const chunk of chunks || []) {
    if (items.length >= max) break;
    const parentText = String(chunk?.parentText || '');
    if (!parentText) continue;
    for (const line of parentText.split('\n')) {
      if (items.length >= max) break;
      const trimmed = line.trim();
      if (trimmed.length < 5 || trimmed.length > 60) continue;
      for (const pattern of HEADING_PATTERNS) {
        const match = trimmed.match(pattern);
        if (match) {
          const heading = isValidCandidate(match[1]);
          if (heading) push(`详细讲讲${heading}`, 'heading');
          break;
        }
      }
    }
  }

  // 2) 其他被引用文档标题 →「《title》讲了什么？」
  const seenTitles = new Set();
  for (const source of sources || []) {
    if (items.length >= max) break;
    const title = normalizeHeading(source?.title || '');
    if (!title || title.length < 4) continue;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    if (isValidCandidate(title)) push(`《${title}》讲了什么？`, 'doc');
  }

  return items.slice(0, max);
}

module.exports = { buildFollowups };
