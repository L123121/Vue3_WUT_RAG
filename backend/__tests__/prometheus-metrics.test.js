import { describe, it, expect, afterEach } from 'vitest';

const {
  renderPrometheusMetrics,
  formatValue,
  escapeLabelValue,
  LATENCY_BUCKETS_MS,
  METRIC_PREFIX,
} = require('../src/services/prometheus-metrics.service');

const fixtureData = {
  totals: {
    requests: 1200,
    requestErrors: 12,
    llmCalls: 340,
    promptTokens: 56000,
    completionTokens: 8900,
    llmCostCny: 1.2345678,
    ttsCalls: 45,
    ttsCharacters: 30000,
    ttsCostCny: 0.6,
    runs: 800,
    completedRuns: 720,
    failedRuns: 60,
    abortedRuns: 20,
    runToolCalls: 150,
    runFallbacks: 30,
    decisionCalls: 90,
    decisionSuccesses: 80,
    decisionFallbacks: 10,
    decisionTimeouts: 3,
    decisionShadow: 40,
  },
  dailyCostCny: 0.45,
  httpDurations: [10, 60, 120, 300, 700, 1500, 4000, 20000],
  llmLatencies: [800, 2500],
  runDurations: [100, 600, 2800],
  runFirstEventLatencies: [20, 80, 400],
  decisionLatencies: [80, 1200],
  memory: { rss: 1.6e8, heapUsed: 8e7, heapTotal: 1.2e8, external: 5e6 },
  uptimeSeconds: 3600.5,
  eventLoop: { p50Ms: 1.2, p95Ms: 8.9, p99Ms: 15.3, maxMs: 42 },
};

describe('prometheus-metrics.service', () => {
  describe('formatValue', () => {
    it('浮点截到 6 位小数', () => {
      expect(formatValue(1.2345678)).toBe('1.234568');
      expect(formatValue(0.6)).toBe('0.6');
      expect(formatValue(1200)).toBe('1200');
    });
    it('NaN / Infinity 归 0（Prometheus 不接受非有限值）', () => {
      expect(formatValue(NaN)).toBe('0');
      expect(formatValue(Infinity)).toBe('0');
    });
  });

  it('escapeLabelValue 转义引号/反斜杠/换行', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  describe('renderPrometheusMetrics', () => {
    it('计数器族：HELP/TYPE/值齐全', () => {
      const out = renderPrometheusMetrics(fixtureData);
      expect(out).toContain(`# HELP ${METRIC_PREFIX}http_requests_total `);
      expect(out).toContain(`# TYPE ${METRIC_PREFIX}http_requests_total counter`);
      expect(out).toContain(`${METRIC_PREFIX}http_requests_total 1200`);
      expect(out).toContain(`${METRIC_PREFIX}http_request_errors_total 12`);
      expect(out).toContain(`${METRIC_PREFIX}runs_total 800`);
      expect(out).toContain(`${METRIC_PREFIX}runs_completed_total 720`);
      expect(out).toContain(`${METRIC_PREFIX}runs_failed_total 60`);
      expect(out).toContain(`${METRIC_PREFIX}run_tool_calls_total 150`);
      expect(out).toContain(`${METRIC_PREFIX}run_fallbacks_total 30`);
      expect(out).toContain(`${METRIC_PREFIX}decision_calls_total 90`);
      expect(out).toContain(`${METRIC_PREFIX}decision_successes_total 80`);
      expect(out).toContain(`${METRIC_PREFIX}decision_fallbacks_total 10`);
      expect(out).toContain(`${METRIC_PREFIX}decision_timeouts_total 3`);
      expect(out).toContain(`${METRIC_PREFIX}decision_shadow_total 40`);
      expect(out).toContain(`${METRIC_PREFIX}llm_calls_total 340`);
      expect(out).toContain(`${METRIC_PREFIX}llm_tokens_total{type="prompt"} 56000`);
      expect(out).toContain(`${METRIC_PREFIX}llm_tokens_total{type="completion"} 8900`);
      expect(out).toContain(`${METRIC_PREFIX}llm_cost_cny_total 1.234568`);
      expect(out).toContain(`${METRIC_PREFIX}tts_calls_total 45`);
      expect(out).toContain(`${METRIC_PREFIX}daily_cost_cny 0.45`);
      // 计数器名与 TYPE 声明一一对应（families 不重复声明）
      expect(out.match(new RegExp(`# TYPE ${METRIC_PREFIX}llm_tokens_total counter`, 'g'))).toHaveLength(1);
    });

    it('直方图：分桶累计、sum/count、+Inf 收口', () => {
      const out = renderPrometheusMetrics(fixtureData);
      const name = `${METRIC_PREFIX}http_request_duration_ms`;
      expect(out).toContain(`# TYPE ${name} histogram`);
      // 样本 [10,60,120,300,700,1500,4000,20000] 的累计分布
      expect(out).toContain(`${name}_bucket{le="50"} 1`);
      expect(out).toContain(`${name}_bucket{le="100"} 2`);
      expect(out).toContain(`${name}_bucket{le="250"} 3`);
      expect(out).toContain(`${name}_bucket{le="500"} 4`);
      expect(out).toContain(`${name}_bucket{le="1000"} 5`);
      expect(out).toContain(`${name}_bucket{le="2000"} 6`);
      expect(out).toContain(`${name}_bucket{le="3000"} 6`);
      expect(out).toContain(`${name}_bucket{le="5000"} 7`);
      expect(out).toContain(`${name}_bucket{le="10000"} 7`);
      expect(out).toContain(`${name}_bucket{le="30000"} 8`);
      expect(out).toContain(`${name}_bucket{le="+Inf"} 8`);
      expect(out).toContain(`${name}_count 8`);
      expect(out).toContain(`${name}_sum 26690`);
      // LLM 延迟直方图独立成族
      expect(out).toContain(`${METRIC_PREFIX}llm_latency_ms_bucket{le="+Inf"} 2`);
      expect(out).toContain(`${METRIC_PREFIX}run_duration_ms_bucket{le="+Inf"} 3`);
      expect(out).toContain(`${METRIC_PREFIX}run_first_event_ms_bucket{le="+Inf"} 3`);
      expect(out).toContain(`${METRIC_PREFIX}decision_latency_ms_bucket{le="+Inf"} 2`);
    });

    it('样本为空时直方图全 0 且不缺行', () => {
      const out = renderPrometheusMetrics({ ...fixtureData, httpDurations: [], llmLatencies: [] });
      const name = `${METRIC_PREFIX}http_request_duration_ms`;
      for (const le of LATENCY_BUCKETS_MS) {
        expect(out).toContain(`${name}_bucket{le="${le}"} 0`);
      }
      expect(out).toContain(`${name}_bucket{le="+Inf"} 0`);
      expect(out).toContain(`${name}_count 0`);
      expect(out).toContain(`${name}_sum 0`);
    });

    it('进程自观测：内存/uptime gauge，事件循环 summary + max gauge', () => {
      const out = renderPrometheusMetrics(fixtureData);
      expect(out).toContain(`${METRIC_PREFIX}process_uptime_seconds 3600.5`);
      expect(out).toContain(`${METRIC_PREFIX}process_resident_memory_bytes 160000000`);
      expect(out).toContain(`${METRIC_PREFIX}process_heap_used_bytes 80000000`);
      expect(out).toContain(`${METRIC_PREFIX}event_loop_lag_ms{quantile="0.5"} 1.2`);
      expect(out).toContain(`${METRIC_PREFIX}event_loop_lag_ms{quantile="0.99"} 15.3`);
      expect(out).toContain(`${METRIC_PREFIX}event_loop_lag_max_ms 42`);
    });

    it('未开启事件循环监测/内存时缺省跳过该族', () => {
      const out = renderPrometheusMetrics({ totals: fixtureData.totals });
      expect(out).not.toContain('event_loop_lag_ms');
      expect(out).not.toContain('process_uptime_seconds');
      // 核心指标仍在
      expect(out).toContain(`${METRIC_PREFIX}http_requests_total 1200`);
    });
  });

  describe('GET /api/metrics/prometheus 路由门控', () => {
    const config = require('../src/config');
    const { router } = require('../src/routes/metrics.routes');

    afterEach(() => {
      config.metricsPrometheus.enabled = false;
      config.metricsPrometheus.token = '';
    });

    const invoke = (router, { headers = {}, query = {} } = {}) => {
      const req = { method: 'GET', url: '/prometheus', headers, query, get: (name) => headers[String(name).toLowerCase()] };
      const res = {
        statusCode: 0,
        headers: {},
        body: undefined,
        setHeader(k, v) { this.headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; if (!this.statusCode) this.statusCode = 200; return this; },
        send(payload) { this.body = payload; if (!this.statusCode) this.statusCode = 200; return this; },
      };
      router.handle(req, res, () => { if (!res.statusCode) res.statusCode = 404; });
      return res;
    };

    it('默认（未启用）返回 404', () => {
      const res = invoke(router);
      expect(res.statusCode).toBe(404);
    });

    it('启用且未设 token：200 + Prometheus 文本 + 正确 Content-Type', () => {
      config.metricsPrometheus.enabled = true;
      const res = invoke(router);
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toContain('text/plain');
      expect(res.headers['Content-Type']).toContain('version=0.0.4');
      expect(String(res.body)).toContain(`# TYPE ${METRIC_PREFIX}http_requests_total counter`);
    });

    it('启用且设置 token：无凭证 401，Bearer 正确 200，query token 亦可', () => {
      config.metricsPrometheus.enabled = true;
      config.metricsPrometheus.token = 'scrape-secret';

      expect(invoke(router).statusCode).toBe(401);
      expect(invoke(router, { headers: { authorization: 'Bearer wrong' } }).statusCode).toBe(401);
      const ok = invoke(router, { headers: { authorization: 'Bearer scrape-secret' } });
      expect(ok.statusCode).toBe(200);
      const viaQuery = invoke(router, { query: { token: 'scrape-secret' } });
      expect(viaQuery.statusCode).toBe(200);
    });
  });
});
