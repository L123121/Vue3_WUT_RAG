import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/memory/memory-store.service', () => ({ redis: {} }));

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

function createDocumentService(docs = DOCS) {
  return {
    listDocuments: vi.fn(async () => ({ documents: docs })),
    getDocument: vi.fn(async (id) => docs.find(d => d.id === id) || null),
  };
}

let store;
let documentService;
let wiki;

// 默认注入的 aiService 永远返回 isMock:true（等价于"无 API Key"的生产降级路径），
// 保证既有测试不会因为 setVisibility 内部 fire-and-forget 的互链梳理而意外触达真实
// ai.service.js（那条链会拉起指标/OTel 等一整套依赖）。需要测真实 LLM 路径的用例
// 显式传入自己的 fake aiService 覆盖它。
const noopAiService = { getCompletion: vi.fn(async () => ({ isMock: true })) };

function useWiki({ aiService: aiServiceOverride, docs } = {}) {
  delete require.cache[require.resolve('../src/services/wiki/wiki.service')];
  const { WikiService } = require('../src/services/wiki/wiki.service');
  const scopedDocumentService = docs ? createDocumentService(docs) : documentService;
  return new WikiService({ store, documentService: scopedDocumentService, aiService: aiServiceOverride || noopAiService });
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

  it('正文修订后普通访问拒绝 stale，管理员可预览且修订历史补齐', async () => {
    await wiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    documentService.getDocument.mockResolvedValue({
      ...DOCS[0],
      content: `${DOCS[0].content}\n\n新增开放说明`,
    });

    expect(await wiki.getEntry('doc_aaa1')).toBeNull();
    const preview = await wiki.getEntry('doc_aaa1', { privileged: true });
    expect(preview).toMatchObject({ stale: true, reviewState: 'stale', visible: true });
    const revisions = await wiki.getRevisionHistory('doc_aaa1');
    expect(revisions[0]).toMatchObject({ reason: 'source_updated', docId: 'doc_aaa1' });
  });

  it('删除词条元数据时同步删除 slug 和修订历史', async () => {
    await wiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    await wiki.removeDocumentMetadata('doc_aaa1');
    expect(store._hashes.get('wiki:entries')?.doc_aaa1).toBeUndefined();
    expect(store._hashes.get('wiki:slugs')?.['图书馆使用指南']).toBeUndefined();
    expect(store._hashes.get('wiki:revisions')?.doc_aaa1).toBeUndefined();
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

describe('WikiService 置信度分级', () => {
  it('演示语料=0.1，无来源真实内容=0.5（标注不裁的中间档），有来源真实内容=0.8', async () => {
    const noSourceDoc = doc('doc_eee5', '无来源真实条目', '学校概况', '# 无来源真实条目\n\n没有 source 声明的真实内容。');
    const localWiki = useWiki({ docs: [...DOCS, noSourceDoc] });

    const simulated = await localWiki.setVisibility({ docId: 'doc_bbb2', visible: true, allowSimulated: true });
    expect(simulated.confidence).toBe(0.1);

    const withSource = await localWiki.setVisibility({ docId: 'doc_aaa1', visible: true });
    expect(withSource.confidence).toBe(0.8);

    const withoutSource = await localWiki.setVisibility({ docId: 'doc_eee5', visible: true });
    expect(withoutSource.confidence).toBe(0.5);
  });
});

describe('WikiService 编译期互链', () => {
  // 与图书馆/操作系统词条分属不同分类，专门用于验证候选池与关联梳理，
  // 避免与既有测试共用的 DOCS 互相干扰
  const canteen = doc('doc_rel1', '食堂开放时间', '学校概况:餐饮服务', '# 食堂开放时间\n\n7:00-21:00');
  const dorm = doc('doc_rel2', '宿舍用电规定', '学校概况:住宿服务', '# 宿舍用电规定\n\n禁止使用大功率电器');
  const library = doc('doc_rel3', '图书馆座位预约', '信息资源:校园指南', '# 图书馆座位预约\n\n通过小程序预约');
  const RELATION_DOCS = [canteen, dorm, library];

  it('候选池按分类打分收窄：同组前缀优先，跨组无重叠不入选', async () => {
    const localWiki = useWiki({ docs: RELATION_DOCS });
    await localWiki.setVisibility({ docId: 'doc_rel2', visible: true });
    await localWiki.setVisibility({ docId: 'doc_rel3', visible: true });

    const candidates = await localWiki._candidateEntries(canteen);
    // dorm 与 canteen 分类前缀相同（学校概况:xxx）——用 scoreCandidate 的精确相等判断，
    // 这里分类字符串不同（:餐饮服务 vs :住宿服务），验证的是"完全相同分类"才给满分，
    // 不同分类即使前缀相同也退化为词面重叠打分
    expect(candidates.every((c) => c.docId !== 'doc_rel3')).toBe(true);
  });

  it('LLM 关联梳理：只信任白名单内的 docId，过滤幻觉候选，保留 reason', async () => {
    const fakeAi = {
      getCompletion: vi.fn(async () => ({
        content: JSON.stringify([
          { docId: 'doc_rel2', reason: '同属学校概况分类，均为住宿餐饮相关' },
          { docId: 'doc_not_exist', reason: '幻觉出的 docId，必须被过滤' },
        ]),
      })),
    };
    const localWiki = useWiki({ docs: RELATION_DOCS, aiService: fakeAi });
    await localWiki.setVisibility({ docId: 'doc_rel2', visible: true });
    await localWiki.setVisibility({ docId: 'doc_rel1', visible: true });

    const relatedPages = await localWiki.compileRelatedPages('doc_rel1');
    expect(relatedPages).toEqual([{ docId: 'doc_rel2', reason: '同属学校概况分类，均为住宿餐饮相关' }]);
    expect(fakeAi.getCompletion).toHaveBeenCalledOnce();
  });

  it('候选池为空时不调用 LLM（省一次调用）；aiService 缺失时优雅降级为空数组', async () => {
    const fakeAi = { getCompletion: vi.fn(async () => ({ content: '[]' })) };
    const localWiki = useWiki({ docs: RELATION_DOCS, aiService: fakeAi });
    await localWiki.setVisibility({ docId: 'doc_rel1', visible: true });

    const relatedPages = await localWiki.compileRelatedPages('doc_rel1');
    expect(relatedPages).toEqual([]);
    expect(fakeAi.getCompletion).not.toHaveBeenCalled();

    // 用不带 getCompletion 的对象模拟"AI 能力不可用"，而不是 undefined——
    // undefined 会被 useWiki 的默认参数替换成 noopAiService，测不到真正的降级分支
    const noAiWiki = useWiki({ docs: RELATION_DOCS, aiService: {} });
    await noAiWiki.setVisibility({ docId: 'doc_rel2', visible: true });
    await noAiWiki.setVisibility({ docId: 'doc_rel1', visible: true });
    await expect(noAiWiki.compileRelatedPages('doc_rel1')).resolves.toEqual([]);
  });

  it('setVisibility 上架且内容变化时异步触发互链梳理；重复上架但内容未变则跳过', async () => {
    const fakeAi = {
      getCompletion: vi.fn(async () => ({
        content: JSON.stringify([{ docId: 'doc_rel2', reason: '关联' }]),
      })),
    };
    const localWiki = useWiki({ docs: RELATION_DOCS, aiService: fakeAi });
    await localWiki.setVisibility({ docId: 'doc_rel2', visible: true });
    await localWiki.setVisibility({ docId: 'doc_rel1', visible: true });
    // setVisibility 内部是 fire-and-forget，显式等待一次微任务让它落地
    await new Promise((resolve) => setImmediate(resolve));
    expect((await localWiki.getMeta('doc_rel1')).relatedPages).toEqual([{ docId: 'doc_rel2', reason: '关联' }]);

    fakeAi.getCompletion.mockClear();
    await localWiki.setVisibility({ docId: 'doc_rel1', visible: false });
    await localWiki.setVisibility({ docId: 'doc_rel1', visible: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakeAi.getCompletion).not.toHaveBeenCalled();
  });

  it('标注不裁：目标词条下架后详情页读取自动过滤，但底层 relatedPages 记录保留', async () => {
    const fakeAi = {
      getCompletion: vi.fn(async () => ({
        content: JSON.stringify([{ docId: 'doc_rel2', reason: '关联' }]),
      })),
    };
    const localWiki = useWiki({ docs: RELATION_DOCS, aiService: fakeAi });
    await localWiki.setVisibility({ docId: 'doc_rel2', visible: true });
    await localWiki.setVisibility({ docId: 'doc_rel1', visible: true });
    await localWiki.compileRelatedPages('doc_rel1');

    const entryBefore = await localWiki.getEntry('doc_rel1', { privileged: true });
    expect(entryBefore.relatedPages).toEqual([{ id: 'doc_rel2', slug: expect.any(String), title: '宿舍用电规定', reason: '关联' }]);

    await localWiki.setVisibility({ docId: 'doc_rel2', visible: false });
    const entryAfter = await localWiki.getEntry('doc_rel1', { privileged: true });
    expect(entryAfter.relatedPages).toEqual([]);
    // 被动过滤，不是重写：底层记录仍指向 doc_rel2，下次重编译会自然清理或替换
    expect((await localWiki.getMeta('doc_rel1')).relatedPages).toEqual([{ docId: 'doc_rel2', reason: '关联' }]);
  });

  it('管理端可显式重算互链，候选池变化后不必依赖反复切换上下架', async () => {
    // 按 prompt 里出现的目标标题分辨请求对象，避免与 setVisibility 内部
    // fire-and-forget 触发的另一侧编译请求互相抢答同一个 mockResolvedValueOnce
    const fakeAi = {
      getCompletion: vi.fn(async (prompt) => (
        prompt.includes(canteen.title)
          ? { content: JSON.stringify([{ docId: 'doc_rel2', reason: '后补关联' }]) }
          : { content: '[]' }
      )),
    };
    const localWiki = useWiki({ docs: RELATION_DOCS, aiService: fakeAi });
    await localWiki.setVisibility({ docId: 'doc_rel1', visible: true });
    await new Promise((resolve) => setImmediate(resolve));

    await localWiki.setVisibility({ docId: 'doc_rel2', visible: true });
    const recompiled = await localWiki.compileRelatedPages('doc_rel1');
    expect(recompiled).toEqual([{ docId: 'doc_rel2', reason: '后补关联' }]);
  });
});
