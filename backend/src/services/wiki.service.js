"use strict";

/**
 * 校园百科（Wiki）阅读与治理层
 *
 * 词条正文一律来自知识库 document:<docId>，本服务只补阅读侧元数据（是否上架、
 * 可读 slug、最后操作人），不复制正文，避免出现第二个数据源。
 *
 * 元数据存在独立的 wiki:entries / wiki:slugs 两个 hash：document.service 的落库
 * 字段参与 contentHash 去重，往那条写入路径上加治理字段的风险远大于收益；
 * 且本仓库没有任何版本化迁移机制（只有 CREATE TABLE IF NOT EXISTS），KV hash 无需改表。
 */

const { redis: store } = require('./memory-store');
const { DocumentService } = require('./document.service');

const ENTRY_KEY = 'wiki:entries';
const SLUG_KEY = 'wiki:slugs';

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

class WikiService {
  constructor({ store: storeOverride, documentService } = {}) {
    this.store = storeOverride || store;
    this.documentService = documentService || new DocumentService();
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
    // slug 一旦分配就长期保留：下架后管理员仍需通过原链接回访重上架，
    // 读权限由 visible 单独把关，别名存在不等于可见
    const slug = previous?.slug || (visible ? await this._reserveSlug(doc.title, docId) : '');
    const meta = {
      visible: !!visible,
      slug,
      allowSimulated: !!(visible && analysis.simulated && allowSimulated),
      updatedBy: userId || '',
      updatedAt: new Date().toISOString(),
    };

    await this.store.hset(ENTRY_KEY, docId, JSON.stringify(meta));
    if (slug) {
      await this.store.hset(SLUG_KEY, slug, docId);
    }
    return { docId, ...meta };
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
      const meta = metas[doc.id];
      if (!includeHidden && !meta?.visible) continue;
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
  async getEntry(idOrSlug, { privileged = false } = {}) {
    const docId = await this.resolveId(idOrSlug);
    if (!docId) return null;
    const doc = await this.documentService.getDocument(docId);
    if (!doc) return null;
    const meta = await this.getMeta(docId);
    if (!meta?.visible && !privileged) return null;

    const analysis = this.analyze(doc.content, doc.title);
    return {
      ...this._toEntry(doc, meta),
      body: analysis.body,
      contentLength: doc.contentLength || asText(doc.content).length,
      sourceLabel: analysis.sourceLabel,
      simulated: analysis.simulated,
    };
  }
}

module.exports = { WikiService, slugify, parseFrontMatter };
