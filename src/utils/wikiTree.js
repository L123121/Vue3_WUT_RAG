/**
 * Wiki 分类树
 *
 * 树是从实际入库文档反推出来的，而不是照抄 constants/wiki-categories.js：
 * ragdata 批量入库用的分类值（学校概况 / 专业课程 / 面试刷题 / AI学习）
 * 与前端预置分类表并不重合，只按预置表渲染会出现"有文档却看不到"。
 */

import { categoryGroups, splitCategory, UNGROUPED_LABEL } from '../constants/wiki-categories.js';

const GROUP_ORDER = new Map(categoryGroups.map((g, index) => [g.value, index]));
const SUB_ORDER = new Map(
  categoryGroups.flatMap(g => g.children.map((c, index) => [`${g.value}\n${c.label}`, index]))
);

const UNREGISTERED_ORDER = categoryGroups.length;

const docTime = (doc) => {
  const time = Date.parse(doc?.createdAt ?? 0);
  return Number.isNaN(time) ? 0 : time;
};

const byName = (a, b) => a.localeCompare(b, 'zh-Hans-CN');

const sortEntries = (entries) =>
  entries.slice().sort((a, b) => docTime(b) - docTime(a) || byName(a.title || '', b.title || ''));

/**
 * @param {Array} documents 知识库文档元信息（不含正文）
 * @returns {Array<{key,label,registered,count,flatLabel,children:Array}>}
 */
export function buildWikiTree(documents = []) {
  /** @type {Map<string, Map<string, Array>>} */
  const grouped = new Map();

  for (const doc of documents) {
    if (!doc || !doc.id) continue;
    const { group, sub } = splitCategory(doc.category);
    if (!grouped.has(group)) grouped.set(group, new Map());
    const subs = grouped.get(group);
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub).push(doc);
  }

  const groups = [...grouped.entries()].map(([group, subs]) => {
    const registered = GROUP_ORDER.has(group);
    const children = [...subs.entries()]
      .map(([sub, entries]) => ({
        key: sub ? `${group}:${sub}` : group,
        label: sub || group,
        anonymous: !sub,
        count: entries.length,
        entries: sortEntries(entries),
        order: registered ? (SUB_ORDER.get(`${group}\n${sub}`) ?? UNREGISTERED_ORDER) : UNREGISTERED_ORDER,
      }))
      .sort((a, b) =>
        a.order - b.order
        || (a.anonymous ? -1 : 0) - (b.anonymous ? -1 : 0)
        || byName(a.label, b.label)
      );

    return {
      key: group,
      label: group,
      registered,
      ungrouped: group === UNGROUPED_LABEL,
      order: registered ? GROUP_ORDER.get(group) : UNREGISTERED_ORDER,
      count: children.reduce((sum, child) => sum + child.count, 0),
      children,
    };
  });

  return groups.sort((a, b) =>
    (a.ungrouped ? 1 : 0) - (b.ungrouped ? 1 : 0)
    || a.order - b.order
    || byName(a.label, b.label)
  );
}

/**
 * 展平为有序词条列表，用于上一篇/下一篇与列表渲染
 */
export function flattenWikiEntries(tree = []) {
  return tree.flatMap(group => group.children.flatMap(child =>
    child.entries.map(doc => ({
      id: doc.id,
      slug: doc.slug || '',
      title: doc.title,
      category: doc.category,
      groupLabel: group.label,
      subLabel: child.anonymous ? '' : child.label,
      contentLength: doc.contentLength,
      chunkCount: doc.chunkCount,
      vectorStatus: doc.vectorStatus,
      createdAt: doc.createdAt,
      visible: doc.visible !== false,
      updatedBy: doc.updatedBy || '',
      excerpt: doc.excerpt || '',
    }))
  ));
}

/**
 * 词条链接：已上架的用 slug，未上架的（管理员治理视图）用 id
 */
export function wikiEntryPath(doc) {
  return `/wiki/${encodeURIComponent(doc?.slug || doc?.id || '')}`;
}

/**
 * 同一分类下的相邻词条，用于词条页底部推荐
 */
export function findRelatedEntries(entries = [], docId = '', limit = 6) {
  const current = entries.find(doc => doc.id === docId);
  if (!current) return [];
  const related = entries.filter(doc =>
    doc.id !== current.id
    && (doc.groupLabel === current.groupLabel)
    && (current.subLabel ? doc.subLabel === current.subLabel : true)
  );
  const picked = related.slice(0, limit);
  if (picked.length >= limit) return picked;
  const others = entries.filter(doc => doc.id !== current.id && !picked.includes(doc)).slice(0, limit - picked.length);
  return picked.concat(others);
}
