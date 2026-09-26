"use strict";

const config = require('../../config');

/**
 * TextNormalizer — 入库清洗管线的字符级去脏与断行合并
 *
 * normalizeCharacters（管线第一步"去脏"，必须最先执行：
 * 全角数字归半角后，页眉页脚规则法的 \d 才匹配得上"第３页"）：
 *   - 全角→半角：仅英文字母与数字（Ａ→A、０→0）。设计文档同时提到英文标点，
 *     但 ！？：； 等全角形态在中文文本里就是中文标点，误转会破坏 embedding
 *     一致性（同一字符出现两种形态）——刻意收窄到字母/数字
 *   - 空白统一：\u00A0/\u3000（全角空格）/ \t / \u200b（零宽）→ 普通空格；
 *     \r\n → \n；清 BOM \uFEFF
 *   - 控制字符剔除：保留 \n 与 \f（\f 是 pdf-parse 的页分隔符，
 *     页眉页脚位置法按 \f 分页统计，剔了就废）与（先归一化前的）\r
 *   - 乱码占位替换：□■/\uFFFD/[UNK] 连串、?{4,}（仅半角，全角 ？ 串是正常语气词）、
 *     锟斤拷（UTF-8↔GBK 双重编码）→ 统一替换为 [UNK] 并计数；后续 doc-sanitizer
 *     乱码闸门按 [UNK] 占比告警/拒绝入库，形成"替换→计量→闸门"闭环。ftfy 级编码还原不做
 *     （Node 无直接等价，乱码文档靠闸门拒收兜底）
 *
 * mergeHardLineBreaks（第二步"结构消歧"的断行合并，必须在页眉页脚删除之后：
 * 先合并会把页眉行拼进正文行，位置法的按行检测就失效了）：
 *   当前行不以句末标点结尾、且下一行不以结构行开头 → 判定硬断行，\n 换空格拼接。
 *   中文无大小写概念，断行判断只能靠结尾标点 + 结构行标记。
 *   保护不合并：下一行为列表序号/Markdown 标题/表格行/引用/分隔线/代码围栏；
 *   当前行为标题/表格/引用；空行（段落边界）；\f 前后（跨页）；
 *   代码围栏内部（代码的 \n 与缩进是语义）；frontmatter 块。
 */

// 全角→半角：U+FFxx 区间减 0xFEE0。仅字母与数字（见头注释）
const FULLWIDTH_ALNUM_RE = /[Ａ-Ｚａ-ｚ０-９]/g;
const toHalfWidth = (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);

const WHITESPACE_RE = /[\u00A0\u3000\t\u200b\u200c\u200d]+/g;
const BOM_RE = /\uFEFF/g;
// 控制字符：保留 \n(\x0a)、\f(\x0c)；\r 在此前已被 \r\n → \n 归一（孤立的 \r 一并归一）
// eslint-disable-next-line no-control-regex -- 剔除控制字符正是本清洗步骤的职责，规则误报
const CONTROL_RE = /[\x00-\x08\x0b\x0e-\x1f\x7f]/g;

// 乱码类合并为一个单趟正则：避免"锟斤拷→[UNK]"插入的标记被乱码规则二次匹配重复计数。
// 注意刻意不含 ？{4,}（全角问号）：中文网络语气里"？？？？"是正常表达，字面替换成
// [UNK] 会污染正文并虚增闸门占比；半角 ?{4,} 在中文文档里几乎必为乱码，保留
const GARBAGE_ALL_RE = /(?:锟斤拷)+|(?:\uFFFD|[\u25A0\u25A1]|\[UNK\])+|\?{4,}/g;

const UNK = '[UNK]';

/**
 * 字符级去脏
 * @returns {{ content: string, report: {
 *   enabled: boolean, fullwidth: number, whitespace: number, bom: number,
 *   control: number, garbageReplaced: number, mojibakeReplaced: number, totalReplaced: number
 * }}}
 */
function normalizeCharacters(content, options = {}) {
  const enabled = options.enabled ?? config.docNormalize?.enabled ?? true;
  const report = {
    enabled, fullwidth: 0, whitespace: 0, bom: 0,
    control: 0, garbageReplaced: 0, mojibakeReplaced: 0, totalReplaced: 0,
  };
  let text = String(content || '');
  if (!enabled) return { content: text, report };

  const count = (key) => () => { report[key] += 1; return ''; };

  // 顺序：先归一换行（\r 不残留），再剔控制字符；空白统一最后做（避免 \u3000 被当成隔断）
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(BOM_RE, () => { report.bom += 1; return ''; });
  text = text.replace(CONTROL_RE, count('control'));
  text = text.replace(FULLWIDTH_ALNUM_RE, (ch) => { report.fullwidth += 1; return toHalfWidth(ch); });
  text = text.replace(GARBAGE_ALL_RE, (m) => {
    if (m.startsWith('锟斤拷')) report.mojibakeReplaced += 1;
    else report.garbageReplaced += 1;
    return UNK;
  });
  text = text.replace(WHITESPACE_RE, () => { report.whitespace += 1; return ' '; });

  report.totalReplaced = report.fullwidth + report.whitespace + report.bom
    + report.control + report.garbageReplaced + report.mojibakeReplaced;
  return { content: text, report };
}

// ===== 断行合并 =====

// 句末标点（中文全角 + 英文半角）。、，等句内标点不算结束
const TERMINATOR_RE = /[。！？：；.!?;]$/;
// 行尾收尾符号：引号/括号/破折号/省略号——剥掉后再判句末
const TRAILING_CLOSE_RE = /[\s"'”』」）)》…—-]+$/;
// 下一行的"结构行"标记：列表序号 / Markdown 标题 / 表格行 / 引用 / 分隔线 / 代码围栏 /
// 注入占位行（[已过滤…]——注入过滤先于断行合并执行，占位行不吸收正文）。
// 与 indexing.service 的 LIST_MARKER_RE 同构（服务间不互相 import，保持解耦）
const NEXT_STRUCTURAL_RE = /^(?:#{1,6}\s|\||>|```|~~~|[-*•·]\s|\d{1,2}[.、)）]\s?|[（(][一二三四五六七八九十\d]{1,3}[)）]|第[一二三四五六七八九十\d]+[步章节条]|-{3,}|\*{3,}|={3,}|\[已过滤)/;
// 当前行不可作为合并起点的结构行：标题 / 表格 / 引用 / 分隔线 / 注入占位行
// （列表项允许与续行合并，是断行修复的对象）
const CURRENT_STRUCTURAL_RE = /^(?:#{1,6}\s|\||>|```|~~~|-{3,}|\*{3,}|={3,}|\[已过滤)/;
const FENCE_RE = /^\s*(```|~~~)/;

function endsWithTerminator(line) {
  return TERMINATOR_RE.test(line.replace(TRAILING_CLOSE_RE, ''));
}

/**
 * 断行合并：\n 换空格拼接硬断行（累积式——合并后的行继续参与下一轮判定，
 * 一段被 PDF 硬换行切碎的段落能完整拼回一行）
 * @returns {{ content: string, report: { enabled: boolean, merged: number } }}
 */
function mergeHardLineBreaks(content, options = {}) {
  const enabled = options.enabled ?? config.docNormalize?.enabled ?? true;
  const report = { enabled, merged: 0 };
  let text = String(content || '');
  if (!enabled || !text) return { content: text, report };

  const lines = text.split('\n');

  // frontmatter（--- … ---）：元数据块整体跳过，合并会破坏 --- 边界识别
  let skipUntil = -1;
  if ((lines[0] || '').trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close > 0) skipUntil = close;
  }

  const out = [];
  let current = null;   // 正在累积的行（可能已吸收多行）
  let inFence = false;
  const flush = () => { if (current !== null) { out.push(current); current = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    const next = lines[i + 1];

    if (current === null) {
      current = line;
    } else {
      current = `${current} ${line}`;
      report.merged += 1;
    }

    // current 是否继续吸收下一行：任何一条不满足即收口
    const absorb = next !== undefined
      && i + 1 > skipUntil                      // frontmatter 内不合并
      && !inFence                               // 代码块内 \n 是语义
      && !!current.trim() && !!next.trim()      // 空行 = 段落边界
      && !/\f\s*$/.test(current) && !/^\f/.test(next)          // 跨页不合并（\f 是空白，不能用 trimEnd 后再判，会把它 trim 掉）
      && !CURRENT_STRUCTURAL_RE.test(current)   // 标题/表格/引用/分隔线/占位行不外吸
      && !NEXT_STRUCTURAL_RE.test(next)         // 下一行是结构行不并入
      && !endsWithTerminator(current);          // 已收句不再吸收
    if (!absorb) flush();
  }
  flush();

  return { content: out.join('\n'), report };
}

module.exports = {
  normalizeCharacters,
  mergeHardLineBreaks,
  endsWithTerminator,
};
