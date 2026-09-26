import { describe, it, expect, afterEach } from 'vitest';

const config = require('../src/config');
const otel = require('../src/services/observability/otel-tracing.service');

describe('otel-tracing.service', () => {
  afterEach(async () => {
    await otel.shutdownTracing();
    config.otel.enabled = false;
  });

  describe('关闭态（默认）：零 SDK，helper 全部 Noop', () => {
    it('initTracing 不启用时返回 null', () => {
      expect(config.otel.enabled).toBe(false);
      expect(otel.initTracing()).toBeNull();
      expect(otel.isEnabled()).toBe(false);
    });

    it('withActiveSpan 直通执行并返回结果', async () => {
      const result = await otel.withActiveSpan('test.span', {}, async () => 42);
      expect(result).toBe(42);
    });

    it('withActiveSpan 透传异常', async () => {
      await expect(otel.withActiveSpan('test.span', {}, async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
    });

    it('withHttpRootSpan 关闭时 fn(null) 直通', () => {
      let seen = 'unset';
      otel.withHttpRootSpan({ method: 'GET', url: '/x' }, { on() {} }, (info) => { seen = info; });
      expect(seen).toBeNull();
    });

    it('阶段/LLM span 助手在关闭态不抛错', () => {
      expect(() => otel.recordStageSpan({ name: 'retrieve', durationMs: 12, success: true })).not.toThrow();
      expect(otel.startLlmSpan({ model: 'm' })).toBeNull();
      expect(() => otel.setLlmUsage(null, { prompt_tokens: 1 })).not.toThrow();
      expect(() => otel.endLlmSpan(null)).not.toThrow();
    });
  });

  describe('scalarAttributes', () => {
    it('标量透传、对象 JSON 截断 300、null/undefined 跳过', () => {
      const out = otel.scalarAttributes({
        a: 'x',
        b: 1.5,
        c: true,
        d: null,
        e: undefined,
        f: { nested: true },
        g: ['p', 'q'],
      });
      expect(out).toEqual({ a: 'x', b: 1.5, c: true, f: '{"nested":true}', g: ['p', 'q'] });
    });
  });

  describe('启用态（真实 SDK + InMemory exporter）', () => {
    // 单测试覆盖全部 span 场景：NodeSDK 全局 provider 每进程只能注册一次，
    // 二次 initTracing 的 span 会落在已 shutdown 的旧 provider 上
    it('根 span + RAG 阶段子 span + 错误 span：同 traceId、属性齐全、导出可读', async () => {
      const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
      const exporter = new InMemorySpanExporter();
      config.otel.enabled = true;
      // SimpleSpanProcessor 端到端直通（traceExporter 走 BSP 批量，断言时序不可控）
      otel.initTracing({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      expect(otel.isEnabled()).toBe(true);

      const resMock = {
        statusCode: 200,
        finishHandler: null,
        on(event, cb) { if (event === 'finish') this.finishHandler = cb; },
      };
      const reqMock = { method: 'POST', path: '/api/chat', url: '/api/chat', get: () => 'vitest-agent' };

      let fnInfo = null;
      otel.withHttpRootSpan(reqMock, resMock, (info) => {
        fnInfo = info;
        // 请求链内记录 RAG 阶段 → 应成为 HTTP 根 span 的子 span（同 traceId）
        otel.recordStageSpan({
          name: 'retrieve',
          durationMs: 45,
          success: true,
          attributes: { candidates: 10 },
          traceId: 'rag-local-id',
        });
      });
      resMock.finishHandler(); // 请求结束 → 根 span 收口

      await expect(otel.withActiveSpan('failing.op', {}, async () => {
        throw new Error('llm down');
      })).rejects.toThrow('llm down');

      expect(fnInfo).not.toBeNull();
      expect(fnInfo.otelTraceId).toMatch(/^[0-9a-f]{32}$/);

      // Windows 上 resource 异步属性解析需 ~50-100ms，轮询等待导出完成再断言
      const deadline = Date.now() + 3000;
      while (exporter.getFinishedSpans().length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // 先取出快照再 shutdown：InMemorySpanExporter.shutdown() 会清空缓冲区
      const spans = exporter.getFinishedSpans();
      await otel.shutdownTracing();
      expect(otel.isEnabled()).toBe(false);

      const names = spans.map((s) => s.name);
      expect(names.some((n) => n.startsWith('HTTP POST /api/chat'))).toBe(true);
      expect(names).toContain('rag.stage retrieve');
      expect(names).toContain('failing.op');

      const root = spans.find((s) => s.name.startsWith('HTTP POST'));
      const stage = spans.find((s) => s.name === 'rag.stage retrieve');
      expect(stage.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(root.attributes['http.response.status_code']).toBe(200);
      expect(stage.attributes['rag.stage.name']).toBe('retrieve');
      expect(stage.attributes.candidates).toBe(10);
      expect(stage.attributes['app.trace_id']).toBe('rag-local-id');
      // 结束时间与显式时长一致（±10ms 精度）
      const stageMs = (Number(stage.endTime[0]) * 1000 + Number(stage.endTime[1]) / 1e6)
        - (Number(stage.startTime[0]) * 1000 + Number(stage.startTime[1]) / 1e6);
      expect(stageMs).toBeGreaterThanOrEqual(40);
      expect(stageMs).toBeLessThan(60);

      const failed = spans.find((s) => s.name === 'failing.op');
      expect(failed.status.code).toBe(2); // SpanStatusCode.ERROR
      expect(failed.events.some((e) => e.name === 'exception')).toBe(true);
    });
  });
});
