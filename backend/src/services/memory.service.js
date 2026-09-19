"use strict";

const { redis: store } = require('./memory-store');
const { ShortTermMemory } = require('./memory/short-term-memory');
const { aiService } = require('./ai.service');
const { LongTermMemory, MEMORY_TYPES } = require('./memory/long-term-memory');
const { UserProfile } = require('./memory/user-profile');
const { parseRedisList } = require('./memory/helpers');
const config = require('../config');
const { logEvent } = require('./observability.service');

/**
 * MemoryService — Agent 记忆系统（语义检索版）
 *
 * 三层记忆架构：
 * 1. 短期记忆 (short-term): 当前会话上下文压缩
 * 2. 长期记忆 (long-term): 跨会话持久化，按 偏好/错误反馈/事实/外部参考 四类治理，
 *    支持语义检索 + 关键词混合匹配、两级去重合并
 * 3. 用户画像 (profile): 自动从对话中提取
 *
 * 检索策略：embedding 语义相似度 + 关键词匹配，加权排序
 * 提取策略（2026-09-03 升级）：优先 LLM 四类提取，失败回退正则提取
 */

const MAX_LONG_TERM_CHARS = 3000;

/**
 * 从 LLM 输出中防御性解析 JSON 数组（允许模型在数组前后包裹多余文字）
 * @returns {Array|null} 解析成功返回数组，失败返回 null
 */
function parseJsonArray(text) {
  if (!text) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

class MemoryService {
  constructor() {
    this.shortTerm = new ShortTermMemory(aiService);
    this.longTerm = new LongTermMemory();
    this.profile = new UserProfile();
  }

  // ==================== 短期记忆（委托） ====================

  async saveShortTerm(userId, summary) {
    return this.shortTerm.save(userId, summary);
  }

  async getShortTerm(userId) {
    return this.shortTerm.get(userId);
  }

  async clearShortTerm(userId) {
    return this.shortTerm.clear(userId);
  }

  // ==================== 对话记忆（组合写入） ====================

  /**
   * 保存一轮对话到短期记忆并提取长期记忆（异步，不阻塞调用方）
   * @param {string} userId - 用户 ID，为空则跳过
   * @param {string} message - 用户消息
   * @param {string} reply - 助手回复
   */
  saveChatMemory(userId, message, reply) {
    if (!userId) return;
    const summary = `用户问：${message}\n助手答：${(reply || '').substring(0, 200)}`;
    this.saveShortTerm(userId, summary).catch(() => {});
    this.extractAndSave(userId, message, reply || '').catch(() => {});
  }

  // ==================== 长期记忆（委托） ====================

  async addLongTerm(userId, memory) {
    return this.longTerm.add(userId, memory);
  }

  async getLongTerm(userId, query) {
    return this.longTerm.get(userId, query);
  }

  async removeLongTerm(userId, memoryId) {
    return this.longTerm.remove(userId, memoryId);
  }

  async clearLongTerm(userId) {
    return this.longTerm.clear(userId);
  }

  // ==================== 用户画像（委托） ====================

  async updateProfile(userId, profile) {
    return this.profile.update(userId, profile);
  }

  async getProfile(userId) {
    return this.profile.get(userId);
  }

  // ==================== 上下文注入 ====================

  async buildMemoryContext(userId, currentMessage = '') {
    if (!userId) return '';
    const parts = [];

    // 用户画像
    const profile = await this.getProfile(userId);
    const profileFields = Object.entries(profile)
      .filter(([k]) => !k.startsWith('updatedAt') && !k.startsWith('createdAt'))
      .map(([k, v]) => `- ${k}: ${v}`);
    if (profileFields.length > 0) {
      parts.push(`[用户信息]\n${profileFields.join('\n')}`);
    }

    // 长期记忆（语义检索 TOP 5）
    const longTerm = await this.getLongTerm(userId, currentMessage);
    if (longTerm.length > 0) {
      const topMemories = longTerm.slice(0, 5);
      const memText = topMemories
        .filter(m => m._score > 0.15)
        .map(m => `- [${MEMORY_TYPES[m.type] || m.type}] ${m.content}`)
        .join('\n');
      if (memText) {
        parts.push(`[相关记忆]\n${memText}`);
      }
    }

    // 短期记忆
    const shortTerm = await this.getShortTerm(userId);
    if (shortTerm) {
      parts.push(`[近期对话]\n${shortTerm}`);
    }

    if (parts.length === 0) return '';
    const context = parts.join('\n\n');
    return context.length > MAX_LONG_TERM_CHARS
      ? context.substring(0, MAX_LONG_TERM_CHARS) + '\n...'
      : context;
  }

  // ==================== 自动记忆提取 ====================

  async extractAndSave(userId, userMessage, aiReply) {
    if (!userId || !userMessage) return;

    // 1. 提取用户画像
    await this.profile.extract(userId, userMessage);

    // 2. 提取关键问答（包含具体数据）
    if (aiReply && aiReply.length > 30 && aiReply.length < 3000) {
      const hasSpecificData = /\d{4}[-/]\d{2}|成绩|课表|考试|学分|绩点|GPA|教室|图书馆/.test(aiReply);
      if (hasSpecificData) {
        await this.addLongTerm(userId, {
          type: 'qa',
          content: `用户问：${userMessage}\n回答：${aiReply.substring(0, 500)}`,
          source: 'conversation',
          confidence: 0.7,
        });
      }
    }

    // 3. 记忆提取：优先 LLM 四类提取（偏好/错误反馈/事实/外部参考），
    //    LLM 不可用/失败时回退正则提取（只覆盖显式偏好句式）
    const handledByLLM = await this._extractMemoriesWithLLM(userId, userMessage, aiReply);
    if (!handledByLLM) {
      await this._extractPreferencesByRegex(userId, userMessage);
    }
  }

  /**
   * LLM 记忆提取（四类治理的核心）：
   * 从一轮对话中抽取跨会话仍有价值的信息，分类为 偏好/错误反馈/事实/外部参考。
   * 相比正则只能匹配"我喜欢/不要"等显式句式，LLM 能识别纠错（"不对，应该是…"）、
   * 隐含偏好（"太长了"）和稳定事实，且输出已归一化的短句，直接入库。
   *
   * @returns {Promise<boolean>} true=LLM 路径已处理（含"无可提取"），false=需回退正则
   */
  async _extractMemoriesWithLLM(userId, userMessage, aiReply) {
    if (!config.memory?.llmExtractionEnabled) return false;
    // 测试环境跳过真实 LLM 调用（单测覆盖走正则回退路径）
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return false;
    if (!aiReply || aiReply.length < 5) return false;

    const prompt = `你是记忆提取器。从下面这轮对话中抽取值得长期记住的用户信息，按四类输出 JSON 数组：
- preference（用户偏好）：对回答风格、格式、详略的要求
- feedback（错误反馈）：用户指出的错误、纠正（这是最高优先级的学习信号）
- fact（事实）：用户的稳定事实（专业、年级、课程、目标等）
- reference（外部参考）：用户提到的重要资料、链接、文件

规则：
1. 只抽取跨会话仍有价值的信息；闲聊和一次性问题不要抽取
2. content 用一句简洁中文陈述（不超过 60 字），不要照抄长原文
3. 没有值得记住的内容时输出 []
4. 只输出 JSON 数组，不要多余文字

输出格式：[{"type":"preference|feedback|fact|reference","content":"...","confidence":0.0~1.0}]

用户：${String(userMessage).substring(0, 500)}
助手：${String(aiReply).substring(0, 800)}`;

    try {
      const result = await aiService.getCompletion(prompt, [], { timeout: 8000, retries: 0 });
      const items = parseJsonArray(result.content);
      if (items === null) {
        logEvent('warn', 'memory_llm_extract_parse_failed_regex_fallback', { message: 'LLM 记忆提取输出解析失败，回退正则提取' });
        return false;
      }
      let saved = 0;
      for (const item of items.slice(0, 3)) {
        const type = typeof item?.type === 'string' && MEMORY_TYPES[item.type] ? item.type : null;
        const content = String(item?.content || '').trim();
        if (!type || content.length < 4 || content.length > 200) continue;
        const confidence = Math.min(Math.max(Number(item.confidence) || 0.7, 0.5), 0.95);
        await this.addLongTerm(userId, { type, content, source: 'llm-extraction', confidence });
        saved++;
      }
      if (saved > 0) logEvent('info', 'memory_llm_extract_saved', { saved });
      return true;
    } catch (err) {
      logEvent('warn', 'memory_llm_extract_failed_regex_fallback', { error: err.message });
      return false;
    }
  }

  /**
   * 正则偏好提取（LLM 提取的兜底）：仅覆盖"我喜欢/不要"等显式句式
   */
  async _extractPreferencesByRegex(userId, userMessage) {
    const prefPatterns = [
      /我喜欢|我偏好|我习惯|请用|请以|我更(喜欢|倾向|愿意)/,
      /我不喜欢|我不爱|不要|别给/,
    ];
    for (const pattern of prefPatterns) {
      if (pattern.test(userMessage)) {
        await this.addLongTerm(userId, {
          type: 'preference',
          content: userMessage,
          source: 'conversation',
          confidence: 0.6,
        });
        break;
      }
    }
  }

  // ==================== 统计 ====================

  async getStats(userId) {
    const profile = await this.getProfile(userId);
    const shortTermRaw = await store.lrange(`memory:${userId}:short_term`, 0, -1);
    const longTermRaw = await store.lrange(`memory:${userId}:long_term`, 0, -1);

    const shortTermList = parseRedisList(shortTermRaw);
    const longTermList = parseRedisList(longTermRaw);

    return {
      shortTermCount: shortTermList.length,
      longTermCount: longTermList.length,
      embeddingCount: longTermList.filter(m => m.embedding).length,
      profileFields: Object.keys(profile).length,
      embedderAvailable: this.longTerm.embedder.isAvailable,
    };
  }
}

module.exports = { MemoryService };

