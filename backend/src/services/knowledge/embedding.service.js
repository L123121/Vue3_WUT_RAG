"use strict";

const { logEvent } = require('../observability/observability.service');

const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

const DEFAULT_DENSE_DIM = 512;   // BGE-small-zh 输出 512 维
const DEFAULT_SPARSE_DIM = 250002;
const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
const DEFAULT_CACHE_DIR = path.resolve(__dirname, '../../../.model-cache');
const EMBED_CACHE_MAX = 2000;    // 向量缓存上限，防止无限增长
const DEFAULT_BATCH_SIZE = 16;   // 单次 ONNX 推理的批大小

/**
 * BGE-zh v1.5 系列是 s2p（sentence-to-passage）非对称检索模型：
 * 模型卡要求**查询侧**加该指令前缀，**文档侧**不加。
 * 漏掉前缀等于放弃了模型训练时的非对称性——索引侧向量不变，所以补上后无需重建索引。
 */
const BGE_QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

// BM25 参数：k1 控制词频饱和速度，b 控制文档长度归一化强度（取文献常用默认值）
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 稀疏通道停用词（bigram 级）。提到模块作用域，避免每次编码都重建 Set */
const SPARSE_STOP_WORDS = new Set(['的', '了', '是', '在', '和', '与', '及', '有', '也', '都', '这', '那', '个', '就', '而', '但', '或', '被', '把', '对', '从', '以', '到', '让', '为', '所', '得', '着', '过', '吧', '呢', '啊', '吗', '嘛']);

/**
 * 语料级稀疏通道统计（BM25 所需）：词项文档频率、文档数、总词数。
 *
 * 存在的理由：稀疏权重里没有 idf、没有长度归一化时，"学校""课程"这类高频词
 * 与"缓考""推免"这类专有词权重相同，专有名词召回吃亏；而上线后权重是烤进
 * 向量的，所以统计必须**持久化**——否则进程重启后查询侧拿不到同一份 idf，
 * 就会变成"文档侧带 idf、查询侧不带"的错配，比不加更糟。
 */
class SparseStats {
  constructor({ df, docCount = 0, totalLen = 0 } = {}) {
    this.df = df instanceof Map ? df : new Map();
    this.docCount = docCount;
    this.totalLen = totalLen;
  }

  get avgLen() {
    return this.docCount > 0 ? this.totalLen / this.docCount : 0;
  }

  /** BM25 平滑 idf：ln((N - df + 0.5)/(df + 0.5) + 1)；未见词 df=0 → idf 取上界 */
  idf(key) {
    const df = this.df.get(key) || 0;
    return Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);
  }

  /** 紧凑序列化：keys/counts 双数组比 [{k,v}] 体积小得多 */
  toJSON() {
    return {
      keys: [...this.df.keys()],
      counts: [...this.df.values()],
      docCount: this.docCount,
      totalLen: this.totalLen,
    };
  }

  static fromJSON(raw) {
    if (!raw || !Array.isArray(raw.keys) || !Array.isArray(raw.counts)) return new SparseStats();
    const df = new Map();
    raw.keys.forEach((key, i) => df.set(Number(key), raw.counts[i] || 0));
    return new SparseStats({ df, docCount: raw.docCount || 0, totalLen: raw.totalLen || 0 });
  }
}

// ── 语料统计单例（模块级：多处 new EmbeddingService() 必须共用同一份 idf）──
let _sparseStats = null;
// 统计版本号：参与向量缓存 key，统计变更后自动失效旧缓存，
// 避免沿用"用旧 idf 算出的文档向量"与新查询向量错配。
let _sparseStatsVersion = 0;

// ── 模块级质量信号（跨实例共享）──────────────────────────────────────
// isAvailable 恒为 true（缺模型时 n-gram 降级仍能产出向量），所以"可用"不等于
// "质量正常"：健康检查全绿而检索质量已塌，正是 round-22 生产事故的形态。
// 降级次数单独累计，供健康检查读取；放在模块作用域是为了让各处的
// new EmbeddingService() 实例共享同一份观测值。
let _degradedEncodeCount = 0;
let _lastDegradedAt = null;

/**
 * 检索侧 embedding 健康快照（同步、无副作用，不触发模型加载）
 * @returns {{status: 'ok'|'degraded', degradedEncodeCount: number, lastDegradedAt: string|null}}
 */
function getEmbeddingHealth() {
  return {
    status: _degradedEncodeCount > 0 ? 'degraded' : 'ok',
    degradedEncodeCount: _degradedEncodeCount,
    lastDegradedAt: _lastDegradedAt,
    sparseStats: _sparseStats
      ? { status: 'ready', docCount: _sparseStats.docCount, avgLen: Number(_sparseStats.avgLen.toFixed(2)), terms: _sparseStats.df.size }
      : { status: 'absent', docCount: 0, avgLen: 0, terms: 0 },
  };
}

/** 当前语料统计（null = 未构建/未加载，此时稀疏权重退回纯 tf） */
function getSparseStats() {
  return _sparseStats;
}

/**
 * 激活一份语料统计。文档侧与查询侧共用，故变更后必须重新索引（文档侧权重已烤进向量）。
 * 版本号自增使向量缓存失效，避免新旧 idf 混用。
 */
function setSparseStats(stats) {
  _sparseStats = stats || null;
  _sparseStatsVersion += 1;
}

/**
 * BGE-small-zh Embedding 服务
 *
 * 本地 BGE-small-zh (ONNX) 作为唯一 embedding 模型，确保入库和查询使用同一语义空间。
 * 模型不可用时自动降级到 n-gram fallback。
 */
class EmbeddingService {
  constructor() {
    this.model = config.embedding.model || DEFAULT_MODEL;
    this.cacheDir = config.embedding.cacheDir || DEFAULT_CACHE_DIR;
    this.localFilesOnly = config.embedding.localFilesOnly !== false;
    this.sparseDim = config.embedding.sparseDim || DEFAULT_SPARSE_DIM;
    this.batchSize = Math.max(1, config.embedding.batchSize || DEFAULT_BATCH_SIZE);
    this.queryInstructionEnabled = config.embedding.queryInstructionEnabled !== false;
    this.sparseIdfEnabled = config.embedding.sparseIdfEnabled !== false;
    this._cache = new Map();
    this._localModel = null;      // 本地 ONNX BGE 模型实例
    this._modelLoading = null;    // 加载中的 promise（防重复加载）
  }

  /**
   * 懒加载本地 BGE ONNX 模型
   */
  async _ensureLocalModel() {
    if (this._localModel) return this._localModel;
    if (this._modelLoading) return this._modelLoading;

    this._modelLoading = (async () => {
      try {
        const { env, pipeline } = require('@huggingface/transformers');
        env.cacheDir = this.cacheDir;
        env.localModelPath = this.cacheDir;   // local_files_only 时从该目录找模型
        env.allowLocalModels = true;
        env.allowRemoteModels = !this.localFilesOnly;

        const extractor = await pipeline('feature-extraction', this.model, {
          dtype: 'q8',
          cache_dir: this.cacheDir,
          local_files_only: this.localFilesOnly,
        });
        logEvent('info', 'embedding_local_model_loaded', { model: this.model, dim: DEFAULT_DENSE_DIM });
        this._localModel = extractor;
        return extractor;
      } catch (err) {
        logEvent('warn', 'embedding_local_model_load_failed', { error: err.message });
        this._localModel = null;
        return null;
      }
    })();

    return this._modelLoading;
  }

  /**
   * 文档侧混合向量（索引/入库路径）：按模型卡要求**不加**查询指令前缀
   */
  async embedHybrid(text) {
    return this._embedOne(text, 'doc');
  }

  /**
   * 查询侧混合向量（检索路径）：BGE-zh v1.5 要求加指令前缀
   *
   * 前缀只作用于 dense 编码；sparse 仍基于原始文本——否则指令词会进入
   * 稀疏通道，与所有文档产生字面重叠、给全库加噪。
   * 索引侧向量不变，所以开启该前缀**无需重建索引**，可当天 A/B 对比收益。
   */
  async embedQuery(text) {
    return this._embedOne(text, this.queryInstructionEnabled ? 'query' : 'doc');
  }

  /**
   * 单条编码统一入口。
   * mode 必须参与缓存 key：查询与文档的向量不同，共用 key 会互相命中
   * （同一句话既当文档又当查询的场景下会拿到错误的向量）。
   */
  async _embedOne(text, mode) {
    if (!text || !String(text).trim()) return null;

    const cacheKey = this._cacheKey(text, mode);
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    const localResult = await this._localHybridEmbed(text, { queryMode: mode === 'query' });
    this._cacheSet(cacheKey, localResult);
    return localResult;
  }

  /**
   * 批量 embedding（文档侧）：缓存命中直接复用，未命中的按 batchSize 分组，
   * 每组一次前向推理；批次失败时回退逐条路径，保持 degraded 语义不变。
   */
  async embedBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const results = new Array(texts.length).fill(null);
    const pending = [];

    texts.forEach((text, index) => {
      if (!text || !String(text).trim()) return;
      const cacheKey = this._cacheKey(text, 'doc');
      if (this._cache.has(cacheKey)) {
        results[index] = this._cache.get(cacheKey);
      } else {
        pending.push({ text, index, cacheKey });
      }
    });

    if (pending.length === 0) return results;

    for (let start = 0; start < pending.length; start += this.batchSize) {
      const slice = pending.slice(start, start + this.batchSize);
      const denseList = await this._localDenseBatch(slice.map(item => item.text));

      if (denseList) {
        // 整批成功：sparse 仍是纯函数，逐条算即可
        slice.forEach((item, i) => {
          const vector = denseList[i];
          const embedding = {
            dense: vector,
            sparse: this._localSparse(item.text),
            model: 'BGE-small-zh:local-onnx',
            dimensions: vector.length,
            degraded: false,
          };
          this._cacheSet(item.cacheKey, embedding);
          results[item.index] = embedding;
        });
      } else {
        // 批次失败（模型缺失/形状异常）：回退逐条，逐条也会各自走 n-gram 降级
        for (const item of slice) {
          const embedding = await this._localHybridEmbed(item.text);
          this._cacheSet(item.cacheKey, embedding);
          results[item.index] = embedding;
        }
      }
    }

    return results;
  }

  /**
   * 本地 BGE-small-zh dense + n-gram sparse 混合向量
   * 模型缺失/推理失败时静默降级 n-gram，此时 model 标签必须如实反映（degraded: true），
   * 否则健康检查全绿但检索质量已塌（round-22 生产事故的排查教训）
   *
   * @param {string} text
   * @param {{queryMode?: boolean}} [options] - queryMode 时 dense 走查询指令前缀
   */
  async _localHybridEmbed(text, { queryMode = false } = {}) {
    const { vector: dense, degraded } = await this._localDense(text, { queryMode });
    return {
      dense,
      sparse: this._localSparse(text),
      model: degraded ? 'ngram-fallback' : 'BGE-small-zh:local-onnx',
      dimensions: dense.length,
      degraded,
    };
  }

  /**
   * 本地 BGE-small-zh 生成 dense 向量（512 维），失败降级 n-gram
   * @returns {Promise<{vector: number[], degraded: boolean}>}
   */
  async _localDense(text, { queryMode = false } = {}) {
    if (!text) return { vector: new Array(DEFAULT_DENSE_DIM).fill(0), degraded: false };

    try {
      const model = await this._ensureLocalModel();
      if (model) {
        const result = await model(this._encodeText(text, queryMode), { pooling: 'cls', normalize: true });
        return { vector: Array.from(result.data), degraded: false };
      }
    } catch (err) {
      logEvent('warn', 'embedding_infer_failed_ngram_fallback', { error: err.message });
    }

    // n-gram fallback：模型缺失或推理失败，这里才是质量真正塌掉的地方。
    // 必须让健康检查看得见（见 getEmbeddingHealth），否则就是"全绿但已塌"。
    _degradedEncodeCount += 1;
    _lastDegradedAt = new Date().toISOString();
    return { vector: this._fallbackDense(text), degraded: true };
  }

  /**
   * 批量 dense 编码：一次前向喂整批文本
   *
   * 逐条 await 会把 ONNX 的固定开销（算子调度、内存复用、会话进出）
   * 重复摊在每条上；批量前向只摊一次，索引吞吐提升数倍且不改语义。
   *
   * @param {string[]} texts
   * @returns {Promise<number[][]|null>} 失败返回 null，交由调用方回退逐条路径
   */
  async _localDenseBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];

    // 单条无需批处理，复用单条路径避免张量维度判断
    if (texts.length === 1) {
      const one = await this._localDense(texts[0]);
      return one.degraded ? null : [one.vector];
    }

    try {
      const model = await this._ensureLocalModel();
      if (!model) return null;

      const result = await model(texts, { pooling: 'cls', normalize: true });
      const dims = result.dims || [];
      const dim = dims[dims.length - 1] || DEFAULT_DENSE_DIM;
      const flat = result.data;
      if (!flat || flat.length !== dim * texts.length) {
        logEvent('warn', 'embedding_batch_shape_unexpected', { dims: dims.join('x'), expected: dim * texts.length, actual: flat ? flat.length : 0 });
        return null;
      }

      const out = [];
      for (let i = 0; i < texts.length; i++) {
        out.push(Array.from(flat.slice(i * dim, (i + 1) * dim)));
      }
      return out;
    } catch (err) {
      logEvent('warn', 'embedding_batch_infer_failed_fallback', { error: err.message, size: texts.length });
      return null;
    }
  }

  /**
   * 查询/文档编码文本：查询侧补模型要求的指令前缀
   */
  _encodeText(text, queryMode) {
    if (!queryMode || !this.queryInstructionEnabled) return text;
    return `${BGE_QUERY_INSTRUCTION}${text}`;
  }

  /**
   * n-gram 哈希 dense（512 维）——仅作为 fallback
   */
  _fallbackDense(text) {
    const normalized = String(text).toLowerCase().trim();
    const vec = new Float64Array(DEFAULT_DENSE_DIM);

    for (let i = 0; i < normalized.length - 1; i++) {
      const hash = this._hashStr(normalized.substring(i, i + 2)) % DEFAULT_DENSE_DIM;
      vec[hash] += 1;
    }
    for (let i = 0; i < normalized.length - 2; i++) {
      const hash = this._hashStr(normalized.substring(i, i + 3)) % DEFAULT_DENSE_DIM;
      vec[hash] += 1.5;
    }
    for (const ch of normalized) {
      const hash = this._hashStr(ch) % DEFAULT_DENSE_DIM;
      vec[hash] += 0.5;
    }

    // L2 归一化
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;

    return Array.from(vec);
  }

  /**
   * 词项计数（bigram + trigram）。
   * DF 预统计与权重计算共用同一个 tokenizer——两处各写一份的话，
   * df 里统计的词项和权重里加权的词项会悄悄对不上。
   * @returns {Map<number, number>} 哈希词项 → 词频
   */
  _tokenize(text) {
    const normalized = String(text || '').toLowerCase().trim();
    const tokens = new Map();
    if (!normalized) return tokens;

    for (let i = 0; i < normalized.length - 1; i++) {
      const bigram = normalized.substring(i, i + 2);
      if (SPARSE_STOP_WORDS.has(bigram)) continue;
      const key = (this._hashStr(`b:${bigram}`) >>> 0) % 0xFFFFFE;
      tokens.set(key, (tokens.get(key) || 0) + 1);
    }

    for (let i = 0; i < normalized.length - 2; i++) {
      const trigram = normalized.substring(i, i + 3);
      const key = (this._hashStr(`t:${trigram}`) >>> 0) % 0xFFFFFE;
      tokens.set(key, (tokens.get(key) || 0) + 1);
    }

    return tokens;
  }

  /**
   * 稀疏通道词项权重（BM25）
   *
   * 此前注释自称"BM25 风格"，实现却只有 `tokens[key] += 1` 计数：
   * 没有 idf、没有长度归一化。于是高频通用词与专有名词同权，专有名词召回吃亏；
   * 长块还会凭词频总量压倒短块。
   *
   * 现在：weight = idf * tf*(k1+1) / (tf + k1*(1 - b + b*len/avgLen))，
   * idf 与 avgLen 来自语料统计（索引前构建并持久化）。
   *
   * 一致性是硬约束：统计缺失时**文档侧与查询侧一起**退回纯 tf。
   * 若只有一侧带 idf，点积会被系统性压低，比不加更差。
   */
  _localSparse(text) {
    const tf = this._tokenize(text);
    const stats = this.sparseIdfEnabled ? _sparseStats : null;
    if (!stats || stats.docCount === 0) return Object.fromEntries(tf);

    let len = 0;
    for (const freq of tf.values()) len += freq;
    const avgLen = stats.avgLen > 0 ? stats.avgLen : len || 1;

    const weights = {};
    for (const [key, freq] of tf) {
      const norm = 1 - BM25_B + BM25_B * (len / avgLen);
      weights[key] = (stats.idf(key) * freq * (BM25_K1 + 1)) / (freq + BM25_K1 * norm);
    }
    return weights;
  }

  /**
   * 由语料块文本构建 df 统计（索引前调用一次），返回而未激活；
   * 调用方决定何时 setSparseStats + 持久化。
   * @param {string[]} chunkTexts
   * @returns {SparseStats}
   */
  buildSparseStats(chunkTexts) {
    const df = new Map();
    let docCount = 0;
    let totalLen = 0;

    for (const text of chunkTexts || []) {
      const tf = this._tokenize(text);
      if (tf.size === 0) continue;
      docCount += 1;
      for (const [key, freq] of tf) {
        df.set(key, (df.get(key) || 0) + 1);
        totalLen += freq;
      }
    }

    return new SparseStats({ df, docCount, totalLen });
  }

  _cacheKey(text, mode = 'doc') {
    // 用全文哈希做 key：之前截前 200 字符，两个同前缀长文本会错误命中同一向量
    // mode 区分 query/doc：两者走不同编码路径，向量不同，不能共用 key
    // s 版本号让语料统计变更后旧文档向量自动失效（否则新查询 vs 旧 idf 向量错配）
    const digest = crypto.createHash('md5').update(String(text).trim()).digest('hex');
    return `emb:${this.model}:${mode}:s${_sparseStatsVersion}:${digest}`;
  }

  /**
   * 写入向量缓存（超过上限时淘汰最旧条目，防止无限增长）
   */
  _cacheSet(key, value) {
    this._cache.set(key, value);
    if (this._cache.size > EMBED_CACHE_MAX) {
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) this._cache.delete(oldestKey);
    }
  }

  _hashStr(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  // ==================== 静态工具方法 ====================

  static cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  static sparseSimilarity(a, b) {
    if (!a || !b) return 0;
    const entriesA = Object.entries(a);
    if (!entriesA.length) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (const [key, valA] of entriesA) {
      const valB = b[key] || 0;
      dot += valA * valB;
      normA += valA * valA;
    }
    for (const valB of Object.values(b)) {
      normB += valB * valB;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  /**
   * 能力可用性：模型缺失时仍能产出 n-gram 向量，故恒为 true。
   * 该信号被 memory 等调用方当作"能否产出向量"的门，改成 false 会让整条
   * 记忆 embedding 被静默跳过，所以**不要**用它表达质量。
   * 质量信号请读 getEmbeddingHealth()（降级计数）。
   */
  get isAvailable() {
    return true;
  }
}

module.exports = {
  EmbeddingService,
  SparseStats,
  getEmbeddingHealth,
  getSparseStats,
  setSparseStats,
  BGE_QUERY_INSTRUCTION,
};


