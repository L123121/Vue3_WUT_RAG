'use strict';

const { redis: store } = require('../memory/memory-store.service');

const EVALUATION_KEY = 'quality_governance:evaluations';
const EVALUATION_PAYLOAD_KEY = 'quality_governance:eval_payloads';
const AUDIT_KEY = 'quality_governance:audits';
const TASK_KEY = 'quality_governance:tasks';
const MAX_AUDITS = 2000;

const topics = [
  { key: 'academic', label: '教务与学业', terms: ['成绩', '考试', '选课', '转专业', '休学', '毕业', '学分', '补考', '重修'] },
  { key: 'affairs', label: '学生事务', terms: ['奖学金', '助学金', '请假', '证明', '档案', '医保', '资助'] },
  { key: 'campus', label: '校园服务', terms: ['校区', '宿舍', '食堂', '图书馆', '门禁', '校园卡', '校车', '开放时间'] },
  { key: 'admission', label: '招生与就业', terms: ['招生', '录取', '考研', '就业', '招聘', '实习', '保研'] },
  { key: 'finance', label: '缴费与财务', terms: ['缴费', '学费', '住宿费', '退费', '发票'] },
  { key: 'safety', label: '安全与应急', terms: ['报警', '急救', '火灾', '诈骗', '安全', '心理', '保卫处'] },
];
const uncertaintyTerms = ['不确定', '无法确认', '可能', '以官网', '以通知', '建议咨询', '暂无资料', '没有检索到'];

const parse = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const trim = (value, limit = 260) => {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
};
const toRatio = (value) => {
  const number = Number.parseFloat(String(value ?? '').replace('%', ''));
  if (!Number.isFinite(number)) return null;
  return number > 1 ? number / 100 : number;
};
const safeNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const trimList = async (key, limit) => {
  if (typeof store.llen !== 'function' || typeof store.ltrim !== 'function') return;
  const length = await store.llen(key);
  if (length > limit) await store.ltrim(key, length - limit, -1);
};

async function getEvaluations() {
  const values = await store.hgetall(EVALUATION_KEY);
  return Object.values(values || {}).map(parse).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function saveEvaluation(input = {}) {
  const metrics = input.metrics || {};
  const item = {
    id: String(input.id || `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    datasetVersion: String(input.datasetVersion || 'campus-qa-v1'),
    model: String(input.model || 'unknown'),
    promptVersion: String(input.promptVersion || 'rag-prompt-v1'),
    metrics: {
      faithfulness: safeNumber(metrics.faithfulness),
      answer_relevancy: safeNumber(metrics.answer_relevancy),
      context_precision: safeNumber(metrics.context_precision),
      context_recall: safeNumber(metrics.context_recall),
      overall: safeNumber(metrics.overall),
    },
    avgLatency: Math.round(safeNumber(input.avgLatency)),
    costCny: Math.round(safeNumber(input.costCny) * 100000) / 100000,
    satisfactionRate: toRatio(input.satisfactionRate),
    citationCoverage: toRatio(input.citationCoverage),
    sampleCount: Math.round(safeNumber(input.sampleCount)),
    // ragas = 在线评测管道；manual = 离线报告导入（POST /api/eval/import）
    source: String(input.source || 'ragas'),
    createdAt: input.createdAt || new Date().toISOString(),
  };
  await store.hset(EVALUATION_KEY, item.id, item);
  return item;
}

/**
 * 导入离线评测报告（eval-report.json / ragas-results.json，人工评测工作流）：
 * results 聚合为一条评测记录（source='manual'，进入与在线 RAGAS 同一历史对比表），
 * 完整报告（results + 人工打分）存入 payload，供工作台免上传回放与打分续写。
 */
async function importEvaluation(report = {}) {
  const results = Array.isArray(report.results) ? report.results : [];
  if (results.length === 0) {
    const error = new Error('报告缺少 results 数组');
    error.status = 400;
    throw error;
  }

  // 聚合 RAGAS 指标：只统计带有限数值的条目，缺指标不拉低均值
  const withMetrics = results.filter((item) => item.metrics && typeof item.metrics === 'object');
  const metrics = {};
  for (const key of ['faithfulness', 'answer_relevancy', 'context_precision', 'context_recall', 'overall']) {
    const values = withMetrics
      .map((item) => Number(item.metrics[key]))
      .filter(Number.isFinite);
    metrics[key] = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }
  const latencies = results.map((item) => Number(item.latency)).filter(Number.isFinite);

  // 兼容打分导出格式（humanScore/comment 平铺在 results 里），还原为按 id 的映射
  const humanScores = { ...(report.humanScores || {}) };
  const comments = { ...(report.comments || {}) };
  for (const item of results) {
    if (!item.id) continue;
    if (item.humanScore != null && humanScores[item.id] == null) humanScores[item.id] = item.humanScore;
    if (item.comment && !comments[item.id]) comments[item.id] = item.comment;
  }

  const record = await saveEvaluation({
    datasetVersion: String(report.datasetVersion || report.meta?.datasetVersion || 'manual-import'),
    model: String(report.model || results.find((item) => item.model)?.model || 'manual-import'),
    promptVersion: String(report.promptVersion || 'manual-import'),
    metrics,
    avgLatency: latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : 0,
    sampleCount: results.length,
    source: 'manual',
  });

  await store.hset(EVALUATION_PAYLOAD_KEY, record.id, {
    evaluationId: record.id,
    importedAt: new Date().toISOString(),
    results,
    humanScores,
    comments,
  });

  return { ...record, scoredCount: Object.keys(humanScores).length };
}

/** 取导入报告的完整 payload（results + 人工打分），不存在返回 null */
async function getEvaluationPayload(id) {
  return parse(await store.hget(EVALUATION_PAYLOAD_KEY, id));
}

/**
 * 回写人工打分（整体替换语义：客户端持有完整映射，未打分即从映射中移除）
 */
async function updateEvaluationScores(id, { humanScores, comments } = {}) {
  const payload = await getEvaluationPayload(id);
  if (!payload) {
    const error = new Error('评测记录不存在');
    error.status = 404;
    throw error;
  }
  if (humanScores !== undefined) payload.humanScores = humanScores;
  if (comments !== undefined) payload.comments = comments;
  payload.scoredAt = new Date().toISOString();
  await store.hset(EVALUATION_PAYLOAD_KEY, id, payload);
  return { id, scoredCount: Object.keys(payload.humanScores || {}).length };
}

function compareEvaluations(history) {
  const current = history[0] || null;
  const previous = history[1] || null;
  if (!current) return { current: null, previous: null, deltas: {}, best: null };
  const deltas = {};
  for (const key of ['faithfulness', 'answer_relevancy', 'context_precision', 'context_recall']) {
    deltas[key] = previous ? Math.round((current.metrics[key] - previous.metrics[key]) * 1000) / 10 : null;
  }
  deltas.satisfactionRate = previous && current.satisfactionRate !== null && previous.satisfactionRate !== null ? Math.round((current.satisfactionRate - previous.satisfactionRate) * 1000) / 10 : null;
  deltas.citationCoverage = previous && current.citationCoverage !== null && previous.citationCoverage !== null ? Math.round((current.citationCoverage - previous.citationCoverage) * 1000) / 10 : null;
  deltas.avgLatency = previous ? current.avgLatency - previous.avgLatency : null;
  deltas.costCny = previous ? Math.round((current.costCny - previous.costCny) * 100000) / 100000 : null;
  deltas.costPercent = previous && previous.costCny > 0 ? Math.round(((current.costCny - previous.costCny) / previous.costCny) * 1000) / 10 : null;

  const minLatency = Math.min(...history.map((item) => item.avgLatency || Number.POSITIVE_INFINITY));
  const costs = history.map((item) => item.costCny).filter((value) => value > 0);
  const minCost = costs.length ? Math.min(...costs) : 0;
  const ranked = history.map((item) => {
    const quality = Object.values(item.metrics || {}).slice(0, 4).reduce((sum, value) => sum + safeNumber(value), 0) / 4;
    const satisfaction = item.satisfactionRate ?? 0.5;
    const citation = item.citationCoverage ?? 0.5;
    const latency = item.avgLatency && minLatency ? minLatency / item.avgLatency : 0;
    const cost = item.costCny && minCost ? minCost / item.costCny : 0;
    return { ...item, compositeScore: Math.round((quality * 0.55 + satisfaction * 0.2 + citation * 0.15 + Math.min(latency, 1) * 0.05 + Math.min(cost, 1) * 0.05) * 1000) / 1000 };
  }).sort((a, b) => b.compositeScore - a.compositeScore);
  return { current, previous, deltas, best: ranked[0] || null, ranked: ranked.slice(0, 8) };
}

function classify({ question, answer, sources = [] }) {
  const questionText = String(question || '');
  const answerText = String(answer || '');
  const topic = topics.map((item) => ({ ...item, hits: item.terms.filter((term) => questionText.includes(term)).length })).sort((a, b) => b.hits - a.hits)[0];
  const sourceCount = Array.isArray(sources) ? sources.length : 0;
  const uncertaintyHits = uncertaintyTerms.filter((term) => answerText.includes(term)).length;
  const topicKey = topic?.hits ? topic.key : 'general';
  const topicLabel = topic?.hits ? topic.label : '综合咨询';
  const domainQuestion = (topic?.hits || 0) > 0;
  const riskScore = Math.min(100, (topic?.hits || 0) * 20 + (domainQuestion && sourceCount === 0 ? 35 : 0) + uncertaintyHits * 10 + (topicKey === 'safety' ? 20 : 0));
  return {
    topic: { key: topicKey, label: topicLabel },
    knowledgeGap: (domainQuestion && sourceCount === 0) || uncertaintyHits > 0,
    riskScore,
    riskLevel: riskScore >= 70 ? 'high' : riskScore >= 35 ? 'medium' : 'low',
  };
}

async function recordAudit(input = {}) {
  const classification = classify(input);
  const item = {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    question: trim(input.question),
    answer: trim(input.answer),
    sources: (Array.isArray(input.sources) ? input.sources : []).slice(0, 5).map((source) => ({ title: trim(source.title, 120), category: source.category || '' })),
    traceId: input.traceId ? String(input.traceId) : '',
    userId: input.userId ? String(input.userId) : '',
    route: input.route || 'unknown',
    ...classification,
    createdAt: new Date().toISOString(),
  };
  await store.rpush(AUDIT_KEY, JSON.stringify(item));
  await trimList(AUDIT_KEY, MAX_AUDITS);
  return item;
}

async function getAudits() {
  const values = await store.lrange(AUDIT_KEY, 0, -1);
  return (values || []).map(parse).filter(Boolean).reverse();
}

async function getRiskSummary() {
  const audits = await getAudits();
  const topicMap = new Map();
  for (const item of audits) {
    const key = item.topic?.key || 'general';
    const current = topicMap.get(key) || { key, label: item.topic?.label || '综合咨询', count: 0, gaps: 0 };
    current.count += 1;
    if (item.knowledgeGap) current.gaps += 1;
    topicMap.set(key, current);
  }
  const taskValues = await store.hgetall(TASK_KEY);
  return {
    totalQuestions: audits.length,
    highRiskCount: audits.filter((item) => item.riskLevel === 'high').length,
    knowledgeGapCount: audits.filter((item) => item.knowledgeGap).length,
    topTopics: [...topicMap.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    highRisk: audits.filter((item) => item.riskLevel !== 'low').slice(0, 8),
    tasks: Object.values(taskValues || {}).map(parse).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8),
  };
}

async function createKnowledgeTask({ auditId, title, description, createdBy } = {}) {
  const audit = (await getAudits()).find((item) => item.id === auditId);
  if (!audit) {
    const error = new Error('审核记录不存在');
    error.status = 404;
    throw error;
  }
  const task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    auditId,
    title: trim(title || `补充${audit.topic?.label || '校园服务'}资料`, 120),
    description: trim(description || `补充回答“${audit.question}”所需的权威知识库文档。`, 400),
    topic: audit.topic,
    status: 'todo',
    createdBy: createdBy || 'admin',
    createdAt: new Date().toISOString(),
  };
  await store.hset(TASK_KEY, task.id, task);
  return task;
}

module.exports = { getEvaluations, saveEvaluation, importEvaluation, getEvaluationPayload, updateEvaluationScores, compareEvaluations, recordAudit, getRiskSummary, createKnowledgeTask };
