'use strict';

const crypto = require('crypto');
const { charBigrams, supportScore, splitAnswerSentences } = require('../rag/grounding.service');

const revisionOf = (text) => crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
const cleanClaim = (text) => String(text || '').replace(/\[\d[\d\s,，、]*\]/g, '').replace(/【文档\s*\d+】/g, '').replace(/[*_`]/g, '').trim();
const comparable = (text) => cleanClaim(text).replace(/[\s。！!？?；;]+$/g, '');

function claimsFromAnswer(answer, card) {
  if (card && Array.isArray(card.steps)) {
    return [
      ...card.steps.map((step, index) => ({ id: step.id || `step-${index}`, kind: 'step', text: [step.title, step.detail].filter(Boolean).join('：') })),
      ...(Array.isArray(card.materials) ? card.materials : []).map((item, index) => ({ id: item.id || `material-${index}`, kind: 'material', text: typeof item === 'string' ? item : item.text })),
      ...['location', 'duration', 'notes'].filter(key => typeof card[key] === 'string' && card[key].trim()).map(key => ({ id: key, kind: key, text: card[key] })),
    ].filter(item => item.text);
  }
  return splitAnswerSentences(String(answer || '').slice(0, 24000))
    .map((text, index) => ({ id: `claim-${index}`, kind: 'statement', text }));
}

function passages(source) {
  const text = String(source.text || '');
  const result = [];
  for (const match of text.matchAll(/[^\n。！？!?；;]+[。！？!?；;]?/g)) {
    const quote = match[0].trim();
    if (quote.length < 2) continue;
    const start = match.index + match[0].indexOf(quote);
    for (let offset = 0; offset < quote.length; offset += 1000) {
      result.push({ quote: quote.slice(offset, offset + 1200), offset: start + offset });
      if (offset + 1200 >= quote.length) break;
    }
  }
  return result;
}

function numericDifference(claim, quote) {
  const numbers = (text) => [...text.matchAll(/\d+(?:[.:：/-]\d+)*(?:%|％|元|份|天|人|月|日|年)?/g)].map(match => match[0]);
  const a = numbers(cleanClaim(claim));
  const b = numbers(quote);
  return a.length > 0 && b.length > 0 && a.some(value => !b.includes(value));
}

function buildEvidenceReport({ answer = '', card = null, claims: suppliedClaims, sources = [], origin = 'retrieval_snapshot' } = {}) {
  const inputClaims = suppliedClaims || claimsFromAnswer(answer, card);
  const documents = sources.filter(source => source.docId && source.text).slice(0, 30);
  const rawCandidates = documents.flatMap(source => passages(source).map(passage => ({ ...passage, source })));
  const candidates = rawCandidates.slice(0, 2000).map(candidate => ({ ...candidate, grams: charBigrams(candidate.quote) }));
  const evidence = [];
  const claims = inputClaims.slice(0, 80).map((claim) => {
    const text = String(claim.text || '').slice(0, 1200);
    const query = comparable(text);
    const grams = charBigrams(query);
    const ranked = candidates.map(candidate => {
      const exact = query.length >= 2 && candidate.quote.includes(query);
      const score = supportScore(grams, candidate.grams);
      return { ...candidate, exact, score };
    }).filter(candidate => query.length >= 2 && (candidate.exact || candidate.score >= 0.35))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
    const selected = [];
    const seen = new Set();
    for (const match of ranked) {
      if (seen.has(match.source.docId)) continue;
      seen.add(match.source.docId);
      selected.push(match);
      if (selected.length === 3) break;
    }
    const evidenceIds = selected.map((match, index) => {
      const id = `${claim.id}:e${index}`;
      const numericMismatch = !match.exact && numericDifference(text, match.quote);
      evidence.push({
        id, claimId: claim.id, docId: match.source.docId,
        revision: match.source.revision || null,
        title: match.source.title || '未命名来源',
        quote: match.quote.slice(0, 1200),
        quoteTruncated: match.quote.length > 1200,
        start: (match.source.start || 0) + match.offset,
        end: (match.source.start || 0) + match.offset + Math.min(match.quote.length, 1200),
        match: match.exact ? 'exact' : 'candidate',
        needsReview: numericMismatch,
        reviewReason: numericMismatch ? '关键数字存在差异，请结合适用范围核对；不代表已判定事实冲突。' : null,
      });
      return id;
    });
    return {
      id: claim.id, kind: claim.kind || 'statement', text,
      status: selected.some(item => item.exact) ? 'exact' : selected.length ? 'candidate' : 'unverified',
      evidenceIds,
    };
  });
  return {
    version: 1, origin, createdAt: new Date().toISOString(),
    offsetBasis: origin === 'retrieval_snapshot' ? 'context_snapshot' : 'source_body',
    notice: '原文出现或词面相关不等于事实正确。未匹配不代表错误；来源时效、否定语义及适用范围仍需人工核验。排除来源仅重算可见依据，不重新生成回答。',
    truncated: inputClaims.length > 80 || String(answer).length > 24000 || rawCandidates.length > 2000 || sources.length > 30 || documents.some(source => source.truncated) || inputClaims.some(claim => String(claim.text).length > 1200),
    sources: documents.map(source => ({
      docId: source.docId, title: source.title || '未命名来源', revision: source.revision || null,
      sourceLabel: source.sourceLabel || '', reviewedAt: source.reviewedAt || null,
      effectiveFrom: source.effectiveFrom || null, effectiveUntil: source.effectiveUntil || null,
      scope: source.scope || null, simulated: source.simulated === true,
    })).filter((source, index, all) => all.findIndex(item => item.docId === source.docId && item.revision === source.revision) === index),
    claims, evidence,
  };
}

function clipEvidenceSources(sources = [], start, end, shift = 0) {
  return sources.flatMap(source => {
    const overlapStart = Math.max(start, source.start);
    const overlapEnd = Math.min(end, source.start + source.text.length);
    if (overlapEnd <= overlapStart) return [];
    return [{ ...source, start: overlapStart - start + shift, text: source.text.slice(overlapStart - source.start, overlapEnd - source.start) }];
  });
}

module.exports = { buildEvidenceReport, claimsFromAnswer, revisionOf, clipEvidenceSources };
