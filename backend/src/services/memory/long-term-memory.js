"use strict";

const { redis: store } = require('../memory-store');
const { EmbeddingService } = require('../embedding.service');
const { parseRedisList } = require('./helpers');
const config = require('../../config');
const { logEvent } = require('../observability.service');

const MAX_LONG_TERM = 100;
const KEYWORD_BOOST = 0.3;

/**
 * 记忆四类治理（2026-09-03 新增，借鉴 AgentHarness 长期记忆分类）：
 *   preference - 用户偏好（回答风格/格式/语言）
 *   feedback   - 错误反馈（用户指出的错误与纠正，优先级最高的学习信号）
 *   fact       - 稳定事实（专业/年级/课程/目标等）
 *   reference  - 外部参考（用户提到的重要资料/链接/文件）
 * 历史遗留类型（qa 等）直通，不强制归入四类。
 */
const MEMORY_TYPES = {
  preference: '偏好',
  feedback: '错误反馈',
  fact: '事实',
  reference: '外部参考',
};

const mutationQueues = new Map();

function withMemoryLock(key, task) {
  const previous = mutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  mutationQueues.set(key, current);
  return current.finally(() => {
    if (mutationQueues.get(key) === current) mutationQueues.delete(key);
  });
}

async function replaceList(key, list) {
  await store.del(key);
  if (list.length > 0) await store.rpush(key, JSON.stringify(list));
}

class LongTermMemory {
  constructor() {
    this.embedder = new EmbeddingService();
  }

  /**
   * 添加长期记忆（自动计算 embedding + 两级去重合并）
   *
   * 去重分两级：
   *   1. 文本级：精确匹配 / 高重叠子串（_findDuplicate，零成本）
   *   2. 语义级：同类型记忆 embedding cosine ≥ dedupSimilarity（默认 0.9）
   *      视为重复——限同类型，避免"偏好"吞掉"事实"
   * 命中重复时执行**合并**而非简单 touch：保留信息量更大的内容、
   * confidence 取高并小幅奖励、累计 mergedCount（重复出现的记忆是强信号）
   */
  async add(userId, memory) {
    const key = `memory:${userId}:long_term`;
    const entry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: memory.type || 'fact',
      content: memory.content,
      source: memory.source || 'conversation',
      confidence: memory.confidence || 0.8,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 0,
      embedding: null,
    };
    await this._computeEmbedding(entry);

    return withMemoryLock(key, async () => {
      const raw = await store.lrange(key, 0, -1);
      const list = parseRedisList(raw);
      const dup = this._findDuplicate(list, entry.content)
        || this._findSemanticDuplicate(list, entry);
      if (dup) {
        this._mergeInto(dup, entry);
        logEvent('info', 'memory_dedupe_merged', { type: MEMORY_TYPES[dup.type] || dup.type, id: dup.id, mergedCount: dup.mergedCount, content: String(entry.content).slice(0, 30) });
        await replaceList(key, list);
        return dup;
      }

      list.push(entry);
      while (list.length > MAX_LONG_TERM) {
        // 驱逐价值最低的记忆（原为简单 FIFO 逐出最旧）：
        // confidence 低 + 访问少者优先逐出，高置信/高频记忆即使较老也保留
        let victimIdx = 0;
        let victimScore = Infinity;
        list.forEach((m, i) => {
          const score = (m.confidence || 0.5) + Math.min(m.accessCount || 0, 10) * 0.02;
          if (score < victimScore) {
            victimScore = score;
            victimIdx = i;
          }
        });
        const [removed] = list.splice(victimIdx, 1);
        if (removed) logEvent('info', 'memory_evicted_low_value', { id: removed.id, score: victimScore.toFixed(2) });
      }
      await replaceList(key, list);
      return entry;
    });
  }

  /**
   * 获取长期记忆（混合检索：语义 + 关键词）
   */
  async get(userId, query = '') {
    const key = `memory:${userId}:long_term`;
    const raw = await store.lrange(key, 0, -1);
    const list = parseRedisList(raw);

    if (!query || list.length === 0) return list;

    // 关键词打分
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);

    // 语义打分（异步）
    const queryEmbedding = this.embedder.isAvailable
      ? (await this.embedder.embedHybrid(query).catch(() => null))?.dense || null
      : null;

    // 为没有 embedding 的记忆条目计算（懒加载）
    const missingEmbeddings = queryEmbedding ? list.filter(m => !m.embedding) : [];
    if (missingEmbeddings.length > 0) {
      await Promise.all(
        missingEmbeddings.map(m => this._computeEmbedding(m).catch(() => {}))
      );
    }

    // 混合评分
    const scored = list.map(m => {
      let score = 0;

      // 关键词匹配
      if (queryWords.length > 0) {
        const contentLower = (m.content || '').toLowerCase();
        const matchCount = queryWords.filter(w => contentLower.includes(w)).length;
        score += (matchCount / queryWords.length) * KEYWORD_BOOST;
      }

      // 语义相似度
      if (queryEmbedding && m.embedding) {
        const sim = EmbeddingService.cosineSimilarity(queryEmbedding, m.embedding);
        score += sim * (1 - KEYWORD_BOOST);
      }

      // 访问频率加分
      score += Math.min(m.accessCount || 0, 10) * 0.01;

      return { ...m, _score: score };
    });

    // 更新访问统计（异步）
    scored.filter(m => m._score > 0.1).forEach(m => {
      m.accessCount = (m.accessCount || 0) + 1;
      m.lastAccessedAt = new Date().toISOString();
    });
    const accessed = scored.some(m => m._score > 0.1);
    if (missingEmbeddings.length > 0 || accessed) {
      const updates = new Map(scored.map(({ _score, ...memory }) => [memory.id, memory]));
      await withMemoryLock(key, async () => {
        const latestRaw = await store.lrange(key, 0, -1);
        const latest = parseRedisList(latestRaw);
        const merged = latest.map(memory => updates.get(memory.id) || memory);
        await replaceList(key, merged);
      });
    }

    return scored.sort((a, b) => b._score - a._score);
  }

  /**
   * 查找语义重复的记忆
   */
  _findDuplicate(list, content) {
    if (!content || list.length === 0) return null;

    const contentLower = content.toLowerCase();

    // 先精确匹配
    const exact = list.find(m => m.content && m.content.toLowerCase() === contentLower);
    if (exact) return exact;

    // 再找高度重叠的
    for (const m of list) {
      if (!m.content) continue;
      const mContent = m.content.toLowerCase();
      if (mContent.includes(contentLower) || contentLower.includes(mContent)) {
        if (Math.abs(mContent.length - contentLower.length) < contentLower.length * 0.5) {
          return m;
        }
      }
    }

    return null;
  }

  /**
   * 查找语义重复的记忆（第二级去重）：
   * 同类型 + embedding cosine ≥ dedupSimilarity（默认 0.9）
   * embedding 不可用（无 Key/测试环境）时自动跳过，退化为纯文本级去重
   */
  _findSemanticDuplicate(list, entry) {
    const threshold = config.memory?.dedupSimilarity ?? 0.9;
    if (!entry.embedding || !Array.isArray(entry.embedding) || list.length === 0) return null;

    let best = null;
    let bestSim = threshold;
    for (const m of list) {
      if (!m.embedding || m.type !== entry.type) continue;
      const sim = EmbeddingService.cosineSimilarity(entry.embedding, m.embedding);
      if (sim >= bestSim) {
        best = m;
        bestSim = sim;
      }
    }
    return best;
  }

  /**
   * 重复项合并：保留信息量更大（更长）的内容，confidence 取高并小幅奖励，
   * 累计 mergedCount——同一事实被反复提及是"值得记住"的强信号
   */
  _mergeInto(existing, incoming) {
    const incomingLen = String(incoming.content || '').length;
    const existingLen = String(existing.content || '').length;
    if (incomingLen > existingLen) {
      existing.content = incoming.content;
      if (incoming.embedding) existing.embedding = incoming.embedding;
    } else if (!existing.embedding && incoming.embedding) {
      existing.embedding = incoming.embedding;
    }
    existing.confidence = Math.min(
      Math.max(existing.confidence || 0, incoming.confidence || 0) + 0.05,
      0.99
    );
    existing.lastAccessedAt = new Date().toISOString();
    existing.accessCount = (existing.accessCount || 0) + 1;
    existing.mergedCount = (existing.mergedCount || 1) + 1;
    return existing;
  }

  /**
   * 异步计算并存入 embedding
   */
  async _computeEmbedding(entry) {
    if (!this.embedder.isAvailable || !entry.content) return;
    try {
      const result = await this.embedder.embedHybrid(entry.content);
      entry.embedding = result?.dense || null;
    } catch (err) {
      logEvent('warn', 'memory_embedding_failed', { error: err.message });
    }
  }

  async remove(userId, memoryId) {
    const key = `memory:${userId}:long_term`;
    await withMemoryLock(key, async () => {
      const raw = await store.lrange(key, 0, -1);
      const list = parseRedisList(raw);
      await replaceList(key, list.filter(m => m && m.id !== memoryId));
    });
  }

  async clear(userId) {
    await store.del(`memory:${userId}:long_term`);
  }
}

module.exports = { LongTermMemory, withMemoryLock, MEMORY_TYPES };
