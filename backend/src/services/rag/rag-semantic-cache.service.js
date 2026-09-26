"use strict";

/**
 * RAG 语义缓存 —— 近义问题复用检索候选池
 *
 * 精确 QueryCache 只能命中字面相同的问题；线上大量提问是同一意图的不同表述
 * （"武理有几个食堂" vs "学校一共多少个食堂"）。本缓存在精确缓存 miss 后，
 * 用本地 BGE dense 向量的余弦相似度找近义问题，命中即复用其候选池，
 * 省掉一次向量库往返。
 *
 * 安全性：候选池只是 reranker 的召回池，reranker 仍按用户原始问题打分，
 * 相似问题共享召回池不会污染精度（与 query-decompose 扩大召回池同一设计原则）。
 *
 * 零外部依赖：余弦用纯数组点积；上限 + TTL 淘汰；写入时相似条目原位更新，
 * 避免缓存被同一意图的表述变体灌满。
 */

class SemanticCache {
  /**
   * @param {number} maxEntries - 最大条目数（超出淘汰最旧）
   * @param {number} ttlMs - 条目过期时间（毫秒）
   * @param {number} threshold - 命中所需的最小余弦相似度（0~1）
   */
  constructor({ maxEntries = 200, ttlMs = 300000, threshold = 0.95 } = {}) {
    this._max = Math.max(maxEntries, 1);
    this._ttl = ttlMs;
    this._threshold = threshold;
    this._entries = []; // { query, vector, value, expiresAt }，最新在尾部
    this._hits = 0;
    this._misses = 0;
  }

  /** 余弦相似度；接受 Array / Float32Array，任一向量无效或零向量返回 0 */
  static cosine(a, b) {
    if (!a || !b) return 0;
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i];
      const y = b[i];
      dot += x * y;
      normA += x * x;
      normB += y * y;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  _purgeExpired() {
    const now = Date.now();
    if (this._entries.some((e) => now > e.expiresAt)) {
      this._entries = this._entries.filter((e) => now <= e.expiresAt);
    }
  }

  /**
   * 按查询向量找近义条目
   * @returns {{ value: any, query: string, similarity: number } | null}
   */
  lookup(vector, { corpusVersion } = {}) {
    if (!vector || this._entries.length === 0) {
      this._misses++;
      return null;
    }
    this._purgeExpired();
    let bestIndex = -1;
    let bestSim = 0;
    for (let i = 0; i < this._entries.length; i++) {
      const entryVersion = this._entries[i].value?.corpusVersion;
      if (corpusVersion !== undefined && entryVersion !== corpusVersion) continue;
      const sim = SemanticCache.cosine(vector, this._entries[i].vector);
      if (sim > bestSim) {
        bestSim = sim;
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || bestSim < this._threshold) {
      this._misses++;
      return null;
    }
    const entry = this._entries[bestIndex];
    // LRU：命中后移到尾部
    this._entries.splice(bestIndex, 1);
    this._entries.push(entry);
    this._hits++;
    return {
      value: entry.value,
      query: entry.query,
      similarity: Math.round(bestSim * 10000) / 10000,
    };
  }

  /**
   * 写入条目；与现有条目相似度超阈值时原位更新其值（同意图变体不重复占位）
   * @returns {boolean} 是否写入
   */
  store(query, vector, value) {
    if (!vector || !vector.length) return false;
    this._purgeExpired();
    const now = Date.now();
    for (const entry of this._entries) {
      if (SemanticCache.cosine(vector, entry.vector) >= this._threshold) {
        entry.value = value;
        entry.query = query;
        entry.expiresAt = now + this._ttl;
        return true;
      }
    }
    while (this._entries.length >= this._max) this._entries.shift();
    this._entries.push({ query, vector, value, expiresAt: now + this._ttl });
    return true;
  }

  get stats() {
    const total = this._hits + this._misses;
    return {
      size: this._entries.length,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
      threshold: this._threshold,
    };
  }

  clear() {
    this._entries = [];
    this._hits = 0;
    this._misses = 0;
  }
}

module.exports = { SemanticCache };
