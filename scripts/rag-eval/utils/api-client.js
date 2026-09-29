/**
 * RAG 评测 API 请求封装
 * 复用项目现有的后端接口和 LLM API
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../backend/.env') });
config({ path: resolve(__dirname, '../../../.env') });
config({ path: resolve(__dirname, '../.env') });

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://maas-api.cn-huabei-1.xf-yun.com/v2';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'xopqwen36v35b';

let cachedCookie = null;

function getCredential(name, fallbackName = '') {
  return process.env[name] || (fallbackName ? process.env[fallbackName] : '') || '';
}

function extractCookieHeader(response) {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);

  return setCookies
    .map(cookie => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

export async function loginForCookie() {
  const explicitCookie = getCredential('RAG_EVAL_COOKIE', 'EVAL_COOKIE');
  if (explicitCookie) {
    cachedCookie = explicitCookie;
    return cachedCookie;
  }

  if (cachedCookie) return cachedCookie;

  // 评测登录仅支持显式 Cookie（RAG_EVAL_COOKIE），不再支持凭证换 Cookie
  return '';
}

export async function getAuthHeaders(extraHeaders = {}) {
  const cookie = await loginForCookie();
  return {
    ...extraHeaders,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function fetchWithAuth(url, options = {}) {
  const headers = await getAuthHeaders(options.headers || {});
  const response = await fetch(url, { ...options, headers });

  if (response.status === 401 && !cachedCookie) {
    throw new Error('接口需要登录：请设置 RAG_EVAL_COOKIE 后重试');
  }

  return response;
}

/**
 * 调用 RAG 流式接口，返回完整回答和来源
 * @param {string} question - 用户问题
 * @param {Array} history - 对话历史
 * @param {Object} options - RAG 选项，例如 category
 * @returns {Promise<{answer: string, sources: Array, retrieval: Object}>}
 */
export async function ragQuery(question, history = [], options = {}) {
  // 阈值覆盖参数（A/B 评测用）：透传给后端 /api/rag/chat/stream
  const body = { message: question, history, category: options.category };
  for (const key of ['rerankMinScore', 'rerankDropoff', 'rerankTopK', 'maxContextLength']) {
    if (options[key] !== undefined && options[key] !== null && options[key] !== '') body[key] = options[key];
  }
  const response = await fetchWithAuth(`${BACKEND_URL}/api/rag/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RAG API 请求失败: ${response.status} ${response.statusText} ${errorText.substring(0, 200)}`);
  }

  const text = await response.text();
  const lines = text.split('\n').filter(line => line.startsWith('data: '));

  let answer = '';
  let sources = [];
  let retrieval = null;

  for (const line of lines) {
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    try {
      const parsed = JSON.parse(data);
      if (parsed.sources) sources = parsed.sources;
      if (parsed.retrieval) retrieval = parsed.retrieval;
      if (parsed.content) answer += parsed.content;
      if (parsed.error) throw new Error(`RAG 返回错误: ${parsed.error}`);
    } catch (e) {
      if (e.message.includes('RAG 返回错误')) throw e;
    }
  }

  return { answer, sources, retrieval };
}

/**
 * 调用 RAG 非流式接口，返回完整回答、来源和真实增强上下文
 * @param {string} question - 用户问题
 * @param {Array} history - 对话历史
 * @param {Object} options - RAG 选项，例如 category
 * @returns {Promise<{answer: string, sources: Array, context: string, retrieval: Object, model: string, raw: Object}>}
 */
export async function ragChat(question, history = [], options = {}) {
  const response = await fetchWithAuth(`${BACKEND_URL}/api/rag/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: question, history, category: options.category })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RAG API 请求失败: ${response.status} ${response.statusText} ${errorText.substring(0, 200)}`);
  }

  const result = await response.json();
  const data = result.data || result;

  return {
    answer: data.reply || data.answer || '',
    sources: data.sources || [],
    context: data.context || '',
    retrieval: data.retrieval || data._metrics?.retrieval || null,
    model: data.model || '',
    raw: data,
  };
}

/**
 * 调用父段候选检索接口，用于离线人工标注与 MRR 评估
 * @param {string} question - 用户问题
 * @param {Object} options - { category, childTopK, parentTopK, includeChildren }
 * @returns {Promise<Object>}
 */
export async function retrieveParentCandidates(question, options = {}) {
  const response = await fetchWithAuth(`${BACKEND_URL}/api/rag/retrieval/parents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: question,
      category: options.category,
      childTopK: options.childTopK ?? 25,
      parentTopK: options.parentTopK ?? 0,
      includeChildren: options.includeChildren ?? true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`父段候选检索失败: ${response.status} ${response.statusText} ${errorText.substring(0, 200)}`);
  }

  const result = await response.json();
  return result.data || result;
}
/**
 * 添加纯文本/Markdown 文档到知识库
 * @param {{title: string, content: string, category?: string, metadata?: Object}} document
 * @returns {Promise<Object>}
 */
export async function addDocument(document) {
  const response = await fetchWithAuth(`${BACKEND_URL}/api/rag/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(document),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`添加文档失败: ${response.status} ${response.statusText} ${errorText.substring(0, 200)}`);
  }

  const result = await response.json();
  return result.data || result;
}
/**
 * 获取知识库文档列表
 * @returns {Promise<Array>}
 */
export async function listDocuments({ limit = 500 } = {}) {
  const response = await fetchWithAuth(`${BACKEND_URL}/api/rag/documents?page=1&limit=${limit}`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`获取文档列表失败: ${response.status} ${errorText.substring(0, 200)}`);
  }
  const result = await response.json();
  return result.data?.documents || [];
}

/**
 * 获取文档详情（含内容）
 * @param {string} docId
 * @returns {Promise<Object>}
 */
export async function getDocument(docId) {
  const response = await fetchWithAuth(`${BACKEND_URL}/api/rag/documents/${docId}`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`获取文档详情失败: ${response.status} ${errorText.substring(0, 200)}`);
  }
  const result = await response.json();
  return result.data;
}

/**
 * 调用 LLM（OpenAI 兼容接口），用于 RAGAS judge
 * @param {string} systemPrompt - 系统提示
 * @param {string} userMessage - 用户消息
 * @param {Object} options - 配置项
 * @returns {Promise<string>}
 */
export async function llmJudge(systemPrompt, userMessage, options = {}) {
  const { temperature = 0, maxTokens = 2000 } = options;

  const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API 请求失败: ${response.status} ${errText.substring(0, 200)}`);
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

/**
 * 带重试的请求封装
 * @param {Function} fn - 要执行的异步函数
 * @param {number} maxRetries - 最大重试次数
 * @param {number} delayMs - 重试间隔
 * @returns {Promise<*>}
 */
export async function withRetry(fn, maxRetries = 3, delayMs = 2000) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) throw err;
      console.warn(`  [重试 ${i + 1}/${maxRetries}] ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

/**
 * 检查后端是否可用
 * @returns {Promise<boolean>}
 */
export async function checkBackendHealth() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

export { BACKEND_URL, AI_BASE_URL, AI_API_KEY, AI_MODEL };
