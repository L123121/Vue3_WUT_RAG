"use strict";

/**
 * GroundingService — 运行时引用校验（防幻觉兜底）
 *
 * 离线评测有 LLM-as-judge（judge.service.js），但线上每次回答没有溯源检查。
 * 本服务在生成完成后、返回给用户前做一次轻量 grounding 校验：
 *   把回答切成句子 → 逐句计算与 RAG 上下文的字符 bigram 覆盖率 →
 *   得出"已溯源比例 coverage"，低溯源回答标记 level=low 供前端标注/告警。
 *
 * 设计约束：
 *   - 零模型调用（字符 bigram 集合运算），单次 <1ms，不拖慢 SSE 尾包
 *   - 校验对象是 pipeline.context（LLM 实际看到的上下文），而非 sources snippet
 *   - 只做"标注与观测"，不阻断回答（避免误杀改写型正确答案）
 */

// 通用客套/元话语句：不在上下文中属正常，不计入未溯源
const BOILERPLATE_PATTERNS = [
  /^(希望|祝|以上内容|以上就是|总的来说?|综上|总之)/,
  /(如有(其他|任何)(问题|疑问)|欢迎(继续|随时)提问|希望能帮|对你有帮助|仅供参考)$/,
  /^(好的[的啦]?[！!。.]?)$/,
];

// 最短参与校验的句子长度：更短的句子（语气词、过渡词）区分度不足
const MIN_SENTENCE_LENGTH = 6;

/**
 * 剥离 markdown 代码块（代码内容不参与中文 bigram 溯源判断）
 */
function stripCodeBlocks(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ');
}

/**
 * 将回答切分为待校验句子
 * 按中英文句末标点 + 换行切分；过滤过短句和纯列表符号行
 */
function splitAnswerSentences(answer) {
  const cleaned = stripCodeBlocks(answer);
  return cleaned
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map(s => s
      .replace(/^[-*•]\s*/, '')            // 列表标记
      .replace(/^#{1,6}\s*/, '')           // 标题标记
      .replace(/\*\*|__|`/g, '')           // 行内加粗/代码标记
      .replace(/^\d+[.、)]\s*/, '')        // 有序列表编号
      .trim())
    .filter(s => s.length >= MIN_SENTENCE_LENGTH)
    .filter(s => {
      // 尾锚定模式需先剥掉句末标点再匹配（"对你有帮助！"）
      const stripped = s.replace(/[。．.!！?？~～\s]+$/, '');
      return !BOILERPLATE_PATTERNS.some(re => re.test(stripped));
    });
}

/** 字符 bigram 集合（与 rag-ranking.service 的 charBigrams 同思路，独立实现保持本服务零依赖） */
function charBigrams(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < normalized.length - 1; i++) {
    grams.add(normalized.slice(i, i + 2));
  }
  // 单字也要覆盖：两字词（如"保研"）只有 1 个 bigram，另补单字提升鲁棒性
  if (normalized.length <= 2) {
    for (const ch of normalized) grams.add(ch);
  }
  return grams;
}

/**
 * 句子级溯源得分：句子 bigram 被上下文覆盖率
 * = |sentence ∩ context| / |sentence|
 * 直接抄自上下文的句子 ≈ 1.0；改写句 0.3~0.7；编造内容接近 0
 */
function supportScore(sentenceBigrams, contextBigrams) {
  if (sentenceBigrams.size === 0) return 1;
  let hit = 0;
  for (const g of sentenceBigrams) {
    if (contextBigrams.has(g)) hit++;
  }
  return hit / sentenceBigrams.size;
}

/**
 * 执行 grounding 校验
 *
 * @param {string} answer - LLM 回答全文
 * @param {string} context - 组装进 prompt 的 RAG 上下文（pipeline.context）
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true] - 总开关
 * @param {number} [options.minSupport=0.35] - 句子判定"已溯源"的 bigram 覆盖率阈值
 * @returns {Object|null} null 表示本次不校验（关闭 / 无上下文 / 无有效句子）
 */
function checkGrounding(answer, context, options = {}) {
  const enabled = options.enabled !== false;
  const minSupport = Number.isFinite(options.minSupport) ? options.minSupport : 0.35;
  if (!enabled) return null;
  if (!answer || !String(answer).trim()) return null;
  if (!context || !String(context).trim()) return null;

  const sentences = splitAnswerSentences(answer);
  if (sentences.length === 0) return null;

  const contextBigrams = charBigrams(context);

  const details = sentences.map((text) => {
    const score = supportScore(charBigrams(text), contextBigrams);
    return { text: text.slice(0, 120), score: Math.round(score * 100) / 100 };
  });

  const unsupported = details.filter(d => d.score < minSupport);
  const supportedCount = details.length - unsupported.length;
  const coverage = Math.round((supportedCount / details.length) * 100) / 100;

  const level = coverage >= 0.85 ? 'high' : coverage >= 0.6 ? 'medium' : 'low';

  return {
    totalSentences: details.length,
    supportedCount,
    unsupportedCount: unsupported.length,
    coverage,
    level,
    minSupport,
    unsupportedSentences: unsupported.slice(0, 5), // 最多回传 5 条，控制 SSE 体积
  };
}

module.exports = {
  checkGrounding,
  splitAnswerSentences,
  supportScore,
  charBigrams,
  BOILERPLATE_PATTERNS,
};
