"use strict";

const config = require('../config');
const { QueryCache } = require('../utils/query-cache');
const { logEvent } = require('./observability.service');

// query rewrite 缓存（模块级单例）：同 query + 最近 6 条历史窗口直接命中
const rewriteCache = new QueryCache(
  config.rag.rewriteCacheMaxEntries || 500,
  config.rag.cacheTtlMs || 300000,
);

// HyDE / Step-Back 缓存（模块级单例）：同 query 直接命中，与 rewrite 缓存同生命周期
const hydeCache = new QueryCache(
  config.rag.rewriteCacheMaxEntries || 500,
  config.rag.cacheTtlMs || 300000,
);
const stepBackCache = new QueryCache(
  config.rag.rewriteCacheMaxEntries || 500,
  config.rag.cacheTtlMs || 300000,
);

/**
 * 检测是否需要改写：有历史 + 含代词/省略
 */
function shouldRewriteQuery(query, history) {
  if (!history || history.length === 0) return false;
  const lastUserMsg = history.filter(h => h.role === 'user').slice(-1)[0];
  if (!lastUserMsg) return false;

  const q = String(query || '').trim();
  // 短 query（< 5 字）大概率是省略
  if (q.length < 5) return true;
  // 含代词/指代
  if (/^(这个|那个|它|它们|他|她|他们|她们|那|那些|这些|这|那|其|该|此)/.test(q)) return true;
  if (/\b(这个|那个|它|它们|他|她|他们|她们|那|那些|这些)\b/.test(q)) return true;
  // 省略式（"那费用呢？""条件呢？"）
  if (/^(那|那.*呢|然后|还有|那.*吗|费用|条件|流程|要求|时间|地点|原因|结果|影响|区别|结果)$/.test(q)) return true;
  if (/^.+呢$/.test(q) && q.length < 8) return true;
  return false;
}

/** 将消息列表 hash 为短字符串，用于 rewrite 缓存 key */
function hashHistory(messages) {
  if (!messages || !messages.length) return 'empty';
  return messages.map(m => `${m.role}:${(m.content || '').slice(0, 100)}`).join('|');
}

/**
 * 用 LLM 改写 query
 * 将带指代/省略的问题补全为独立的自包含问题
 * 处理三个核心难点：
 *   1. 实体消歧：多个候选实体时正确选择
 *   2. 跨轮指代：支持 3 轮内的长跨度指代
 *   3. 语义指代："这个"可能指整句话的意思而非单个名词
 *
 * @param {string} query - 用户最新问题
 * @param {Array} history - 历史消息
 * @param {Object} aiService - 提供 getCompletion 的 AI 服务实例
 * @returns {Promise<string|null>} 改写后的 query，失败返回 null
 */
async function rewriteQuery(query, history, aiService) {
  if (!history || history.length === 0) return null;

  // 缓存拦截：同 query + 最近 6 条历史窗口时直接返回
  if (config.rag.cacheEnabled) {
    const historyHash = hashHistory(history.slice(-6));
    const cacheKey = `${String(query || '').trim().toLowerCase()}|${historyHash}`;
    const cached = rewriteCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  // 取最近 3 轮（6 条消息），在 token 成本和跨度覆盖之间折中
  // 3 轮覆盖绝大多数指代场景，超过 3 轮的指代即使人工也难判断
  const recentHistory = history.slice(-6);
  const historyText = recentHistory
    .map(h => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`)
    .join('\n');

  const prompt = `根据对话历史，将用户最新问题补全为独立的自包含问题。

注意：
1. 如果"这个""那个""它"可能指代多个事物，根据上下文选出最可能的一个
2. 如果"这个"指代前文一整句话的意思，把整句话的要义概括进问题
3. 只输出补全后的问题，不要多余文字
4. 不要添加历史中没有的信息

对话历史：
${historyText}

用户最新问题：${query}

补全后的问题：`;

  try {
    const result = await aiService.getCompletion(prompt, [], { timeout: 5000, retries: 1 });
    const rewritten = (result.content || '').trim().replace(/^["「『]|["」』]$/g, '');
    if (!rewritten || rewritten.length < 2) return null;
    // 防止改写后和原文一模一样（LLM 偷懒）
    if (rewritten === query.trim()) return null;

    // 缓存写入
    if (config.rag.cacheEnabled) {
      const historyHash = hashHistory(recentHistory);
      const cacheKey = `${String(query || '').trim().toLowerCase()}|${historyHash}`;
      rewriteCache.set(cacheKey, rewritten);
    }

    logEvent('info', 'rag_query_rewrite_applied', { query, rewritten });
    return rewritten;
  } catch (err) {
    logEvent('warn', 'rag_query_rewrite_failed', { error: err.message });
    return null;
  }
}

/**
 * HyDE（Hypothetical Document Embedding，假设文档嵌入）
 *
 * 让 LLM 针对问题直接写一段"假设性回答"，再用这段回答（而非原始问题）去做
 * 向量检索。回答与知识库文档同属"陈述式文本"，向量空间中比"问题→文档"更接近，
 * 对短问题/口语化问题的语义召回提升明显。
 *
 * 生成的文档只用于**扩大召回池**（作为 dualRetrieve 的一个额外变体），
 * reranker 仍按用户原始问题打分，因此假设内容不准确也不会影响精度。
 *
 * @param {string} query - 用户原始问题
 * @param {Object} aiService - 提供 getCompletion 的 AI 服务实例
 * @returns {Promise<string|null>} 假设文档文本，失败返回 null
 */
async function generateHydeDocument(query, aiService) {
  const q = String(query || '').trim();
  if (!q) return null;

  const cacheKey = q.toLowerCase();
  if (config.rag.cacheEnabled) {
    const cached = hydeCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const prompt = `请针对以下问题，直接写一段 100~200 字的假设性回答，就像它摘自校园知识库文档一样。

注意：
1. 用陈述句，不要出现"假设""可能""我认为"等不确定措辞
2. 不要输出问题本身，不要解释，只输出这段回答
3. 涉及具体数字/时间/地点时给出合理示例即可

问题：${q}

假设性回答：`;

  try {
    const result = await aiService.getCompletion(prompt, [], { timeout: 5000, retries: 1 });
    const doc = (result.content || '').trim().replace(/^["「『]|["」』]$/g, '');
    // 过短（生成失败）或过长（跑偏成多段）都视为无效
    if (doc.length < 30 || doc.length > 600) return null;

    if (config.rag.cacheEnabled) hydeCache.set(cacheKey, doc);
    logEvent('info', 'rag_hyde_generated', { query: q, docChars: doc.length });
    return doc;
  } catch (err) {
    logEvent('warn', 'rag_hyde_failed', { error: err.message });
    return null;
  }
}

/**
 * Step-Back Prompting（退步提示）
 *
 * 把具体的细节问题抽象为一个更宽泛的"上位问题"，用它额外召回背景/原理类文档。
 * 例："图书馆三楼自习区几点关门" → "武汉理工大学图书馆的开放时间和场馆规则"。
 * 上位问题召回的制度性文档常能补足细节检索漏掉的上下文。
 *
 * 与 HyDE 相同：只用于扩大召回池，reranker 仍按原始问题打分。
 *
 * @param {string} query - 用户原始问题
 * @param {Object} aiService - 提供 getCompletion 的 AI 服务实例
 * @returns {Promise<string|null>} 上位问题，失败或无需抽象返回 null
 */
async function generateStepBackQuery(query, aiService) {
  const q = String(query || '').trim();
  if (!q) return null;
  // 已经很宽泛的短问题没有退步空间
  if (q.length < 6) return null;

  const cacheKey = q.toLowerCase();
  if (config.rag.cacheEnabled) {
    const cached = stepBackCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const prompt = `将以下具体问题抽象为一个更宽泛的上位问题，用于检索相关的背景知识。

注意：
1. 上位问题应涵盖原问题所属的主题/制度/概念，而不是重复原问题
2. 只输出上位问题本身，不要多余文字
3. 如果原问题已经足够宽泛，原样输出原问题

具体问题：${q}

上位问题：`;

  try {
    const result = await aiService.getCompletion(prompt, [], { timeout: 5000, retries: 1 });
    const stepped = (result.content || '').trim().replace(/^["「『]|["」』]$/g, '');
    if (!stepped || stepped.length < 4) return null;
    // 与原问题相同说明无需抽象，不值得多一路检索
    if (stepped === q) return null;

    if (config.rag.cacheEnabled) stepBackCache.set(cacheKey, stepped);
    logEvent('info', 'rag_stepback_generated', { query: q, stepped });
    return stepped;
  } catch (err) {
    logEvent('warn', 'rag_stepback_failed', { error: err.message });
    return null;
  }
}

module.exports = { shouldRewriteQuery, rewriteQuery, hashHistory, generateHydeDocument, generateStepBackQuery };
