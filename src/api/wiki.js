/**
 * 校园百科 API
 *
 * 词条正文与知识库同源，治理侧（上架状态、slug、正文解析）由 /api/wiki 提供，
 * 前端不再自行解析 front-matter——"演示语料禁止上架"这条规则只在后端判一次。
 */

import { apiGet, apiPut } from './client.js';

export const getWikiEntries = async (params = {}) => {
  const query = new URLSearchParams();
  if (params.q) query.append('q', params.q);
  if (params.includeHidden) query.append('includeHidden', 'true');
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const response = await apiGet(`/wiki/entries${suffix}`);
  return response.json();
};

export const getWikiEntry = async (idOrSlug) => {
  const response = await apiGet(`/wiki/entries/${encodeURIComponent(idOrSlug)}`);
  return response.json();
};

export const setWikiEntryVisibility = async (docId, { visible, allowSimulated = false }) => {
  const response = await apiPut(`/wiki/entries/${encodeURIComponent(docId)}/visibility`, {
    visible,
    allowSimulated,
  });
  return response.json();
};
