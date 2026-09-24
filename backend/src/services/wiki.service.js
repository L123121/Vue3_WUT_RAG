"use strict";

const crypto = require('crypto');

/**
 * 校园百科（Wiki）阅读与治理层
 *
 * 词条正文一律来自知识库 document:<docId>，本服务只补阅读侧元数据（是否上架、
 * 可读 slug、最后操作人），不复制正文，避免出现第二个数据源。
 *
 * 元数据存在独立的 wiki:entries / wiki:slugs 两个 hash：document.service 的落库
 * 字段参与 contentHash 去重，往那条写入路径上加治理字段的风险远大于收益；
 * 且本仓库没有任何版本化迁移机制（只有 CREATE TABLE IF NOT EXISTS），KV hash 无需改表。
 *
 * 编译期互链（2026-09-24 新增）：词条上架时异步触发 LLM 关联梳理，把"词条之间怎么
 * 关联"这件事从查询期的分类聚类挪到编译期一次性做完——命中候选池小、只在内容变化时
 * 重算，失败或关闭时 relatedPages 为空，前端自动回退按分类的本地推荐，不影响可用性。
 */

const { redis: store } = require('./memory-store');
const { DocumentService } = require('./document.service');
const { logEvent } = require('./observability.service');
const config = require('../config');

// ai.service 惰性加载：它会一并拉起指标/OTel 等整条可观测性依赖链，
// 而 Wiki 绝大多数读路径（getEntry/listEntries/searchPublished）
// 不需要 LLM，不该为它们多付一次这条依赖链的加载成本
let cachedAiService = null;
function getAiService() {
  if (!cachedAiService) cachedAiService = require('./ai.service').aiService;
  return cachedAiService;
}

const ENTRY_KEY = 'wiki:entries';
const SLUG_KEY = 'wiki:slugs';
const REVISION_KEY = 'wiki:revisions';
const MAX_REVISIONS = 20;

// 与 ragdata 语料的 front-matter 约定对齐：source 命中即视为演示用虚构内容
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SIMULATED_RE = /模拟数据|演示用/;
const DOC_ID_RE = /^doc_[0-9a-zA-Z_-]{6,}$/;
const MAX_SLUG_LENGTH = 60;
const EXCERPT_RADIUS = 60;

const parse = (value) => {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const asText = (value) => String(value ?? '');

const sourceRevision = (doc) => String(doc?.contentHash || crypto.createHash('sha256').update(asText(doc?.content), 'utf8').digest('hex'));

const queryTerms = (query) => Array.from(new Set(
  asText(query).toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z0-9_]{2,}/gi) || []
)).slice(0, 8);

/**
 * 只取顶层 `key: value` 行，嵌套与列表忽略（语料里不需要完整 YAML 实现）
 */
function parseFrontMatter(content) {
  const raw = asText(content);
  const match = FRONT_MATTER_RE.exec(raw);
  const meta = {};
  if (!match) return { meta, body: raw.trim() };
  for (const line of match[1].split(/\r?\n/)) {
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) continue;
    const pair = /^([^:]+):(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    const value = pair[2].trim().replace(/^['"]|['"]$/g, '');
    if (key && value) meta[key] = value;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

/**
 * 去掉与词条页标题重复的首个一级/二级标题，避免同一标题连现两次
 */
function stripDuplicateTitle(body, title) {
  if (!title) return body;
  const heading = /^#{1,2}[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(body);
  if (!heading) return body;
  const normalize = (value) => String(value).replace(/[#*_`\s]/g, '').toLowerCase();
  if (normalize(heading[1]) !== normalize(title)) return body;
  return body.slice(heading[0].length).trim();
}

function slugify(title) {
  const slug = asText(title)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/?#%:&+]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  return slug || 'entry';
}

/**
 * 上架时的置信度分级：演示语料是硬下限（0.1），真实内容里"有没有标注来源"
 * 是唯一能自动判断的额外信号——没标来源的真实内容标 0.5（"标注不裁"：仍可上架，
 * 但读者应自行核实），标了来源的才给 0.8。分级只在上架时计算一次，不做运行时判断。
 */
function gradeConfidence({ simulated, sourceLabel }) {
  if (simulated) return 0.1;
  return sourceLabel ? 0.8 : 0.5;
}

/**
 * 从 LLM 输出中防御性解析 JSON 数组（允许模型在数组前后包裹多余文字）
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

const CANDIDATE_EXCERPT_LENGTH = 80;
const RELATION_REASON_MAX_LENGTH = 40;

/**
 * 关联候选打分：分类相同权重最高，标题/分类词面重叠次之——这只是把"候选池收窄到
 * LLM 挑得动的规模"，真正的关联判断交给 LLM，这里不做语义判断。
 */
function scoreCandidate(target, candidate) {
  if (candidate.category && target.category && candidate.category === target.category) return 5;
  const targetTerms = queryTerms(`${target.title} ${target.category}`);
  const candidateText = `${candidate.title} ${candidate.category}`.toLowerCase();
  return targetTerms.reduce((total, term) => total + (candidateText.includes(term) ? 1 : 0), 0);
}

class WikiService {
  constructor({ store: storeOverride, documentService, aiService: aiServiceOverride } = {}) {
    this.store = storeOverride || store;
    this.documentService = documentService || new DocumentService();
    // 显式注入（测试/未来 DI）优先；生产路径首次真正调用互链梳理时才惰性 require
    this._aiServiceOverride = aiServiceOverride || null;
  }

  get aiService() {
    return this._aiServiceOverride || getAiService();
  }

  /**
   * 正文解析：front-matter 剥离 + 模拟语料判定
   * 判定必须在服务端做，否则"演示语料禁止上架"可被绕过
   */
  analyze(content, title = '') {
    const { meta, body } = parseFrontMatter(content);
    const sourceLabel = meta.source || meta['来源'] || '';
    const simulated = SIMULATED_RE.test(sourceLabel)
      || (!sourceLabel && SIMULATED_RE.test(body.slice(0, 300)));
    return {
      body: stripDuplicateTitle(body, title),
      meta,
      sourceLabel,
      simulated,
    };
  }

  async getMeta(docId) {
    const raw = await this.store.hget(ENTRY_KEY, docId);
    const meta = parse(raw);
    return meta && typeof meta === 'object' ? meta : null;
  }

  async _syncSourceRevision(doc, meta) {
    if (!doc || !meta?.sourceRevision) return meta;
    const currentRevision = sourceRevision(doc);
    if (meta.sourceRevision === currentRevision) return meta;

    const revisions = parse(await this.store.hget(REVISION_KEY, doc.id)) || [];
    if (meta.reviewState === 'stale' && meta.staleAt && revisions.some((item) => item?.revision === currentRevision)) return meta;
    if (!revisions.some((item) => item?.revision === currentRevision)) {
      revisions.push({
        revision: currentRevision,
        docId: doc.id,
        title: doc.title,
        category: doc.category,
        recordedAt: new Date().toISOString(),
        recordedBy: 'document-update',
        reason: 'source_updated',
      });
      await this.store.hset(REVISION_KEY, doc.id, JSON.stringify(revisions.slice(-MAX_REVISIONS)));
    }

    const staleMeta = {
      ...meta,
      reviewState: 'stale',
      staleAt: meta.staleAt || new Date().toISOString(),
    };
    await this.store.hset(ENTRY_KEY, doc.id, JSON.stringify(staleMeta));
    return staleMeta;
  }

  async listMeta() {
    const all = await this.store.hgetall(ENTRY_KEY);
    if (!all) return {};
    const out = {};
    for (const [docId, raw] of Object.entries(all)) {
      const meta = parse(raw);
      if (meta && typeof meta === 'object') out[docId] = meta;
    }
    return out;
  }

  /**
   * 上架/下架词条。默认不上架（无元数据即不可见），模拟语料需显式 allowSimulated
   */
  async setVisibility({ docId, visible, userId = '', allowSimulated = false } = {}) {
    if (!docId) throw Object.assign(new Error('缺少词条标识'), { status: 400 });
    const doc = await this.documentService.getDocument(docId);
    if (!doc) throw Object.assign(new Error('词条不存在'), { status: 404 });

    const analysis = this.analyze(doc.content, doc.title);
    if (visible && analysis.simulated && !allowSimulated) {
      throw Object.assign(
        new Error(`该词条为演示用虚构内容（${analysis.sourceLabel || '模拟数据'}），默认不可上架到百科`),
        { status: 409, code: 'SIMULATED_ENTRY' }
      );
    }

    const previous = await this.getMeta(docId);
    const revision = sourceRevision(doc);
    // slug 一旦分配就长期保留：下架后管理员仍需通过原链接回访重上架，
    // 读权限由 visible 单独把关，别名存在不等于可见
    const slug = previous?.slug || (visible ? await this._reserveSlug(doc.title, docId) : '');
    const meta = {
      visible: !!visible,
      slug,
      allowSimulated: !!(visible && analysis.simulated && allowSimulated),
      updatedBy: userId || '',
      updatedAt: new Date().toISOString(),
      sourceDocId: docId,
      sourceRevision: revision,
      reviewState: visible ? 'published' : 'unpublished',
      confidence: gradeConfidence(analysis),
      // 互链是编译期产物，下架不清空——重上架若内容未变可直接沿用，省一次 LLM 调用
      relatedPages: previous?.relatedPages || [],
      relationsRevision: previous?.relationsRevision || '',
      relationsCompiledAt: previous?.relationsCompiledAt || '',
    };

    const revisions = parse(await this.store.hget(REVISION_KEY, docId)) || [];
    revisions.push({ revision, docId, title: doc.title, category: doc.category, recordedAt: meta.updatedAt, recordedBy: userId || '' });
    await this.store.hset(REVISION_KEY, docId, JSON.stringify(revisions.slice(-MAX_REVISIONS)));
    await this.store.hset(ENTRY_KEY, docId, JSON.stringify(meta));
    if (slug) {
      await this.store.hset(SLUG_KEY, slug, docId);
    }

    // 编译期互链：上架且内容有变化才重新梳理，异步执行不阻塞上下架响应；
    // 失败只告警，读取侧自然回退到已有（可能是空）relatedPages
    if (visible && meta.relationsRevision !== revision) {
      void this.compileRelatedPages(docId).catch((err) => {
        logEvent('warn', 'wiki_relation_compile_failed', { docId, error: err.message });
      });
    }

    return { docId, ...meta };
  }

  /**
   * 编译期互链梳理：从同批已上架词条里选出候选池，交给 LLM 判断关联，
   * 不在查询期做——查询期只读这里写好的 relatedPages，零额外调用。
   * 可被 setVisibility 异步触发，也可被管理端接口显式调用重算。
   */
  async compileRelatedPages(docId) {
    const relationConfig = config.wiki || {};
    const doc = await this.documentService.getDocument(docId);
    if (!doc) return [];
    const meta = await this.getMeta(docId);
    if (!meta?.visible) return meta?.relatedPages || [];

    const revision = sourceRevision(doc);
    const candidates = await this._candidateEntries(doc);
    let relatedPages = [];
    if (relationConfig.relationCompileEnabled !== false && candidates.length > 0) {
      relatedPages = await this._pickRelatedByLLM(doc, candidates, relationConfig);
    }

    // 写回前重读一遍：避免覆盖掉编译期间管理员做的下架操作
    const freshMeta = await this.getMeta(docId);
    if (!freshMeta?.visible) return freshMeta?.relatedPages || [];
    const updatedMeta = {
      ...freshMeta,
      relatedPages,
      relationsRevision: revision,
      relationsCompiledAt: new Date().toISOString(),
    };
    await this.store.hset(ENTRY_KEY, docId, JSON.stringify(updatedMeta));
    return relatedPages;
  }

  /**
   * 候选池：仅从已上架且未漂移的词条里挑，按分类/词面重叠打分收窄到
   * relationCompileMaxCandidates 条，把"谁可能相关"缩到 LLM 挑得动的规模
   */
  async _candidateEntries(targetDoc) {
    const maxCandidates = config.wiki?.relationCompileMaxCandidates || 20;
    const { documents } = await this.documentService.listDocuments({ page: 1, limit: 100_000 });
    const metas = await this.listMeta();
    const target = { title: targetDoc.title, category: targetDoc.category };

    const scored = [];
    for (const candidateDoc of documents) {
      if (candidateDoc.id === targetDoc.id) continue;
      const candidateMeta = metas[candidateDoc.id];
      if (!candidateMeta?.visible || candidateMeta.reviewState === 'stale') continue;
      const score = scoreCandidate(target, candidateDoc);
      if (score <= 0) continue;
      scored.push({ docId: candidateDoc.id, title: candidateDoc.title, category: candidateDoc.category, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, maxCandidates);
  }

  /**
   * LLM 只做一件事：从候选 id 里选、给理由。白名单校验落回候选 id 集合，
   * 幻觉出不存在的 docId 或不服从限量都被过滤掉，不信任模型输出的结构
   */
  async _pickRelatedByLLM(targetDoc, candidates, relationConfig) {
    if (!this.aiService || typeof this.aiService.getCompletion !== 'function') return [];
    const maxRelated = relationConfig.relationCompileMaxRelated || 5;
    const analysis = this.analyze(targetDoc.content, targetDoc.title);
    const excerpt = analysis.body.replace(/\s+/g, ' ').slice(0, CANDIDATE_EXCERPT_LENGTH);
    const candidateList = candidates
      .map((item) => `- [${item.docId}] ${item.title}（${item.category || '未分类'}）`)
      .join('\n');

    const prompt = `你是校园百科的关联编辑器。目标词条信息：
标题：${targetDoc.title}
分类：${targetDoc.category || '未分类'}
摘要：${excerpt}

候选词条（只能从中选择，禁止编造不存在的 docId）：
${candidateList}

请选出最多 ${maxRelated} 条与目标词条关联度最高的候选，只输出 JSON 数组，不要多余文字：
[{"docId":"...","reason":"不超过20字的关联理由"}]
没有相关候选时输出 []`;

    try {
      const result = await this.aiService.getCompletion(prompt, [], {
        timeout: relationConfig.relationCompileTimeoutMs || 8000,
        retries: 0,
      });
      if (result?.isMock) return [];
      const items = parseJsonArray(result.content);
      if (!Array.isArray(items)) return [];

      const candidateIds = new Set(candidates.map((item) => item.docId));
      const picked = [];
      const seen = new Set();
      for (const item of items) {
        const relatedDocId = String(item?.docId || '').trim();
        if (!candidateIds.has(relatedDocId) || seen.has(relatedDocId)) continue;
        seen.add(relatedDocId);
        picked.push({
          docId: relatedDocId,
          reason: String(item?.reason || '').trim().slice(0, RELATION_REASON_MAX_LENGTH),
        });
        if (picked.length >= maxRelated) break;
      }
      return picked;
    } catch (err) {
      logEvent('warn', 'wiki_relation_llm_failed', { docId: targetDoc.id, error: err.message });
      return [];
    }
  }

  /**
   * 读取侧解析：目标词条若已下架/漂移则被动过滤（标注不裁——源记录仍留在
   * relatedPages 里，下次重编译时自然清理，这里只是不把失效链接展示给读者）
   */
  async _resolveRelatedPages(meta) {
    const related = Array.isArray(meta?.relatedPages) ? meta.relatedPages : [];
    if (!related.length) return [];
    const metas = await this.listMeta();
    const resolved = [];
    for (const item of related) {
      const targetMeta = metas[item.docId];
      if (!targetMeta?.visible || targetMeta.reviewState === 'stale') continue;
      const targetDoc = await this.documentService.getDocument(item.docId);
      if (!targetDoc) continue;
      resolved.push({ id: item.docId, slug: targetMeta.slug || '', title: targetDoc.title, reason: item.reason || '' });
    }
    return resolved;
  }

  async _reserveSlug(title, docId) {
    const base = slugify(title);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const owner = await this.store.hget(SLUG_KEY, slug);
      if (!owner || owner === docId) return slug;
    }
    return `${base}-${Date.now()}`;
  }

  /**
   * id 与 slug 都接受；slug 命中但文档已删除时清掉残留映射并按未找到处理
   */
  async resolveId(idOrSlug) {
    const value = asText(idOrSlug).trim();
    if (!value) return '';
    if (DOC_ID_RE.test(value)) return value;
    const docId = await this.store.hget(SLUG_KEY, value);
    if (!docId) return value;
    const doc = await this.documentService.getDocument(docId);
    if (!doc) {
      await this.store.hdel(SLUG_KEY, value);
      return '';
    }
    return String(docId);
  }

  _toEntry(doc, meta, { excerpt = '', matched = 0 } = {}) {
    return {
      id: doc.id,
      slug: meta?.visible ? (meta.slug || '') : '',
      title: doc.title,
      category: doc.category,
      contentLength: doc.contentLength,
      chunkCount: doc.chunkCount,
      vectorStatus: doc.vectorStatus,
      createdAt: doc.createdAt,
      visible: !!meta?.visible,
      updatedBy: meta?.updatedBy || '',
      updatedAt: meta?.updatedAt || '',
      sourceRevision: meta?.sourceRevision || '',
      currentRevision: sourceRevision(doc),
      stale: Boolean(meta?.sourceRevision && meta.sourceRevision !== sourceRevision(doc)),
      reviewState: meta?.reviewState || (meta?.visible ? 'published' : 'unpublished'),
      confidence: Number.isFinite(Number(meta?.confidence)) ? Number(meta.confidence) : null,
      excerpt,
      matched,
    };
  }

  /**
   * 词条列表：默认只返回已上架词条；includeHidden 仅管理员可见（用于上下架管理）
   */
  async listEntries({ query = '', includeHidden = false } = {}) {
    const { documents } = await this.documentService.listDocuments({ page: 1, limit: 100_000 });
    const metas = await this.listMeta();
    const keyword = asText(query).trim().toLowerCase();

    const entries = [];
    for (const doc of documents) {
      const meta = await this._syncSourceRevision(doc, metas[doc.id]);
      if (!includeHidden && (!meta?.visible || meta.reviewState === 'stale')) continue;
      const matched = await this._match(doc, keyword);
      if (keyword && !matched) continue;
      entries.push(this._toEntry(doc, meta, matched || {}));
    }

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { entries, total: entries.length };
  }

  /**
   * 命中判定：标题/分类为本地匹配，正文匹配需要读原文（列表接口不带正文）
   */
  async _match(doc, keyword) {
    if (!keyword) return null;
    const titleHit = asText(doc.title).toLowerCase().includes(keyword)
      || asText(doc.category).toLowerCase().includes(keyword);
    if (titleHit) return { excerpt: '', matched: 1 };

    const raw = await this.store.hgetall(`document:${doc.id}`);
    const content = asText(raw?.content);
    const index = content.toLowerCase().indexOf(keyword);
    if (index < 0) return null;
    const start = Math.max(0, index - EXCERPT_RADIUS);
    const excerpt = content
      .slice(start, index + keyword.length + EXCERPT_RADIUS)
      .replace(/\s+/g, ' ')
      .trim();
    return { excerpt, matched: 1 };
  }

  /**
   * 词条详情：未上架的词条只有管理员可通过 manage 视角访问
   */
  async getRevisionHistory(docId) {
    const doc = await this.documentService.getDocument(docId);
    if (doc) await this._syncSourceRevision(doc, await this.getMeta(docId));
    const revisions = parse(await this.store.hget(REVISION_KEY, docId)) || [];
    return Array.isArray(revisions) ? revisions.slice(-MAX_REVISIONS).reverse() : [];
  }

  async removeDocumentMetadata(docId) {
    const meta = await this.getMeta(docId);
    if (meta?.slug) await this.store.hdel(SLUG_KEY, meta.slug);
    await this.store.hdel(ENTRY_KEY, docId);
    await this.store.hdel(REVISION_KEY, docId);
  }

  /**
   * Wiki 导航优先的轻量搜索：只搜索已上架词条，返回完整正文供 RAG 生成层使用；
   * 没有命中时由调用方回退 Qdrant RAG。
   */
  async searchPublished(query, { limit = 3 } = {}) {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const { documents } = await this.documentService.listDocuments({ page: 1, limit: 100_000 });
    const metas = await this.listMeta();
    const scored = [];
    for (const doc of documents) {
      const meta = await this._syncSourceRevision(doc, metas[doc.id]);
      if (!meta?.visible || meta.reviewState === 'stale' || (meta.sourceRevision && meta.sourceRevision !== sourceRevision(doc))) continue;
      const raw = asText(doc.content).toLowerCase();
      const title = asText(doc.title).toLowerCase();
      const category = asText(doc.category).toLowerCase();
      const score = terms.reduce((total, term) => total + (title.includes(term) ? 5 : 0) + (category.includes(term) ? 3 : 0) + (raw.includes(term) ? 1 : 0), 0);
      if (score <= 0) continue;
      const analysis = this.analyze(doc.content, doc.title);
      scored.push({ ...this._toEntry(doc, meta, { matched: score }), body: analysis.body, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(Number(limit) || 3, 10)));
  }

  async getEntry(idOrSlug, { privileged = false } = {}) {
    const docId = await this.resolveId(idOrSlug);
    if (!docId) return null;
    const doc = await this.documentService.getDocument(docId);
    if (!doc) return null;
    const meta = await this._syncSourceRevision(doc, await this.getMeta(docId));
    if ((!meta?.visible || meta.reviewState === 'stale') && !privileged) return null;

    const analysis = this.analyze(doc.content, doc.title);
    return {
      ...this._toEntry(doc, meta),
      body: analysis.body,
      contentLength: doc.contentLength || asText(doc.content).length,
      sourceLabel: analysis.sourceLabel,
      simulated: analysis.simulated,
      // 编译期已经算好的互链，详情页读取时零额外检索；只在详情返回，
      // 列表接口不带（避免为每条列表项都做一次关联解析）
      relatedPages: await this._resolveRelatedPages(meta),
    };
  }
}

module.exports = { WikiService, slugify, parseFrontMatter };
