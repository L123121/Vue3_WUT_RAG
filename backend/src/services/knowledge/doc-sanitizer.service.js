"use strict";

const config = require('../../config');

/**
 * DocSanitizer — 文档入库清洗与质量闸门
 *
 * 上传文档的内容会原样进入 RAG 上下文（进而进入 LLM prompt），两类风险：
 *   1. Prompt injection：恶意/玩笑文档写入"忽略以上指令"等指令劫持文本，
 *      检索命中后可能改变 LLM 行为（泄露 system prompt、无视拒答策略）。
 *   2. OCR 乱码：扫描件识别质量差时产生大量 □ / \uFFFD / [UNK]，
 *      污染 embedding 输入，且检索命中率越差越难发现。
 *
 * 处理策略（与 CLAUDE.md 文档清洗设计一致）：
 *   - 注入行 → 整行替换为占位标记并计数（保留其余内容，不整篇拒绝）
 *   - [UNK]/乱码占比 → warn 阈值告警、reject 阈值拒绝入库
 *   - 清洗只在**入库前做一遍**，检索/生成阶段不再动文本，
 *     保证 embedding 输入与进上下文的文本一致
 */

// 注入模式（行级匹配）。刻意保持高特异性，避免误伤讨论 AI 安全的正常文档。
const INJECTION_PATTERNS = [
  { name: 'override_zh', re: /(忽略|无视| disregard )\s*(以上|上面|之前|前面|上述)(的)?(所有)?(指令|提示|设定|要求|规则|内容)/i },
  { name: 'override_en', re: /\b(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|directions?)/i },
  { name: 'role_hijack', re: /(你现在是|从现在开始你是|你现在扮演|你必须扮演|pretend\s+to\s+be|act\s+as\s+(an?|the)\s+)/i },
  { name: 'fake_role_marker', re: /^\s*(system|assistant|developer|系统)\s*[:：]/i },
  { name: 'system_prompt_probe', re: /(输出|打印|泄露|透露|复述).{0,12}(system\s*prompt|系统提示词?|系统指令|初始指令)|(system\s*prompt|系统提示词?)\s*[:：=]/i },
  { name: 'secret_probe', re: /(输出|打印|泄露|告诉我).{0,16}(API[\s-]?KEY|密钥|secret|token)/i },
  { name: 'payload_injection', re: /<\/?script|javascript:|onerror\s*=/i },
];

// 乱码字符：替换符、全角方块、可见 [UNK] 标记、连续问号串。
// 注意不要把 \u96A3（"邻"）这类常用汉字误收进来——它会被 normalizer 输出直通闸门，
// 含"邻里/邻校"的正常文档会被虚增乱码占比推向 warn/reject
const GARBAGE_CHAR_RE = /[\uFFFD\u25A0\u25A1]|\[UNK\]/g;
const GARBAGE_RUN_RE = /\?{4,}/g;

const REDACTED_LINE = '[已过滤：疑似提示词注入]';

/**
 * 单行是否命中注入模式
 */
function matchInjectionLine(line) {
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(line)) return name;
  }
  return null;
}

/**
 * 统计乱码字符占比（按字符数）
 */
function garbageRatio(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  let count = 0;
  for (const m of s.matchAll(GARBAGE_CHAR_RE)) count += m[0].length;
  for (const m of s.matchAll(GARBAGE_RUN_RE)) count += m[0].length;
  return count / s.length;
}

/**
 * 清洗文档内容
 *
 * @param {string} content - 原始文档全文
 * @param {Object} [options]
 * @param {boolean} [options.enabled] - 默认读 config.docSanitize.enabled
 * @param {number} [options.warnUnkRatio]
 * @param {number} [options.rejectUnkRatio]
 * @returns {{ content: string, report: {
 *   enabled: boolean, injectionLines: number, injectionHits: Array<{line:number, pattern:string}>,
 *   garbageRatio: number, qualityLevel: 'ok'|'warn'|'reject'
 * }}}
 */
function sanitizeDocument(content, options = {}) {
  const cfg = config.docSanitize || {};
  const enabled = options.enabled ?? cfg.enabled ?? true;
  const warnRatio = options.warnUnkRatio ?? cfg.warnUnkRatio ?? 0.03;
  const rejectRatio = options.rejectUnkRatio ?? cfg.rejectUnkRatio ?? 0.15;

  const text = String(content || '');
  const report = {
    enabled,
    injectionLines: 0,
    injectionHits: [],
    garbageRatio: Math.round(garbageRatio(text) * 10000) / 10000,
    qualityLevel: 'ok',
  };

  if (!enabled) {
    report.garbageRatio = Math.round(garbageRatio(text) * 10000) / 10000;
    // 关闭清洗时仍评估质量分级，但由调用方决定是否采纳
    report.qualityLevel = report.garbageRatio >= rejectRatio ? 'reject' : report.garbageRatio >= warnRatio ? 'warn' : 'ok';
    return { content: text, report };
  }

  // 行级注入过滤：命中行整行替换为占位标记
  const lines = text.split('\n');
  const sanitizedLines = lines.map((line, i) => {
    const pattern = matchInjectionLine(line);
    if (!pattern) return line;
    report.injectionHits.push({ line: i + 1, pattern });
    return REDACTED_LINE;
  });
  report.injectionLines = report.injectionHits.length;

  // 乱码占比在清洗后的文本上计算（注入行已替换，不影响占比结论）
  report.garbageRatio = Math.round(garbageRatio(sanitizedLines.join('\n')) * 10000) / 10000;
  report.qualityLevel = report.garbageRatio >= rejectRatio ? 'reject' : report.garbageRatio >= warnRatio ? 'warn' : 'ok';

  return { content: sanitizedLines.join('\n'), report };
}

module.exports = {
  sanitizeDocument,
  matchInjectionLine,
  garbageRatio,
};
