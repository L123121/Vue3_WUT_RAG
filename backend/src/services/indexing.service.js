"use strict";

const { logEvent } = require('./observability.service');

const crypto = require('crypto');
const config = require('../config');
const { EmbeddingService, SparseStats, getSparseStats, setSparseStats } = require('./embedding.service');

/** 稀疏通道语料统计的持久化 key（含 df / docCount / totalLen） */
const SPARSE_STATS_KEY = 'sparse:stats';

/**
 * 文档索引管道
 *
 * 两层父子切片架构：
 *   父级 = 段落（按 \n\n 分割） → 作为 LLM 上下文
 *   子级 = 句子（按 。！？.!? 分割） → 向量化存入 Qdrant 用于检索
 *
 * 检索流程：匹配子级句子 → 取父级段落作为上下文注入 LLM
 *
 * 增量重索引：删除前按内容 hash 取回旧向量，文本未变的 chunk 直接复用 embedding
 * （embedding 是全链路最贵的本地计算），只重算变化的段落。
 */
class IndexingService {
  /**
   * @param {object} [vectorStore] - 向量库实例（默认使用全局单例）
   * @param {object} [embeddingService] - embedding 服务（可选，避免重复加载模型）
   */
  constructor(vectorStore = null, embeddingService = null) {
    // 延迟解析默认单例：避免模块加载时的循环依赖
    this._getVectorStore = vectorStore
      ? () => vectorStore
      : () => require('./vector-store-qdrant.service').vectorStore;
    this.embeddingService = embeddingService || new EmbeddingService();
  }

  get vectorStore() { return this._getVectorStore(); }

  /** 最近一次 indexDocument 的复用统计 { reused, embedded, total }，供重索引接口展示 */
  get lastReuseStats() { return this._lastReuseStats || { reused: 0, embedded: 0, total: 0 }; }

  /** chunk 内容 hash：增量复用的对齐键（trim 归一化） */
  _contentHash(text) {
    return crypto.createHash('sha256').update(String(text || '').trim()).digest('hex');
  }

  /**
   * 取回文档现有向量并按内容 hash 建复用表
   * @returns {Promise<Map<string, {dense: number[], sparse: Object}> | null>}
   *          向量库不支持 getDocPoints 或取回失败时返回 null（退化为全量重算）
   */
  async _buildReuseMap(docId) {
    if (typeof this.vectorStore.getDocPoints !== 'function') return null;
    try {
      const oldPoints = await this.vectorStore.getDocPoints(docId);
      const map = new Map();
      for (const point of oldPoints) {
        if (!point?.dense?.length) continue;
        // Qdrant 线上 sparse 为 {indices, values}，归一化回 embedBatch 的 {dim: weight} map 形式
        let sparse = point.sparse || {};
        if (Array.isArray(sparse.indices)) {
          sparse = Object.fromEntries(sparse.indices.map((dim, i) => [dim, sparse.values[i]]));
        }
        map.set(this._contentHash(point.text), { dense: point.dense, sparse });
      }
      return map;
    } catch (err) {
      logEvent('warn', 'indexing_reuse_fetch_failed_full_recompute', { error: err.message });
      return null;
    }
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
  _splitParagraphs(text) {
    if (!text) return [];
    const rawParas = this._stripFrontmatter(String(text)).split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
    return this._mergeBySection(rawParas);
  }

  /**
   * 剥离 Markdown YAML frontmatter（文件头的 --- 元数据块）。
   * 该块会被切成独立的"元数据父段落"（created/source/category/tags），
   * 检索时凭查询词的稀有字匹配拿到高稀疏分，挤占真实内容的上下文位置
   * （实测表现为模型只拿到"标题 + 元数据"就作答）。
   */
  _stripFrontmatter(text) {
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
   * 按章节标题或短段落合并
   */
  _mergeBySection(paragraphs) {
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
      return this._mergeBySectionHeadings(paragraphs, isHeading);
    }

    // 无章节标题 → 合并相邻短段落
    return this._mergeShortParagraphs(paragraphs);
  }

  /**
   * 按章节标题合并：两个标题之间的所有段落合并为一个语义块
   * 封面/目录等标题前的内容单独成块
   */
  _mergeBySectionHeadings(paragraphs, isHeading) {
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
  _mergeShortParagraphs(paragraphs, minLen = 30) {
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
  _splitSentences(paragraph, targetMinLen = 25) {
    // 先保护选项行（如 "A. 内容" 或 "- A. 内容"），避免被英文句点误切
    // 用占位符替换选项行中的句点，切完再还原
    const _protected = paragraph.replace(/^([- ]*[A-D])\.\s/gm, '$1<DOT>');
    // 匹配中文/英文句号、感叹号、问号、换行
    const parts = _protected.split(/(?<=[。！？.!?\n])\s*/);
    const sentences = parts.map(s => s.trim().replace(/<DOT>/g, '.')).filter(s => s.length > 0);

    // 单句段落无需合并
    if (sentences.length <= 1) return sentences;

    // 合并相邻短句，消除碎片向量
    return this._mergeShortSentences(sentences, targetMinLen);
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
  _mergeShortSentences(sentences, targetMinLen) {
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

  // ===== 场景化子块切割（FAQ / 表格 / 列表） =====
  //
  // 默认 25 字符句子包对散文成立，但对三类结构化文本会切碎语义单元：
  //   FAQ：25 字符会把单条问答切到两条子块，召回串台 → 整条一个子块
  //   表格：单行无语义 → 小表整表一个子块，大表按行切且行带表头
  //   列表：单步 25 字符看不出步骤归属 → 按条目边界切，条目带标题前缀
  // 检索命中的仍是子块，LLM 看到的仍是完整父段落——只改"被检索"的粒度。

  /** 列表行标记：无序（- * • ·）、有序（1. 1、 1) （1） 第N步） */  static get LIST_MARKER_RE() {
    return /^(?:[-*•·]|\d{1,2}[.、)）]|[（(][一二三四五六七八九十\d]{1,3}[)）]|第[一二三四五六七八九十\d]+步)/;
  }

  /** FAQ 行特征：Q/问/答前缀、选项行、答案行 */
  static get FAQ_LINE_RE() {
    return /^(?:#{1,6}\s*)?(?:Q\s*\d*[：:.、)\s]|问\s*[：:]|答\s*[：:]|\*\*答案|[-\s]*[A-D][.、：:]\s*\S)/;
  }

  /** 表格分隔行（如 | --- | --- |）：只含 | - : 空格且至少一个 | 与一个 - */
  static get TABLE_SEPARATOR_RE() {
    return /^(?=[\s|:-]*\|)(?=[\s|:-]*-)[\s|:-]+$/;
  }

  _blockLines(paragraph) {
    return String(paragraph || '').split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /**
   * 子块切割统一入口：按段落块型分发策略
   * @returns {{ type: 'prose'|'faq'|'table'|'list', chunks: string[] }}
   */
  _splitChildChunks(paragraph) {
    if (config.document?.adaptiveChunking === false) {
      return { type: 'prose', chunks: this._splitSentences(paragraph) };
    }
    const type = this._detectBlockType(paragraph);
    switch (type) {
      case 'table': return { type, chunks: this._splitTableChildren(paragraph) };
      case 'faq': return { type, chunks: this._splitFaqChildren(paragraph) };
      case 'list': return { type, chunks: this._splitListChildren(paragraph) };
      default: return { type: 'prose', chunks: this._splitSentences(paragraph) };
    }
  }

  /** 段落块型检测：表格 > FAQ > 列表 > 散文 */
  _detectBlockType(paragraph) {
    const lines = this._blockLines(paragraph);
    if (lines.length < 3) return 'prose';

    const pipeLines = lines.filter((l) => (l.match(/\|/g) || []).length >= 2);
    const hasSeparator = lines.some((l) => this.constructor.TABLE_SEPARATOR_RE.test(l));
    if (pipeLines.length >= 3 && hasSeparator) return 'table';

    if (this._looksLikeFaq(lines)) return 'faq';
    if (this._looksLikeList(lines)) return 'list';
    return 'prose';
  }

  /** FAQ 判定：≥3 行且 ≥50% 行含问答特征、≥60% 行长 ≤80 字 */
  _looksLikeFaq(lines) {
    if (lines.length < 3) return false;
    const faqish = lines.filter((l) => this.constructor.FAQ_LINE_RE.test(l) || /[？?]\s*$/.test(l)).length;
    const shortLines = lines.filter((l) => l.length <= 80).length;
    return faqish / lines.length >= 0.5 && shortLines / lines.length >= 0.6;
  }

  /** 列表判定：≥3 行且 ≥60% 行带列表标记 */
  _looksLikeList(lines) {
    if (lines.length < 3) return false;
    const listLines = lines.filter((l) => this.constructor.LIST_MARKER_RE.test(l)).length;
    return listLines / lines.length >= 0.6;
  }

  /**
   * FAQ 切割：问答条目整条一个子块。只有"提问行"开新条目
   * （Q 前缀 / 问：/ 问号结尾行），选项、答案、续行归当前条目；
   * 超长条目退回句子合并。检测用的宽匹配 FAQ_LINE_RE 不能当分组边界。
   */
  _splitFaqChildren(paragraph) {
    const lines = this._blockLines(paragraph);
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
      return text.length > 150 ? this._splitSentences(text) : [text];
    });
  }

  /**
   * 表格切割：≤5 行的小表整表一个子块；大表按数据行切，
   * 每行子块带表头前缀（裸行值无语义，表头提供列语义）；表外散文走默认合并
   */
  _splitTableChildren(paragraph) {
    const lines = paragraph.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    const isPipeRow = (l) => (l.match(/\|/g) || []).length >= 2;

    const children = [];
    let tableLines = [];
    let proseLines = [];

    const flushProse = () => {
      if (proseLines.length) {
        children.push(...this._splitSentences(proseLines.join('\n')));
        proseLines = [];
      }
    };
    const flushTable = () => {
      if (!tableLines.length) return;
      const sepIdx = tableLines.findIndex((l) => this.constructor.TABLE_SEPARATOR_RE.test(l));
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
  _splitListChildren(paragraph) {
    const lines = this._blockLines(paragraph);
    const isListLine = (l) => this.constructor.LIST_MARKER_RE.test(l);

    let title = '';
    let current = null;
    const children = [];

    const flush = () => {
      if (!current) return;
      const text = current.join('\n');
      const pieces = text.length > 150 ? this._splitSentences(text) : [text];
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

    return children.length ? children : this._splitSentences(paragraph);
  }

  /**
   * 索引单个文档（段落→句子双层切片 → 向量化子级 → 存储到 Qdrant）
   * @param {string} docId
   * @param {string} title
   * @param {string} content
   * @param {string} category
   * @param {Object} [options]
   * @param {Map|null} [options.oldVectors] - 内容 hash → 旧向量复用表（增量重索引用）
   */
  async indexDocument(docId, title, content, category = 'general', { oldVectors = null } = {}) {
    // 0. 语料统计必须在编码前就绪：稀疏权重里的 idf 依赖它，
    //    查询侧读的是同一份（持久化）统计，否则两侧错配
    await this._ensureSparseStatsLoaded();

    // 1~2. 段落（父级）→ 句子（子级）两层切片
    const { paragraphs, childChunks, metadatas, typeTally } = this._chunkDocument(docId, title, content, category);
    if (childChunks.length === 0) return 0;

    logEvent('info', 'indexing_doc_chunked', {
      paragraphs: paragraphs.length,
      childChunks: childChunks.length,
      faq: typeTally.faq,
      table: typeTally.table,
      list: typeTally.list,
    });

    // 3. 向量化子级：hash 命中旧向量直接复用，只对新增/变化的 chunk 调用模型
    const reused = new Array(childChunks.length).fill(null);
    const freshIdx = [];
    const freshTexts = [];
    if (oldVectors) {
      childChunks.forEach((text, i) => {
        const hit = oldVectors.get(this._contentHash(text));
        if (hit) reused[i] = hit;
        else freshIdx.push(i);
      });
    } else {
      freshIdx.push(...childChunks.map((_, i) => i));
    }

    if (freshIdx.length > 0) {
      freshIdx.forEach(i => freshTexts.push(childChunks[i]));
      const freshEmbeddings = await this.embeddingService.embedBatch(freshTexts);
      if (freshEmbeddings.some(e => !e?.dense)) {
        logEvent('warn', 'indexing_embed_failed_skip', { docId });
        return 0;
      }
      freshIdx.forEach((chunkIdx, j) => { reused[chunkIdx] = freshEmbeddings[j]; });
    }

    this._lastReuseStats = {
      reused: childChunks.length - freshIdx.length,
      embedded: freshIdx.length,
      total: childChunks.length,
    };
    if (oldVectors) {
      logEvent('info', 'indexing_incremental_reuse', { reused: childChunks.length - freshIdx.length, total: childChunks.length, recomputed: freshIdx.length });
    }

    // 4. 构造 point ID（docId_sent_i，确定性可重放）并存储
    const ids = childChunks.map((_, i) => `${docId}_sent_${i}`);

    await this.vectorStore.addChunks(ids, reused, childChunks, metadatas);
    logEvent('info', 'indexing_doc_done', { docId, vectorCount: childChunks.length });
    return childChunks.length;
  }

  /**
   * 段落 → 句子两层切片，返回子块文本与元数据。
   *
   * 抽成独立方法的原因：索引本身与稀疏通道的 df 预统计都要走**完全同一次**切片，
   * 各写一份的话，统计用的块和真正入库的块会悄悄漂移（df 与向量对不上）。
   *
   * @returns {{paragraphs: string[], childChunks: string[], metadatas: object[], typeTally: object}}
   */
  _chunkDocument(docId, title, content, category) {
    const paragraphs = this._splitParagraphs(content);
    const childChunks = [];
    const metadatas = [];
    const typeTally = { prose: 0, faq: 0, table: 0, list: 0 };

    for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
      const paraText = paragraphs[paraIdx];
      const { type, chunks: childTexts } = this._splitChildChunks(paraText);
      typeTally[type] += 1;

      for (const sentence of childTexts) {
        childChunks.push(sentence);
        metadatas.push({
          docId,
          parentId: `${docId}_para_${paraIdx}`,
          parentIdx: paraIdx,
          parentText: paraText,          // 父段落全文，检索时直接使用
          title,
          category,
          chunkIndex: metadatas.length,  // 句子级别的索引
        });
      }
    }

    if (childChunks.length === 0) {
      logEvent('warn', paragraphs.length ? 'indexing_skipped_empty_sentences' : 'indexing_skipped_empty_paragraphs', { docId });
    }

    return { paragraphs, childChunks, metadatas, typeTally };
  }

  /**
   * 注入的 embedding 服务是否具备语料统计能力。
   * 能力检测而非假设：替身/精简实现只保证 embedBatch，语料统计是可选增强，
   * 缺了它整套索引流程必须照常跑（稀疏权重退回纯 tf）。
   */
  get _sparseStatsSupported() {
    return typeof this.embeddingService?.buildSparseStats === 'function';
  }

  /**
   * 构建并激活稀疏通道的语料统计（df / 文档数 / 平均块长），随后持久化。
   *
   * 为什么必须持久化：idf 会被烤进文档侧稀疏向量，进程重启后查询侧必须能拿到
   * **同一份** idf；否则就成了"文档侧带 idf、查询侧不带"的错配，点积被系统性压低。
   *
   * @param {Array<{id:string,title:string,content:string,category:string}>} docs
   */
  async _rebuildSparseStats(docs) {
    if (!this._sparseStatsSupported) return null;

    const chunkTexts = [];
    for (const doc of docs) {
      const { childChunks } = this._chunkDocument(doc.id, doc.title, doc.content, doc.category);
      chunkTexts.push(...childChunks);
    }

    const stats = this.embeddingService.buildSparseStats(chunkTexts);
    setSparseStats(stats);
    logEvent('info', 'indexing_sparse_stats_built', {
      docCount: stats.docCount,
      terms: stats.df.size,
      avgLen: Number(stats.avgLen.toFixed(2)),
    });

    try {
      const { redis: store } = require('./memory-store');
      await store.hset(SPARSE_STATS_KEY, { stats: stats.toJSON(), updatedAt: Date.now() });
    } catch (err) {
      logEvent('warn', 'indexing_sparse_stats_persist_failed', { error: err.message });
    }

    return stats;
  }

  /**
   * 确保内存里有语料统计（进程重启后从持久化恢复）。
   * 拿不到就保持 null —— 此时文档侧与查询侧会一致退回纯 tf，不会单侧带 idf。
   */
  async _ensureSparseStatsLoaded() {
    if (!this._sparseStatsSupported || getSparseStats()) return;
    try {
      const { redis: store } = require('./memory-store');
      const raw = await store.hgetall(SPARSE_STATS_KEY);
      if (raw?.stats?.keys) {
        setSparseStats(SparseStats.fromJSON(raw.stats));
        logEvent('info', 'indexing_sparse_stats_loaded', {
          docCount: raw.stats.docCount || 0,
          terms: (raw.stats.keys || []).length,
        });
      }
    } catch (err) {
      logEvent('warn', 'indexing_sparse_stats_load_failed', { error: err.message });
    }
  }

  async removeDocument(docId) {
    await this.vectorStore.deleteByDocId(docId);
    logEvent('info', 'indexing_doc_deleted', { docId });
  }

  /**
   * 增量重索引：删除前先取回旧向量，文本未变的 chunk 复用 embedding
   */
  async reindexDocument(docId, title, content, category = 'general') {
    const oldVectors = await this._buildReuseMap(docId);
    await this.removeDocument(docId);
    return await this.indexDocument(docId, title, content, category, { oldVectors });
  }

  /**
   * 重建所有文档的索引
   * @param {Array} docs - 文档列表
   * @param {Object} [options]
   * @param {string} [options.mode='rebuild'] - rebuild: reset collection 后全量重建（修复/策略变更用）
   *                                            incremental: 逐文档 hash diff，未变 chunk 复用向量
   */
  async reindexAll(docs, { mode = 'rebuild' } = {}) {
    if (mode === 'incremental') {
      // 增量模式**不重建**统计：idf 一变，未变块复用的旧向量就与新查询向量错配。
      // 这里只确保统计就绪（进程重启后从持久化恢复），复用才是安全的。
      await this._ensureSparseStatsLoaded();
      logEvent('info', 'indexing_incremental_start', { docCount: docs.length });
      let totalChunks = 0;
      for (const doc of docs) {
        totalChunks += await this.reindexDocument(doc.id, doc.title, doc.content, doc.category);
      }
      const { reused, embedded } = this.lastReuseStats;
      logEvent('info', 'indexing_incremental_done', { totalChunks, reused, embedded });
      return totalChunks;
    }

    logEvent('info', 'indexing_full_rebuild_start', { docCount: docs.length });

    // 先统计、再编码：df 必须覆盖整个语料。边统计边编码的话，靠前的文档用的是
    // "只见过一部分语料"的 idf，同一个词在不同文档里权重不同，稀疏分数失去可比性。
    await this._rebuildSparseStats(docs);

    await this.vectorStore.resetCollection();

    let totalChunks = 0;
    for (const doc of docs) {
      const count = await this.indexDocument(doc.id, doc.title, doc.content, doc.category);
      totalChunks += count;
    }
    logEvent('info', 'indexing_full_rebuild_done', { totalChunks });
    return totalChunks;
  }
}

module.exports = { IndexingService };
