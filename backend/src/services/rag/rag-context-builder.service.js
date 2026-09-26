"use strict";

/**
 * 父段上下文组装：子片段按父段落聚合 + 从已 rerank 的父段构建最终上下文
 * 从 rag.service 拆出，纯数据变换 + 文档查询，无检索/生成逻辑
 */

/**
 * 将子句列表按父段落分组（保留原始数据供 reranker 使用）
 * @param {Array} chunks - 子片段候选列表
 * @returns {Map} parentId → { parentId, bestChunk, chunks, parentText, docId, parentIdx, firstChildRank }
 */
function groupChunksByParent(chunks) {
  const paraMap = new Map();
  for (const chunk of chunks) {
    const key = chunk.parentId || (chunk.docId + '_para_' + (chunk.parentIdx ?? 0));
    if (!key) continue;
    const current = paraMap.get(key) || {
      parentId: key,
      bestChunk: chunk,
      chunks: [],
      parentText: chunk.parentText || '',
      docId: chunk.docId,
      parentIdx: chunk.parentIdx,
      firstChildRank: 0,
    };
    current.chunks.push(chunk);
    current.firstChildRank = current.firstChildRank || chunks.indexOf(chunk) + 1;
    if ((chunk.score || 0) > (current.bestChunk.score || 0)) current.bestChunk = chunk;
    if ((chunk.parentText || '').length > current.parentText.length) {
      current.parentText = chunk.parentText;
    }
    paraMap.set(key, current);
  }
  return paraMap;
}

/**
 * 从已 rerank 的父段落聚合结果构建上下文
 *
 * @param {Array} parentCandidates - 父段候选（需含 docId、parentText/bestChunk.text、_rerankScore）
 * @param {Object} deps
 * @param {number} deps.maxContextLength - 上下文长度上限（支持请求级覆盖，A/B 评测"少而精"）
 * @param {Function} deps.getDocument - 按 docId 查询文档
 * @returns {Promise<{ sources: Array, context: string }>}
 */
async function buildContextFromParents(parentCandidates, { maxContextLength, getDocument } = {}) {
  if (!parentCandidates || parentCandidates.length === 0) {
    return { sources: [], context: '' };
  }
  // 按 rerank 分数排序（rerank 已对所有父段打分，取高分优先）
  parentCandidates.sort((a, b) => (b._rerankScore || b.bestChunk?.score || 0) - (a._rerankScore || a.bestChunk?.score || 0));
  const selected = parentCandidates;

  const contextParts = [];
  const sources = [];
  let totalLength = 0;
  let docIndex = 0;
  const docCache = new Map();

  for (const match of selected) {
    const docId = match.docId;
    if (!docId) continue;

    let doc = docCache.get(docId);
    if (!doc) {
      doc = await getDocument(docId);
      if (!doc) continue;
      docCache.set(docId, doc);
    }

    const paraText = match.parentText || match.bestChunk?.text || match.bestChunk?.parentText || '';
    if (!paraText) continue;
    docIndex++;

    const header = `【文档 ${docIndex}】${doc.title}（段落 ${(match.parentIdx ?? 0) + 1}）`;
    const entry = `${header}\n${paraText}`;
    const rerankScore = match._rerankScore || match.bestChunk?.score || 0;

    if (totalLength + entry.length > maxContextLength) {
      const remaining = maxContextLength - totalLength;
      if (remaining > 200) {
        contextParts.push(entry.substring(0, remaining) + '\n...(截断)');
        sources.push({
          id: doc.id, title: doc.title, category: doc.category,
          matchedScore: rerankScore, rerankScore, rerankModel: match._rerankModel || '',
          snippet: paraText.substring(0, 1500),
        });
      }
      break;
    }

    contextParts.push(entry);
    totalLength += entry.length;
    sources.push({
      id: doc.id, title: doc.title, category: doc.category,
      matchedScore: rerankScore, rerankScore, rerankModel: match._rerankModel || '',
      snippet: paraText.substring(0, 1500),
    });
  }

  const context = contextParts.join('\n\n' + '='.repeat(40) + '\n\n');
  return { sources, context };
}

module.exports = { groupChunksByParent, buildContextFromParents };
