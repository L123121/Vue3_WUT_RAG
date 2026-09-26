"use strict";

const config = require('../../config');

/**
 * HeaderFooterCleaner — 页眉页脚清洗（入库前一次性完成，只删整行、不改行内文本）
 *
 * 依据 CLAUDE.md「文档清洗」第二步"结构消歧"，排在注入过滤/乱码闸门之前：
 *  ① 规则法：整行正则匹配页码行（"第 3 页/共 10 页"、"- 12 -"、"3/10"、"Page 3 of 10"）
 *     与版权行（"Copyright © ..."、"© 2024 ..."）。锚定 ^$，只删纯页码/版权行，
 *     不动"本文共 10 页"这类含正文的行。
 *  ② 位置法：pdf-parse 输出按 \f 分页。统计每页顶部/底部各 zoneLines 个非空行中
 *     跨页重复出现的行（页码数字归一化为 #），出现页占比超阈值即判为页眉/页脚，
 *     从所有页删整行。这是"页顶/底边缘 + 小字体"坐标信号在纯文本域的等价近似——
 *     不引 pdfplumber 坐标依赖，且对 OCR 输出的分页文本同样生效。
 *
 * 清洗只在入库前做一遍，之后 embedding 与上下文使用同一份文本（rerank 分数不失真）。
 */

// 规则法模式（整行锚定）
const RULE_PATTERNS = [
  { name: 'page_zh', re: /^\s*[—–\-·•]*\s*第\s*\d+\s*页(?:\s*[（(]?\s*共\s*\d+\s*页\s*[）)]?|\s*[/／]\s*共?\s*\d+\s*页)?\s*[—–\-·•]*\s*$/ },
  { name: 'page_dash', re: /^\s*[—–\-·•]\s*\d{1,4}\s*[—–\-·•]\s*$/ },
  { name: 'page_fraction', re: /^\s*\d{1,4}\s*[/／]\s*\d{1,4}\s*$/ },
  { name: 'page_en', re: /^\s*page\s+\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?\s*$/i },
  // 版权行：以 Copyright/© 开头且总长受限（{0,140} 不匹配换行，天然限定单行）
  { name: 'copyright', re: /^\s*(?:copyright|©).{0,140}$/i },
];

// 以句末标点结尾的是正文句，不作页眉/页脚候选——数字归一化会把
// "2024年招生…/2023年招生…"这类仅差数字的正文行并成同一候选，靠标点排除
const SENTENCE_END_RE = /[。？！；?!;]$/;

const POSITION_DEFAULTS = {
  minPages: 3,     // \f 分页数达到该值才启用位置法（页太少无重复性证据）
  repeatRatio: 0.3, // 候选行需出现的页数占比
  zoneLines: 3,    // 每页顶部/底部各考察的非空行数
  maxZoneLineLength: 80, // 超长行更可能是正文，不参与页眉/页脚统计
  maxCandidateLength: 40, // 归一化后仍超长的行视为正文，不作候选
};

function isCandidateLine(raw) {
  if (raw.length > POSITION_DEFAULTS.maxZoneLineLength) return false;
  if (SENTENCE_END_RE.test(raw)) return false;
  return normalizeForRepeat(raw).length <= POSITION_DEFAULTS.maxCandidateLength;
}

function matchRuleLine(line) {
  for (const { name, re } of RULE_PATTERNS) {
    if (re.test(line)) return name;
  }
  return null;
}

/** 规则法：删整行并返回命中明细（\f 可能紧贴正文行，需按 \f 再切片段逐段匹配） */
function stripRuleLines(text) {
  const removed = [];
  const keptLines = String(text || '').split('\n').map((seg) => {
    // \f 分页符与正文同行时（页尾行\f下页首页行），命中片段置空但保留 \f，
    // 否则页边界会丢失、位置法看到的分页数变 1
    return seg.split('\f').map((part) => {
      const name = matchRuleLine(part);
      if (name) {
        removed.push({ pattern: name, line: part.trim().slice(0, 60) });
        return '';
      }
      return part;
    }).join('\f');
  });
  return { text: keptLines.join('\n'), removed };
}

/**
 * 页眉/页脚候选行归一化：只归一化"页码上下文"的数字（第 N 页 / Page N / 整行页码），
 * 让"教务处 第 3 页"与"教务处 第 4 页"归并为同一候选。
 * 其余数字保持原样——避免把"2021 年级培养方案 / 2022 年级培养方案"这类
 * 仅差年份/编号的正文行误并成同一候选。
 */
function normalizeForRepeat(line) {
  let s = String(line).toLowerCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/第\s*\d+\s*页/g, '第#页');
  s = s.replace(/page\s+\d+/g, 'page#');
  if (/^[-—–·•]*\s*\d{1,4}\s*[-—–·•]*$/.test(s) || /^\d{1,4}\s*[/／]\s*\d{1,4}$/.test(s)) {
    s = '#'; // 整行就是页码
  }
  return s;
}

/**
 * 位置法：统计每页顶/底 zone 行的跨页重复，超阈值删整行。
 * 行数 ≤2 的页既不参与统计也不参与删除（证据不足宁可不删）；
 * 删除时若会清空整页则该页放弃删除，保证每页至少留一行。
 */
function stripRepeatingZoneLines(text, options = {}) {
  const opts = { ...POSITION_DEFAULTS, ...options };
  const pages = String(text || '').split('\f');
  if (pages.length < opts.minPages) {
    return { text, pages: pages.length, removed: 0, headers: [], footers: [] };
  }

  // zone 非空行（归一化）→ 出现过的页号集合
  const zonePages = { top: new Map(), bottom: new Map() };

  pages.forEach((page, pageIdx) => {
    const lines = page.split('\n');
    const nonEmptyIdx = [];
    lines.forEach((line, i) => { if (line.trim()) nonEmptyIdx.push(i); });
    if (nonEmptyIdx.length <= 2) return;

    for (const zone of ['top', 'bottom']) {
      const idxs = zone === 'top' ? nonEmptyIdx.slice(0, opts.zoneLines) : nonEmptyIdx.slice(-opts.zoneLines);
      for (const i of idxs) {
        const raw = lines[i].trim();
        if (!isCandidateLine(raw)) continue;
        const key = normalizeForRepeat(raw);
        if (!zonePages[zone].has(key)) zonePages[zone].set(key, new Set());
        zonePages[zone].get(key).add(pageIdx);
      }
    }
  });

  const toCandidates = (map) => new Set(
    [...map.entries()]
      .filter(([, pageSet]) => pageSet.size >= 2 && pageSet.size / pages.length >= opts.repeatRatio)
      .map(([key]) => key),
  );
  const headerKeys = toCandidates(zonePages.top);
  const footerKeys = toCandidates(zonePages.bottom);

  if (headerKeys.size === 0 && footerKeys.size === 0) {
    return { text, pages: pages.length, removed: 0, headers: [], footers: [] };
  }

  let removed = 0;
  const cleanedPages = pages.map((page) => {
    const lines = page.split('\n');
    const nonEmptyIdx = [];
    lines.forEach((line, i) => { if (line.trim()) nonEmptyIdx.push(i); });
    if (nonEmptyIdx.length <= 2) return page;

    const topIdx = new Set(nonEmptyIdx.slice(0, opts.zoneLines));
    const bottomIdx = new Set(nonEmptyIdx.slice(-opts.zoneLines));
    const dropIdx = new Set();
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const key = normalizeForRepeat(line);
      if ((topIdx.has(i) && headerKeys.has(key)) || (bottomIdx.has(i) && footerKeys.has(key))) {
        dropIdx.add(i);
      }
    });
    // 删除会清空整页时放弃该页（候选行证据不足的极端情况）
    if (dropIdx.size >= nonEmptyIdx.length) return page;
    removed += dropIdx.size;
    dropIdx.forEach((i) => { lines[i] = ''; });
    return lines.join('\n');
  });

  return {
    text: cleanedPages.join('\f'),
    pages: pages.length,
    removed,
    headers: [...headerKeys].slice(0, 5),
    footers: [...footerKeys].slice(0, 5),
  };
}

/**
 * 页眉页脚清洗主入口：规则法 → 位置法
 * @param {string} content 原始全文
 * @param {Object} [options] { enabled, minPages, repeatRatio, zoneLines }，缺省读 config.docClean
 * @returns {{ content: string, report: {
 *   enabled: boolean, pages: number, removedRuleLines: number, removedPositionLines: number,
 *   ruleSamples: Array, headerSamples: string[], footerSamples: string[]
 * }}}
 */
function cleanHeaderFooter(content, options = {}) {
  const cfg = config.docClean || {};
  const enabled = options.enabled ?? cfg.enabled ?? true;

  const report = {
    enabled,
    pages: 0,
    removedRuleLines: 0,
    removedPositionLines: 0,
    ruleSamples: [],
    headerSamples: [],
    footerSamples: [],
  };
  let text = String(content || '');

  if (!enabled) {
    return { content: text, report };
  }

  // 统一换行符，保证规则法整行锚定与位置法分页统计在 CRLF 输入下同样生效
  text = text.replace(/\r\n?/g, '\n');
  report.pages = text.split('\f').length;

  const rule = stripRuleLines(text);
  report.removedRuleLines = rule.removed.length;
  report.ruleSamples = rule.removed.slice(0, 5);
  text = rule.text;

  const position = stripRepeatingZoneLines(text, {
    minPages: options.minPages ?? cfg.minPagesForPosition ?? POSITION_DEFAULTS.minPages,
    repeatRatio: options.repeatRatio ?? cfg.repeatRatio ?? POSITION_DEFAULTS.repeatRatio,
    zoneLines: options.zoneLines ?? cfg.zoneLines ?? POSITION_DEFAULTS.zoneLines,
  });
  report.removedPositionLines = position.removed;
  report.headerSamples = position.headers;
  report.footerSamples = position.footers;
  text = position.text;

  return { content: text, report };
}

module.exports = {
  cleanHeaderFooter,
  stripRuleLines,
  stripRepeatingZoneLines,
  matchRuleLine,
  normalizeForRepeat,
};
