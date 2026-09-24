/**
 * 指标路由 — Prometheus 抓取（env 门控）、Web Vitals 上报（匿名可写）与管理员指标查询
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth.middleware');
const { operationalMetrics } = require('../services/operational-metrics.service');
const { metrics } = require('../services/metrics.service');
const { getFeedbackSummary } = require('../controllers/rag.controller');
const {
  getEvaluations,
  compareEvaluations,
  getRiskSummary,
  createKnowledgeTask,
} = require('../services/quality-governance.service');
const { readRunEvents } = require('../services/run-event-log.service');
const config = require('../config');
const {
  renderPrometheusMetrics,
  collectPrometheusSnapshot,
  ensureEventLoopMonitor,
} = require('../services/prometheus-metrics.service');
const { logEvent } = require('../services/observability.service');

const router = express.Router();

// ===== Prometheus 抓取端点（env 门控，默认 404；配置在请求时读取，便于测试与热感知）=====
if (config.metricsPrometheus?.enabled === true) {
  ensureEventLoopMonitor();
  if (!config.metricsPrometheus?.token) {
    logEvent('warn', 'metrics_prometheus_token_missing', { message: 'METRICS_PROMETHEUS_ENABLED=true 且未设置 METRICS_PROMETHEUS_TOKEN：/api/metrics/prometheus 将匿名可读（含模型成本数据），公网部署请设置 token' });
  }
}

// GET /api/metrics/prometheus — Prometheus 文本格式（Bearer token 或 ?token= 校验）
router.get('/prometheus', (req, res) => {
  const prometheusConfig = config.metricsPrometheus || {};
  if (!prometheusConfig.enabled) {
    return res.status(404).json({ success: false, error: 'Not Found' });
  }
  const token = prometheusConfig.token || '';
  if (token) {
    const provided = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')
      || String(req.query.token || '');
    if (provided !== token) {
      return res.status(401).json({ success: false, error: '无效的抓取凭证' });
    }
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderPrometheusMetrics(collectPrometheusSnapshot()));
});

// 内存存储（轻量，重启清空）
const webVitalsStore = [];
const clientPerformanceStore = [];
const MAX_WEB_VITALS = 1000;
const MAX_CLIENT_PERFORMANCE = 1000;
const CLIENT_METRIC_NAMES = new Set(['markdown_worker']);

// POST /api/metrics/web-vitals — 前端上报
router.post('/web-vitals', (req, res) => {
  const metric = req.body;
  if (!metric || !metric.name || metric.value === undefined) {
    return res.status(400).json({ success: false, error: '无效的指标数据' });
  }

  metric.serverTimestamp = new Date().toISOString();
  webVitalsStore.push(metric);
  if (webVitalsStore.length > MAX_WEB_VITALS) {
    webVitalsStore.splice(0, webVitalsStore.length - MAX_WEB_VITALS);
  }

  res.json({ success: true });
});

router.post('/client-performance', requireAuth, (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  if (!CLIENT_METRIC_NAMES.has(String(payload.name || ''))) {
    return res.status(400).json({ success: false, error: '不支持的客户端指标' });
  }
  const numeric = (value, fallback = 0, max = 1_000_000) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, max)) : fallback;
  };
  const metric = {
    name: payload.name,
    submitted: numeric(payload.submitted, 0, 1_000_000),
    completed: numeric(payload.completed, 0, 1_000_000),
    failed: numeric(payload.failed, 0, 1_000_000),
    timedOut: numeric(payload.timedOut, 0, 1_000_000),
    staleResults: numeric(payload.staleResults, 0, 1_000_000),
    queueDepth: numeric(payload.queueDepth, 0, 10_000),
    queued: numeric(payload.queued, 0, 10_000),
    inFlight: numeric(payload.inFlight, 0, 10_000),
    p50Ms: numeric(payload.duration?.p50Ms, 0, 60_000),
    p95Ms: numeric(payload.duration?.p95Ms, 0, 60_000),
    sampleCount: numeric(payload.duration?.sampleCount, 0, 10_000),
    contentChars: numeric(payload.contentChars, 0, 10_000_000),
    serverTimestamp: new Date().toISOString(),
  };
  clientPerformanceStore.push(metric);
  if (clientPerformanceStore.length > MAX_CLIENT_PERFORMANCE) {
    clientPerformanceStore.splice(0, clientPerformanceStore.length - MAX_CLIENT_PERFORMANCE);
  }
  res.json({ success: true });
});

router.get('/runs/:runId/events', requireAuth, async (req, res, next) => {
  if (req.role !== 'admin') return res.status(403).json({ success: false, error: '需要管理员权限' });
  try {
    const events = await readRunEvents(req.params.runId);
    res.json({ success: true, data: { runId: req.params.runId, events } });
  } catch (error) {
    next(error);
  }
});

router.get('/dashboard', requireAuth, async (req, res, next) => {
  if (req.role !== 'admin') return res.status(403).json({ success: false, error: '需要管理员权限' });
  try {
    const feedback = await getFeedbackSummary();
    const quality = metrics.getSummary();
    const evaluationHistory = await getEvaluations();
    const riskAudit = await getRiskSummary();
    res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        quality,
        operations: operationalMetrics.snapshot(),
        clientPerformance: clientPerformanceStore.slice(-100),
        satisfaction: feedback,
        evaluationHistory: compareEvaluations(evaluationHistory),
        riskAudit,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/risk-audit/tasks', requireAuth, async (req, res, next) => {
  if (req.role !== 'admin') return res.status(403).json({ success: false, error: '需要管理员权限' });
  try {
    const task = await createKnowledgeTask({
      ...req.body,
      createdBy: req.userId || 'admin',
    });
    res.json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
});

module.exports = { router };
