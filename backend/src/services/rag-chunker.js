"use strict";

// ==================== RAG 文档分块（纯文本处理） ====================
// 从 indexing.service.js 拆出：段落/句子双层切片与场景化子块切割
// （FAQ / 表格 / 列表）。全部为纯函数，不依赖向量库与 embedding 服务。

const config = require('../config');

/** 列表行标记：无序（- * • ·）、有序（1. 1、 1) （1） 第N步） */
const LIST_MARKER_RE = /^(?:[-*•·]|\d{1,2}[.、)）]|[（(][一二三四五六七八九十\d]{1,3}[)）]|第[一二三四五六七八九十\d]+步)/;

/** FAQ 行特征：Q/问/答前缀、选项行、答案行 */
const FAQ_LINE_RE = /^(?:#{1,6}\s*)?(?:Q\s*\d*[：:.、)\s]|问\s*[：:]|答\s*[：:]|\*\*答案|[-\s]*[A-D][.、：:]\s*\S)/;

/** 表格分隔行（如 | --- | --- |）：只含 | - : 空格且至少一个 | 与一个 - */
const TABLE_SEPARATOR_RE = /^(?=[\s|:-]*\|)(?=[\s|:-]*-)[\s|:-]+$/;

/**
 * 剥离 Markdown YAML frontmatter（文件头的 --- 元数据块）。
 * 该块会被切成独立的"元数据父段落"（created/source/category/tags），
 * 检索时凭查询词的稀有字匹配拿到高稀疏分，挤占真实内容的上下文位置
 * （实测表现为模型只拿到"标题 + 元数据"就作答）。
 */
function stripFrontmatter(text) {
  const lines = String(text).split('\n');
  if ((lines[0] || '').trim() !== '---') return text;
  for (let i = 1; i < Math.min(lines.length, 40); i++) {
    if ((lines[i] || '').trim() === '---') {
      return lines.slice(i + 1).join('\n').trim();
    }
  }
  return text;
}

/**
 * 按章节标题合并：两个标题之间的所有段落合并为一个语义块
 * 封面/目录等标题前的内容单独成块
 */
function mergeBySectionHeadings(paragraphs, isHeading) {
  const merged = [];
  let buffer = [];

  const flushBuffer = () => {
    if (buffer.length > 0) {
      merged.push(buffer.join('\n'));
      buffer = [];
    }
  };

  for (const p of paragraphs) {
    if (isHeading(p)) {
      flushBuffer();      // 上一个章节结束
      buffer.push(p);     // 标题开始新章节
    } else {
      buffer.push(p);     // 内容属于当前章节
    }
  }
  flushBuffer();           // 最后一章

  return merged;
}

/**
 * 合并相邻短段落（无章节标题时兜底）
 * 同时对 Q&A 文档特殊处理：将题目、选项、答案合并为同一段落
 */
function mergeShortParagraphs(paragraphs, minLen = 30) {
  const merged = [];
  let buffer = [];

  const flushBuffer = () => {
    if (buffer.length > 0) {
      merged.push(buffer.join('\n'));
      buffer = [];
    }
  };

  for (const p of paragraphs) {
    // Q&A 合并检测：题目行（### Q）、选项行（- A./- B./...）、答案行（**答案：**）
    // 这些行虽然长度可能超过 minLen，但应与前后内容合并为一个段落
    const isQuestionLine = /^###\s+Q\d/i.test(p);
    const isOptionLine = /^[- ]*[A-D]\./.test(p);
    const isAnswerLine = /^\*\*答案/.test(p);
    const isQAContent = isQuestionLine || isOptionLine || isAnswerLine;

    if (isQAContent) {
      // 题目行开始新段落，先刷出缓冲区
      if (isQuestionLine) flushBuffer();
      buffer.push(p);
    } else if (p.length < minLen) {
      buffer.push(p);
    } else {
      flushBuffer();
      merged.push(p);
    }
  }
  flushBuffer();

  return merged;
}

/**
 * 按章节标题或短段落合并
 */
function mergeBySection(paragraphs) {
  if (!paragraphs.length) return [];

  // 章节边界同时接受：中文序号标题（"一、"/"2."，DOCX 转文本常见）
  // 与 Markdown 标题（"## 一、xxx"/"### xxx"）。
  // 不认 Markdown 标题时，md 文档会退化成逐行父段落：纯标题行单独成段，
  // 检索时凭标题与查询词的字面重叠抢占上下文，正文反而进不来。
  const sectionHeadingRe = /^(?:#{1,6}\s+)?[一二三四五六七八九十]+[、.．]/;
  const mdHeadingRe = /^#{1,6}\s+\S/;
  const isHeading = (p) => sectionHeadingRe.test(p) || mdHeadingRe.test(p);
  const hasSectionHeadings = paragraphs.some(isHeading);

  if (hasSectionHeadings) {
    return mergeBySectionHeadings(paragraphs, isHeading);
  }

  // 无章节标题 → 合并相邻短段落
  return mergeShortParagraphs(paragraphs);
}

/**
 * 同一段落内合并相邻短句
 *
 * 策略：顺序累积，达到 targetMinLen 后刷出一个 chunk；
 * 尾部残余若过短（< 10 字）则并入前一个 chunk，避免产生新的碎片。
 *
 * @param {string[]} sentences - 已切分的句子列表
 * @param {number} targetMinLen - 合并目标最小字数
 * @returns {string[]} 合并后的 chunk 列表
 */
function mergeShortSentences(sentences, targetMinLen) {
  const merged = [];
  let buffer = '';

  for (const s of sentences) {
    buffer = buffer ? buffer + s : s;
    if (buffer.length >= targetMinLen) {
      merged.push(buffer);
      buffer = '';
    }
  }

  // 尾部残余处理：过短则并入前一个 chunk，否则独立成块
  if (buffer.length > 0) {
    if (merged.length > 0 && buffer.length < 10) {
      merged[merged.length - 1] += buffer;
    } else {
      merged.push(buffer);
    }
  }

  return merged;
}

/**
 * 将段落按句子分割，并合并过短的相邻句子
 * 注意：选项行（如 "A. 内容"）中的英文句点不被视为句子边界
 *
 * 合并原因：按句末标点切分后，大量 < 10 字的碎片（目录项"一、学校概况3"、
 * 标题"目 录"、日期"2025年7月"）被独立向量化，语义稀薄且干扰检索。
 * 同一段落内相邻短句合并到目标长度，既消除碎片，又保留句子级的语义聚焦。
 *
 * @param {string} paragraph
 * @param {number} [targetMinLen=25] - 合并目标最小字数，累积到此长度输出
 */
function splitSentences(paragraph, targetMinLen = 25) {
  // 先保护选项行（如 "A. 内容" 或 "- A. 内容"），避免被英文句点误切
  // 用占位符替换选项行中的句点，切完再还原
  const _protected = paragraph.replace(/^([- ]*[A-D])\.\s/gm, '$1<DOT>');
  // 匹配中文/英文句号、感叹号、问号、换行
  const parts = _protected.split(/(?<=[。！？.!?\n])\s*/);
  const sentences = parts.map(s => s.trim().replace(/<DOT>/g, '.')).filter(s => s.length > 0);

  // 单句段落无需合并
  if (sentences.length <= 1) return sentences;

  // 合并相邻短句，消除碎片向量
  return mergeShortSentences(sentences, targetMinLen);
}

/**
 * 将文本按段落分割（含碎片段落合并）
 *
 * 场景：mammoth 提取 DOCX 后产生大量碎片化短段落
 * （表格单元格逐行提取、单行键值属性等），检索命中时 LLM 拿到的上下文太短。
 *
 * 策略：
 *   1. 按 \n\n 初始分割
 *   2. 按 `一、` / `二、` / … 章节标题合并同节内所有段落为一个语义块
 *   3. 无章节标题时，退化为相邻短段落合并（< 30 字）
 */
function splitParagraphs(text) {
  if (!text) return [];
  const rawParas = stripFrontmatter(String(text)).split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  return mergeBySection(rawParas);
}

function blockLines(paragraph) {
  return String(paragraph || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 段落块型检测：表格 > FAQ > 列表 > 散文 */
function detectBlockType(paragraph) {
  const lines = blockLines(paragraph);
  if (lines.length < 3) return 'prose';

  const pipeLines = lines.filter((l) => (l.match(/\|/g) || []).length >= 2);
  const hasSeparator = lines.some((l) => TABLE_SEPARATOR_RE.test(l));
  if (pipeLines.length >= 3 && hasSeparator) return 'table';

  if (looksLikeFaq(lines)) return 'faq';
  if (looksLikeList(lines)) return 'list';
  return 'prose';
}

/** FAQ 判定：≥3 行且 ≥50% 行含问答特征、≥60% 行长 ≤80 字 */
function looksLikeFaq(lines) {
  if (lines.length < 3) return false;
  const faqish = lines.filter((l) => FAQ_LINE_RE.test(l) || /[？?]\s*$/.test(l)).length;
  const shortLines = lines.filter((l) => l.length <= 80).length;
  return faqish / lines.length >= 0.5 && shortLines / lines.length >= 0.6;
}

/** 列表判定：≥3 行且 ≥60% 行带列表标记 */
function looksLikeList(lines) {
  if (lines.length < 3) return false;
  const listLines = lines.filter((l) => LIST_MARKER_RE.test(l)).length;
  return listLines / lines.length >= 0.6;
}

/**
 * FAQ 切割：问答条目整条一个子块。只有"提问行"开新条目
 * （Q 前缀 / 问：/ 问号结尾行），选项、答案、续行归当前条目；
 * 超长条目退回句子合并。检测用的宽匹配 FAQ_LINE_RE 不能当分组边界。
 */
function splitFaqChildren(paragraph) {
  const lines = blockLines(paragraph);
  const isItemStart = (l) =>
    /^(?:#{1,6}\s*)?Q\s*\d*[：:.、)\s]/i.test(l)
    || /^问\s*[：:]/.test(l)
    || /^[^，。；]{2,80}[？?]\s*$/.test(l);

  const items = [];
  let current = null;
  for (const line of lines) {
    if (isItemStart(line) || !current) {
      if (current) items.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current) items.push(current);

  return items.flatMap((itemLines) => {
    const text = itemLines.join('\n');
    return text.length > 150 ? splitSentences(text) : [text];
  });
}

/**
 * 表格切割：≤5 行的小表整表一个子块；大表按数据行切，
 * 每行子块带表头前缀（裸行值无语义，表头提供列语义）；表外散文走默认合并
 */
function splitTableChildren(paragraph) {
  const lines = paragraph.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const isPipeRow = (l) => (l.match(/\|/g) || []).length >= 2;

  const children = [];
  let tableLines = [];
  let proseLines = [];

  const flushProse = () => {
    if (proseLines.length) {
      children.push(...splitSentences(proseLines.join('\n')));
      proseLines = [];
    }
  };
  const flushTable = () => {
    if (!tableLines.length) return;
    const sepIdx = tableLines.findIndex((l) => TABLE_SEPARATOR_RE.test(l));
    const header = sepIdx > 0 ? tableLines[sepIdx - 1] : '';
    const rows = tableLines.filter((l, i) => i !== sepIdx && i !== sepIdx - 1 && isPipeRow(l));

    if (rows.length <= 5) {
      children.push(tableLines.join('\n')); // 小表整表检索，行列结构完整
    } else {
      for (const row of rows) {
        children.push(header ? `${header}\n${row}` : row); // 大表按行切，行带表头
      }
    }
    tableLines = [];
  };

  for (const line of lines) {
    if (isPipeRow(line)) {
      flushProse();
      tableLines.push(line);
    } else {
      flushTable();
      proseLines.push(line);
    }
  }
  flushTable();
  flushProse();

  return children;
}

/**
 * 列表切割：按条目边界切，条目带引导句/标题前缀（解决"单步看不出步骤归属"）；
 * 续行归当前条目，超长条目退回句子合并（每个碎片仍带前缀）
 */
function splitListChildren(paragraph) {
  const lines = blockLines(paragraph);
  const isListLine = (l) => LIST_MARKER_RE.test(l);

  let title = '';
  let current = null;
  const children = [];

  const flush = () => {
    if (!current) return;
    const text = current.join('\n');
    const pieces = text.length > 150 ? splitSentences(text) : [text];
    for (const piece of pieces) {
      children.push(title ? `${title}：${piece}` : piece);
    }
    current = null;
  };

  for (const line of lines) {
    if (isListLine(line)) {
      flush();
      current = [line];
    } else if (!current && !title && line.length <= 40) {
      title = line; // 首个非列表短行 = 引导句/标题
    } else if (current) {
      current.push(line); // 续行归当前条目
    } else {
      title = line.slice(0, 40); // 超长引导行截断为标题
    }
  }
  flush();

  return children.length ? children : splitSentences(paragraph);
}

/**
 * 子块切割统一入口：按段落块型分发策略
 * @returns {{ type: 'prose'|'faq'|'table'|'list', chunks: string[] }}
 */
function splitChildChunks(paragraph) {
  if (config.document?.adaptiveChunking === false) {
    return { type: 'prose', chunks: splitSentences(paragraph) };
  }
  const type = detectBlockType(paragraph);
  switch (type) {
    case 'table': return { type, chunks: splitTableChildren(paragraph) };
    case 'faq': return { type, chunks: splitFaqChildren(paragraph) };
    case 'list': return { type, chunks: splitListChildren(paragraph) };
    default: return { type: 'prose', chunks: splitSentences(paragraph) };
  }
}

module.exports = {
  LIST_MARKER_RE,
  FAQ_LINE_RE,
  TABLE_SEPARATOR_RE,
  stripFrontmatter,
  mergeBySection,
  mergeBySectionHeadings,
  mergeShortParagraphs,
  splitParagraphs,
  splitSentences,
  mergeShortSentences,
  blockLines,
  detectBlockType,
  looksLikeFaq,
  looksLikeList,
  splitChildChunks,
  splitFaqChildren,
  splitTableChildren,
  splitListChildren,
};
