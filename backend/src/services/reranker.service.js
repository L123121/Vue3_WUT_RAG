"use strict";

const { logEvent } = require('./observability.service');

/**
 * Cross-encoder reranker using BGE-reranker-base (INT8, ~278MB)
 *
 * Uses @huggingface/transformers local ONNX inference — no API calls.
 * Replaces the 2-gram sliding-window keyword rerank with semantic reranking.
 *
 * Model: Xenova/bge-reranker-base (ONNX quantized, int8)
 * Cache: .model-cache/Xenova/bge-reranker-base/
 */
const path = require('path');
const crypto = require('crypto');

const MODEL_NAME = 'Xenova/bge-reranker-base';
const MODEL_CACHE_DIR = path.resolve(__dirname, '../../../.model-cache');
const { QueryCache } = require('../utils/query-cache');
const config = require('../config');

// reranker 分数缓存（模块级单例）
const rerankerScoreCache = new QueryCache(
  config?.rag?.rerankerCacheMaxEntries || 2000,
  config?.rag?.cacheTtlMs || 300000,
);

let modelInstance = null;
let loadPromise = null;

class RerankerService {
  /**
   * Lazy-load the reranker model (singleton)
   */
  async _loadModel() {
    if (modelInstance) return modelInstance;
    if (loadPromise) return loadPromise;

    loadPromise = this._doLoad();
    try {
      modelInstance = await loadPromise;
      return modelInstance;
    } catch (err) {
      loadPromise = null; // reset so next call retries
      throw err;
    }
  }

  async _doLoad() {
    // 禁止远程加载，仅使用本地缓存（避免 HuggingFace Hub 被墙导致失败）
    const { env } = require('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.useFS = true;
    env.useFSCache = true;
    env.localModelPath = MODEL_CACHE_DIR;   // local_files_only 时从该目录找模型

    const { AutoTokenizer, AutoModelForSequenceClassification } = require('@huggingface/transformers');

    logEvent('info', 'reranker_model_loading', { model: MODEL_NAME });

    const tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME, {
      cache_dir: MODEL_CACHE_DIR,
      local_files_only: true,
    });

    const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, {
      dtype: 'q8',              // 使用 INT8 ONNX 权重
      cache_dir: MODEL_CACHE_DIR,
      local_files_only: true,
    });

    logEvent('info', 'reranker_model_loaded', {});
    return { tokenizer, model };
  }

  /**
   * 对候选列表做 cross-encoder rerank
   * @param {string} query - 用户原始 query
   * @param {Array<{text: string, score: number}>} candidates - 候选切片列表
   * @param {number} topK - 返回 topK 条
   * @returns {Promise<Array>} 重排后的切片列表（带 _rerankScore）
   */
  async rerank(query, candidates, topK = 5) {
    if (!candidates || candidates.length === 0) return [];
    if (candidates.length === 1) {
      candidates[0]._rerankScore = candidates[0].score || 0;
      candidates[0]._rerankModel = 'skip';
      return candidates;
    }

    const qKey = String(query || '').trim().toLowerCase();

    // 部分缓存命中：已缓存候选直接保留缓存分（不再送模型），仅 miss 的参与推理，
    // 最后合并成一份列表统一排序。candidates 本身不被重排前的切片截断
    let toRank = candidates;
    const cachedCandidates = [];
    if (config?.rag?.cacheEnabled) {
      const uncached = [];
      let allCached = true;
      for (const c of candidates) {
        // 必须全量哈希：截断前 200 字符会让同前缀长候选互撞缓存键（同 embedding 层曾修过的问题）
        const textHash = crypto.createHash('md5')
          .update(String(c.text || '')).digest('hex').slice(0, 12);
        const score = rerankerScoreCache.get(`${qKey}|${textHash}`);
        if (score !== undefined) {
          c._rerankScore = score;
          c._rerankModel = 'cache';
          cachedCandidates.push(c);
        } else {
          allCached = false;
          uncached.push(c);
        }
      }
      if (allCached) {
        candidates.sort((a, b) => (b._rerankScore || 0) - (a._rerankScore || 0));
        return candidates.slice(0, topK);
      }
      if (uncached.length < candidates.length) {
        toRank = uncached;
      }
    }

    let model;
    try {
      model = await this._loadModel();
    } catch (err) {
      logEvent('warn', 'reranker_model_load_failed_fallback', { error: err.message });
      return this._fallbackRank(candidates, topK);
    }

    const { tokenizer, model: rerankerModel } = model;

    try {
      const MAX_RERANK = 30;
      const needed = Math.min(toRank.length, Math.max(topK * 2, 10), MAX_RERANK);
      const slices = toRank.slice(0, needed);
      const texts = slices.map(c => String(c.text || ''));

      const inputs = await tokenizer(texts.map(() => query), {
        text_pair: texts,
        padding: true,
        truncation: true,
        max_length: 512,
        return_tensors: 'pt',
      });

      const outputs = await rerankerModel(inputs);
      const logits = outputs.logits.data;

      for (let i = 0; i < slices.length; i++) {
        const logit = logits[i] ?? 0;
        const score = 1 / (1 + Math.exp(-logit));
        slices[i]._rerankScore = score;
        slices[i]._rerankModel = 'bge-reranker-base';
      }

      // 回写缓存
      if (config?.rag?.cacheEnabled) {
        for (const c of slices) {
          if (c._rerankScore !== undefined) {
            const textHash = crypto.createHash('md5')
              .update(String(c.text || '')).digest('hex').slice(0, 12);
            rerankerScoreCache.set(`${qKey}|${textHash}`, c._rerankScore);
          }
        }
      }

      // 合并缓存命中与本次推理结果，统一按 rerank 分排序
      const allResults = [...slices, ...cachedCandidates];
      allResults.sort((a, b) => (b._rerankScore || 0) - (a._rerankScore || 0));
      return allResults.slice(0, topK);
    } catch (err) {
      logEvent('warn', 'reranker_infer_failed_fallback', { error: err.message });
      return this._fallbackRank(candidates, topK);
    }
  }

  /**
   * fallback 排序（模型缺失/推理失败时）
   *
   * 不能只按原始分数截断：纯 Markdown 标题行（如 "# 推免保研准备与材料清单"）
   * 与查询词字面重叠度极高，会压过真正含内容的段落，导致 LLM 只拿到标题作答。
   * 对"仅标题行"或不足 12 字的候选降权后再排序。
   */
  _fallbackRank(candidates, topK) {
    const demoted = candidates.map(c => {
      const text = String(c.text || '').trim();
      const isHeadingOnly = /^#{1,6}\s*\S{0,30}$/.test(text) || text.length < 12;
      return { ...c, _rerankScore: (c.score || 0) * (isHeadingOnly ? 0.3 : 1), _rerankModel: 'fallback' };
    });
    demoted.sort((a, b) => (b._rerankScore || 0) - (a._rerankScore || 0));
    return demoted.slice(0, topK);
  }
}

module.exports = { RerankerService };

