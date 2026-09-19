import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/memory-store', () => ({ redis: {} }));

function createHashStore() {
  const hashes = new Map();
  const read = (key) => hashes.get(key) || null;
  return {
    _hashes: hashes,
    hset: vi.fn(async (key, ...args) => {
      const values = args.length === 1 && typeof args[0] === 'object'
        ? args[0]
        : Object.fromEntries(args.reduce((acc, _v, i) => (i % 2 === 0 ? [...acc, [args[i], args[i + 1]]] : acc), []));
      hashes.set(key, { ...(hashes.get(key) || {}), ...values });
      return 1;
    }),
    hget: vi.fn(async (key, field) => read(key)?.[field] ?? null),
    hgetall: vi.fn(async (key) => read(key)),
    hdel: vi.fn(async (key, field) => {
      const hash = hashes.get(key);
      if (!hash) return 0;
      delete hash[field];
      return 1;
    }),
  };
}

const doc = (id, title, category, content) => ({
  id,
  title,
  category,
  content,
  contentLength: content.length,
  chunkCount: 3,
  vectorStatus: 'ready',
  createdAt: new Date(`2026-01-0${id.slice(-1)}T00:00:00.000Z`),
});

const DOCS = [
  doc('doc_aaa1', '图书馆使用指南', '信息资源:校园指南', '---\nsource: 武汉理工大学图书馆\n---\n\n# 图书馆使用指南\n\n## 开放时间\n\n8:00-22:00'),
  doc('doc_bbb2', '食堂美食指南', '学校概况', '---\nsource: 模拟数据（演示用）\n---\n\n# 食堂美食指南\n\n热干面 6 元。'),
  doc('doc_ccc3', '操作系统要点', '课程资料:操作系统', '# 操作系统要点\n\n进程与线程的区别是常考点。'),
];

function createDocumentService() {
  return {
    listDocuments: vi.fn(async () => ({ documents: DOCS })),
    getDocument: vi.fn(async (id) => DOCS.find(d => d.id === id) || null),
  };
}

let store;
let documentService;
let wiki;

function useWiki() {
  delete require.cache[require.resolve('../src/services/wiki.service')];
  const { WikiService } = require('../src/services/wiki.service');
  return new WikiService({ store, documentService });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = createHashStore();
  documentService = createDocumentService();
  wiki = useWiki();
});

describe('WikiService.analyze', () => {
  it('剥离 front-matter、识别来源并去掉重复标题', () => {
    const result = wiki.analyze(DOCS[0].content, '图书馆使用指南');
    expect(result.sourceLabel).toBe('武汉理工大学图书馆');
    expect(result.simulated).toBe(false);
    expect(result.body).toBe('## 开放时间\n\n8:00-22:00');
  });

  it('无 front-matter 时原样返回，标题不同则保留', () => {
    const result = wiki.analyze('# 自定义标题\n\n正文', '操作系统要点');
    expect(result.body).toBe('# 自定义标题\n\n正文');
    expect(result.sourceLabel).toBe('');
    expect(result.simulated).toBe(false);
  });

  it('source 命中或正文前部声明都判为演示语料', () => {
    expect(wiki.analyze('---\nsource: 模拟数据（演示用）\n---\n正文', 'x').simulated).toBe(true);
    expect(wiki.analyze('# 标题\n\n> 本文为演示用内容', '标题').simulated).toBe(true);
  });
});

describe('WikiService.setVisibility', () => {
  it('上架写入元数据与 slug 索引', async () => {
    const result = await wiki.setVisibility({ docId: 'doc_aaa1', visible: true, userId: 'admin' });
    expect(result).toMatchObject({ docId: 'doc_aaa1', visible: true, slug: '图书馆使用指南', updatedBy: 'admin' });
    expect(JSON.parse(store._hashes.get('wiki:entries').doc_aaa1).visible).toBe(true);
    expect(store._hashes.get('wiki:slugs')['图书馆使用指南']).toBe('doc_aaa1');
  });

  it('默认不上架：无元数据的词条 visible 为 false', async () => {
    const { entries } = await wiki.listEntries({});
    expect(entries).toEqual([]);
    const withHidden = await wiki.listEntries({ includeHidden: true });
    expect(withHidden.entries.map(e => e.id)).toEqual(['doc_ccc3', 'doc_bbb2', 'doc_aaa1']);
    expect(withHidden.entries.every(e => e.visible === false)).toBe(true);
  });

  it('演示语料禁止上架，显式 allowSimulated 才放行', async () => {
    await expect(wiki.setVisibility({ docId: 'doc_bbb2', visible: true }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('模拟数据') });
    const forced = await wiki.setVisibility({ docId: 'doc_bbb2', visible: true, allowSimulated: true });
    expect(forced).toMatchObject({ visible: true, allowSimulated: true });
  });

  it('下架后词条从公开列表消失，但 slug 别名保留供管理员回访重上架', async () => {
    await wiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    const off = await wiki.setVisibility({ docId: 'doc_aaa1', visible: false, userId: 'admin' });
    expect(off).toMatchObject({ visible: false, slug: '图书馆使用指南' });
    expect(store._hashes.get('wiki:slugs')['图书馆使用指南']).toBe('doc_aaa1');
    expect((await wiki.listEntries({})).entries).toEqual([]);
    expect(await wiki.getEntry('图书馆使用指南')).toBeNull();
    const preview = await wiki.getEntry('图书馆使用指南', { privileged: true });
    expect(preview).toMatchObject({ id: 'doc_aaa1', visible: false });
  });

  it('同名标题生成不冲突的 slug', async () => {
    await wiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    documentService.getDocument.mockResolvedValueOnce(doc('doc_zzz1', '图书馆使用指南', '信息资源:校园指南', '# 图书馆使用指南\n\n正文'));
    const second = await wiki.setVisibility({ docId: 'doc_zzz1', visible: true });
    expect(second.slug).toBe('图书馆使用指南-2');
  });

  it('文档不存在返回 404', async () => {
    await expect(wiki.setVisibility({ docId: 'doc_missing', visible: true }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('WikiService.listEntries', () => {
  beforeEach(async () => {
    await wiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    await wiki.setVisibility({ docId: 'doc_ccc3', visible: true });
  });

  it('只返回已上架词条并带 slug', async () => {
    const { entries, total } = await wiki.listEntries({});
    expect(total).toBe(2);
    expect(entries.map(e => e.slug)).toEqual(['操作系统要点', '图书馆使用指南']);
  });

  it('标题命中即入选，未命中的词条才回读正文', async () => {
    store.hgetall.mockClear();
    const { entries } = await wiki.listEntries({ query: '操作系统' });
    expect(entries.map(e => e.id)).toEqual(['doc_ccc3']);
    // 另一条已上架词条（doc_aaa1）标题未命中，需要回读正文确认
    const read = store.hgetall.mock.calls.map(([key]) => key).filter(key => key.startsWith('document:'));
    expect(read).toEqual(['document:doc_aaa1']);
  });

  it('正文命中时给出命中摘要', async () => {
    store._hashes.set('document:doc_aaa1', { content: DOCS[0].content });
    const { entries } = await wiki.listEntries({ query: '8:00-22:00' });
    expect(entries.map(e => e.id)).toEqual(['doc_aaa1']);
    expect(entries[0].excerpt).toContain('8:00-22:00');
  });

  it('大小写不敏感且空查询不过滤', async () => {
    store._hashes.set('document:doc_aaa1', { content: DOCS[0].content });
    expect((await wiki.listEntries({ query: '  ' })).total).toBe(2);
    expect((await wiki.listEntries({ query: 'LIBRARY' })).entries).toEqual([]);
    store._hashes.set('document:doc_ccc3', { content: 'Operating System 进程' });
    expect((await wiki.listEntries({ query: 'operating' })).entries.map(e => e.id)).toEqual(['doc_ccc3']);
  });
});

describe('WikiService.getEntry', () => {
  it('未上架词条对普通用户不可见，管理员可预览', async () => {
    expect(await wiki.getEntry('doc_aaa1')).toBeNull();
    const preview = await wiki.getEntry('doc_aaa1', { privileged: true });
    expect(preview).toMatchObject({ id: 'doc_aaa1', visible: false, sourceLabel: '武汉理工大学图书馆' });
    expect(preview.body).toBe('## 开放时间\n\n8:00-22:00');
  });

  it('上架后可用 id 或 slug 访问', async () => {
    await wiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    const byId = await wiki.getEntry('doc_aaa1');
    const bySlug = await wiki.getEntry('图书馆使用指南');
    expect(byId.id).toBe('doc_aaa1');
    expect(bySlug.id).toBe(byId.id);
    expect(bySlug.slug).toBe('图书馆使用指南');
  });

  it('slug 指向已删除文档时清掉残留映射', async () => {
    await wiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    documentService.getDocument.mockImplementation(async () => null);
    expect(await wiki.getEntry('图书馆使用指南')).toBeNull();
    expect(store._hashes.get('wiki:slugs')['图书馆使用指南']).toBeUndefined();
  });

  it('未知标识与空标识返回 null', async () => {
    expect(await wiki.getEntry('doc_notexist')).toBeNull();
    expect(await wiki.getEntry('   ')).toBeNull();
  });
});
