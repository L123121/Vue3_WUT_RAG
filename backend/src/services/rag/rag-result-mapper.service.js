"use strict";

function chunkToCandidate(chunk, rank) {
  return {
    rank,
    id: chunk.id || `${chunk.docId}:${chunk.chunkIndex}`,
    docId: chunk.docId,
    parentId: chunk.parentId || `${chunk.docId}_para_${chunk.parentIdx ?? 0}`,
    parentIdx: chunk.parentIdx ?? -1,
    chunkIndex: chunk.chunkIndex ?? -1,
    title: chunk.title || '',
    category: chunk.category || '',
    text: chunk.text || '',
    score: chunk.score || 0,
    vectorScore: chunk._vectorScore || 0,
    sparseScore: chunk._sparseScore || 0,
    hybridScore: chunk._hybridScore || chunk.score || 0,
    keywordScore: chunk._keywordScore || 0,
    rerankScore: chunk._rerankScore || 0,
    rerankModel: chunk._rerankModel || '',
    retrievalChannels: chunk._retrievalChannels || [],
  };
}

function buildParentSource(doc, match) {
  const chunkIndexes = [...new Set(match.chunks.map((chunk) => chunk.chunkIndex).filter((index) => index !== undefined))];
  const channels = [...new Set(match.chunks.flatMap((chunk) => chunk._retrievalChannels || []))];
  const rerankScore = match.bestChunk._rerankScore || 0;
  return {
    id: doc.id, title: doc.title, category: doc.category, chunkCount: doc.chunkCount,
    matchedChunks: chunkIndexes.length || match.chunks.length, matchedChunkIds: chunkIndexes,
    snippet: (match.parentText || match.bestChunk?.text || '').substring(0, 1500),
    matchedScore: rerankScore || match.bestChunk.score || 0,
    vectorScore: match.bestChunk._vectorScore || 0, sparseScore: match.bestChunk._sparseScore || 0,
    hybridScore: match.bestChunk._hybridScore || match.bestChunk.score || 0,
    keywordScore: match.bestChunk._keywordScore || 0, rerankScore,
    rerankModel: match.bestChunk._rerankModel || '', retrievalChannels: channels,
  };
}

function parentMatchToCandidate(match, doc, rank, options = {}) {
  const chunkIndexes = [...new Set(match.chunks.map((chunk) => chunk.chunkIndex).filter((index) => index !== undefined))];
  const channels = [...new Set(match.chunks.flatMap((chunk) => chunk._retrievalChannels || []))];
  const parentId = match.parentId || match.bestChunk.parentId || `${match.docId}_para_${match.parentIdx ?? 0}`;
  return {
    rank, id: parentId, parentId, docId: match.docId,
    title: doc?.title || match.bestChunk.title || '', category: doc?.category || match.bestChunk.category || '',
    parentIdx: match.parentIdx ?? match.bestChunk.parentIdx ?? -1,
    parentText: match.parentText || match.bestChunk.text || doc?.content || '',
    matchedChunks: chunkIndexes.length || match.chunks.length, matchedChunkIds: chunkIndexes,
    firstChildRank: match.firstChildRank, bestChildRank: match.bestChunk._childRank || match.firstChildRank,
    matchedScore: match.bestChunk.score || 0, vectorScore: match.bestChunk._vectorScore || 0,
    sparseScore: match.bestChunk._sparseScore || 0,
    hybridScore: match.bestChunk._hybridScore || match.bestChunk.score || 0,
    keywordScore: match.bestChunk._keywordScore || 0, retrievalChannels: channels,
    children: options.includeChildren === false
      ? undefined
      : match.chunks.map((chunk) => chunkToCandidate(chunk, chunk._childRank)).sort((a, b) => a.rank - b.rank),
  };
}

function chunkToSource(chunk) {
  return {
    id: chunk.docId, title: chunk.title, category: chunk.category, chunkIndex: chunk.chunkIndex,
    matchedScore: chunk.score || 0, parentId: chunk.parentId || chunk.docId,
    vectorScore: chunk._vectorScore || 0, sparseScore: chunk._sparseScore || 0,
    hybridScore: chunk._hybridScore || chunk.score || 0, keywordScore: chunk._keywordScore || 0,
    rerankScore: chunk._rerankScore || 0, rerankModel: chunk._rerankModel || '',
    retrievalChannels: chunk._retrievalChannels || [],
  };
}

function summarizeRetrievalTrace(trace, rerank) {
  if (!trace) return null;
  return {
    mode: trace.mode, category: trace.category, topK: trace.topK,
    rerank: { enabled: rerank.enabled, topK: rerank.topK, model: 'bge-reranker-base' },
    embedding: trace.embedding, vector: trace.vector, keyword: trace.keyword,
    fused: trace.fused, queryRewrite: trace.queryRewrite || null,
  };
}

function preferFilledFields(existing, incoming) {
  return {
    text: existing.text || incoming.text || '', title: existing.title || incoming.title || '',
    category: existing.category || incoming.category || '', docId: existing.docId || incoming.docId || '',
    parentId: existing.parentId || incoming.parentId || existing.docId || incoming.docId || '',
    chunkIndex: existing.chunkIndex ?? incoming.chunkIndex ?? -1,
  };
}

const normalizeScore = (score) => Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
const hasReliableCandidates = (candidates, minSourceScore) => candidates.length > 0 && (candidates[0].score || 0) >= minSourceScore;

module.exports = {
  buildParentSource,
  chunkToCandidate,
  chunkToSource,
  hasReliableCandidates,
  normalizeScore,
  parentMatchToCandidate,
  preferFilledFields,
  summarizeRetrievalTrace,
};
