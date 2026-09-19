import { describe, expect, it } from 'vitest';
import { buildWikiTree, flattenWikiEntries, findRelatedEntries, wikiEntryPath } from '../utils/wikiTree.js';

const doc = (id, title, category, extra = {}) => ({
  id,
  title,
  category,
  contentLength: 100,
  chunkCount: 3,
  createdAt: extra.createdAt || '2026-01-01T00:00:00.000Z',
  slug: extra.slug || '',
  visible: extra.visible !== false,
});

describe('buildWikiTree', () => {
  const documents = [
    doc('d1', '操作系统复习', '课程资料:操作系统'),
    doc('d2', '数据结构要点', '课程资料:数据结构'),
    doc('d3', '培养方案', '信息资源:本科培养方案'),
    doc('d4', '学校概况', '学校概况'),
    doc('d5', '无分类文档', ''),
  ];
  const tree = buildWikiTree(documents);

  it('预置分类按定义顺序、未登记分类按名称、未分类最后', () => {
    expect(tree.map(g => g.label)).toEqual(['课程资料', '信息资源', '学校概况', '未分类']);
    expect(tree.map(g => g.registered)).toEqual([true, true, false, false]);
  });

  it('二级分类按预置表顺序，组内计数为子分类之和', () => {
    const course = tree[0];
    expect(course.children.map(c => c.label)).toEqual(['操作系统', '数据结构']);
    expect(course.count).toBe(2);
    expect(course.children[0].entries.map(d => d.id)).toEqual(['d1']);
  });

  it('无二级分类的语料归为匿名子分类', () => {
    const school = tree[2];
    expect(school.children).toHaveLength(1);
    expect(school.children[0].anonymous).toBe(true);
    expect(school.children[0].label).toBe('学校概况');
  });

  it('同组词条按入库时间倒序', () => {
    const sorted = buildWikiTree([
      doc('old', '旧', '课程资料:操作系统', { createdAt: '2025-01-01T00:00:00.000Z' }),
      doc('new', '新', '课程资料:操作系统', { createdAt: '2026-06-01T00:00:00.000Z' }),
    ])[0].children[0].entries;
    expect(sorted.map(d => d.id)).toEqual(['new', 'old']);
  });

  it('忽略缺 id 的脏数据且不抛异常', () => {
    expect(buildWikiTree([null, { title: '无 id' }, undefined])).toEqual([]);
  });
});

describe('flattenWikiEntries', () => {
  const flat = flattenWikiEntries(buildWikiTree([
    doc('d1', '操作系统', '课程资料:操作系统', { slug: '操作系统' }),
    doc('d2', '草稿', '课程资料:数据结构', { visible: false }),
    doc('d3', '学校概况', '学校概况'),
  ]));

  it('按分类树顺序展平并带上分类标签', () => {
    expect(flat.map(d => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(flat[0]).toMatchObject({ groupLabel: '课程资料', subLabel: '操作系统', slug: '操作系统' });
    expect(flat[2]).toMatchObject({ groupLabel: '学校概况', subLabel: '' });
  });

  it('透传治理字段，未上架词条保留可见标记', () => {
    expect(flat[0].visible).toBe(true);
    expect(flat[1]).toMatchObject({ visible: false, slug: '' });
  });

  it('缺字段的文档不会抛异常', () => {
    const sparse = flattenWikiEntries(buildWikiTree([{ id: 'x', title: 'X' }]));
    expect(sparse[0]).toMatchObject({ id: 'x', slug: '', excerpt: '', visible: true });
  });
});

describe('wikiEntryPath', () => {
  it('优先用 slug，未上架或无 slug 时退回 id', () => {
    expect(wikiEntryPath({ id: 'doc_1', slug: '图书馆使用指南' })).toBe('/wiki/%E5%9B%BE%E4%B9%A6%E9%A6%86%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97');
    expect(decodeURIComponent(wikiEntryPath({ id: 'doc_1', slug: '图书馆使用指南' }))).toBe('/wiki/图书馆使用指南');
    expect(wikiEntryPath({ id: 'doc_1', slug: '' })).toBe('/wiki/doc_1');
    expect(wikiEntryPath(undefined)).toBe('/wiki/');
  });
});

describe('findRelatedEntries', () => {
  const flat = flattenWikiEntries(buildWikiTree([
    doc('d1', '操作系统', '课程资料:操作系统'),
    doc('d2', '数据结构', '课程资料:数据结构'),
    doc('d3', '培养方案', '信息资源:本科培养方案'),
    doc('d4', '学校概况', '学校概况'),
  ]));

  it('优先同组同子类，不足时补足其他词条', () => {
    expect(findRelatedEntries(flat, 'd1').map(d => d.id)).toEqual(['d2', 'd3', 'd4']);
    expect(findRelatedEntries(flat, 'd4').map(d => d.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('未知词条与空列表返回空', () => {
    expect(findRelatedEntries(flat, 'missing')).toEqual([]);
    expect(findRelatedEntries([], 'd1')).toEqual([]);
  });
});
