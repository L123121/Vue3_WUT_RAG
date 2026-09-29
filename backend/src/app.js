require('dotenv').config();
const express = require('express');
const config = require('./config');
const { runMigrations } = require('./db/migration-runner');

// 所有服务依赖 SQLite 前先完成版本化迁移；失败时阻止进程启动，避免半升级状态接收流量。
runMigrations();

const { operationalMetrics } = require('./services/observability/operational-metrics.service');
const { initTracing, shutdownTracing } = require('./services/observability/otel-tracing.service');
const { getRedisRuntime } = require('./services/runtime/redis-runtime.service');
// 环境变量校验已在 config/index.js 中统一处理，此处不再重复

// OTel traces（OTLP 导出）：OTEL_EXPORTER_OTLP_ENDPOINT 未设置时为 Noop（不加载 SDK）
initTracing();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

/**
 * 反向代理信任：容器部署时请求经 nginx → express，未声明 trust proxy 时
 * req.ip 恒为网关地址，express-rate-limit 会把所有客户端算成同一个 IP——
 * 60 次/分钟的限制要么变成全局限流，要么被伪造 X-Forwarded-For 绕过。
 * 默认只信任一层代理（nginx）；多级代理用 TRUST_PROXY_HOPS 覆盖。
 */
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS, 10);
app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

// 中间件 + 速率限制
const { applyMiddleware } = require('./middleware');
const chatLimiter = applyMiddleware(app);

// 路由注册
const { applyRoutes } = require('./routes/register');
const { logEvent } = require('./services/observability/observability.service');
applyRoutes(app, chatLimiter);

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在',
    path: req.originalUrl,
  });
});

// 错误处理
app.use((err, req, res, _next) => {
  operationalMetrics.recordError(err, { traceId: req.traceId, method: req.method, path: req.path, userId: req.userId || null });
  logEvent('error', 'http_request_error', { error: err.message, stack: err.stack });
  const statusCode = err.statusCode || err.status || 500;
  const message = statusCode >= 500 && err.expose !== true
    ? '服务器内部错误'
    : (err.message || '请求处理失败');
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(err.code ? { code: err.code } : {}),
    ...(statusCode >= 500 ? {} : { details: err.message }),
  });
});

// 启动
const server = app.listen(PORT, '0.0.0.0', async () => {
  const hasApi = !!config.ai.apiKey;
  logEvent('info', 'server_started', {
    url: `http://localhost:${PORT}`,
    aiModel: config.ai.model || config.DEFAULT_AI_MODEL,
    mode: hasApi ? 'online' : 'mock',
    storage: 'SQLite（store.db，WAL）',
    vector: `Qdrant（${config.vectorStore.qdrantUrl}）`,
  });
  void getRedisRuntime().probe();

  // 启动时初始化向量库：注册 documentProvider + 重建索引
  // DocumentService.indexingService 是懒加载，如果没人调用索引方法，
  // registerDocumentProvider 永远不触发，向量为空。这里显式初始化一次，
  // 确保启动后向量库就绪。
  try {
    const { DocumentService } = require('./services/knowledge/document.service');
    const { vectorStore } = require('./services/knowledge/vector-store-qdrant.service');
    const docService = new DocumentService();
    docService.ensureIndexingReady();
    await vectorStore.ensureReady();
    const vectorCount = await vectorStore.count();
    logEvent('info', 'vector_store_init_done', { vectorCount });
  } catch (err) {
    logEvent('warn', 'vector_store_init_failed', { message: '向量库初始化失败（服务进入降级状态）', error: err.message });
  }

  // 上传目录定期清理（聊天上传孤儿文件，7 天过期）
  try {
    const { registerDefaultJobHandlers } = require('./services/jobs/job-handlers.service');
    const { startJobRunner } = require('./services/jobs/job.service');
    registerDefaultJobHandlers();
    if (config.jobs?.schedulerEnabled !== false) {
      const { startUploadsCleanup } = require('./services/knowledge/file-upload.service');
      startUploadsCleanup();
      const { startSpillCleanup } = require('./services/conversation/context-compaction.service');
      startSpillCleanup();
      const { startRetentionSweeper } = require('./services/privacy/retention.service');
      startRetentionSweeper();
    }
    if (config.jobs?.runnerEnabled !== false) startJobRunner();
  } catch (err) {
    logEvent('warn', 'upload_dir_cleanup_start_failed', { message: '上传目录清理任务启动失败', error: err.message });
  }
});

// 优雅关闭：向量数据由 Qdrant 服务端自持久化，这里只需停本进程资源
let isShuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logEvent('info', 'server_shutdown_signal', { signal });
  operationalMetrics.flush();
  try { require('./services/conversation/context-compaction.service').stopSpillCleanup(); } catch { /* 清理器未启动时忽略 */ }
  try { require('./services/privacy/retention.service').stopRetentionSweeper(); } catch { /* 清理器未启动时忽略 */ }
  try { require('./services/knowledge/file-upload.service').stopUploadsCleanup(); } catch { /* 清理器未启动时忽略 */ }
  try { require('./services/jobs/job.service').stopJobRunner(); } catch { /* 任务执行器未启动时忽略 */ }
  try { await require('./services/jobs/job.service').closeJobStore(); } catch { /* 任务数据库未打开时忽略 */ }
  await shutdownTracing();
  server.close(() => {
    operationalMetrics.close();
    logEvent('info', 'http_server_closed', { message: 'HTTP server 已关闭' });
    process.exit(exitCode);
  });
  // 兜底：5s 后强制退出
  setTimeout(() => process.exit(exitCode), 5000).unref();
}

if (!process.env.VITEST) {
  process.on('unhandledRejection', (reason) => {
    logEvent('error', 'unhandled_rejection', { detail: reason instanceof Error ? reason.stack || reason.message : String(reason) });
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logEvent('error', 'uncaught_exception', { stack: err.stack || String(err) });
    void shutdown('uncaughtException', 1);
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
