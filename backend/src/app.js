require('dotenv').config();
const express = require('express');
const config = require('./config');
const { operationalMetrics } = require('./services/operational-metrics.service');
const { initTracing, shutdownTracing } = require('./services/otel-tracing.service');
// 环境变量校验已在 config/index.js 中统一处理，此处不再重复

// OTel traces（OTLP 导出）：OTEL_EXPORTER_OTLP_ENDPOINT 未设置时为 Noop（不加载 SDK）
initTracing();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// 中间件 + 速率限制
const { applyMiddleware } = require('./middleware');
const chatLimiter = applyMiddleware(app);

// 路由注册
const { applyRoutes } = require('./routes/register');
const { logEvent } = require('./services/observability.service');
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
    aiModel: config.ai.model || 'step-3.7-flash',
    mode: hasApi ? 'online' : 'mock',
    storage: 'SQLite（store.db，WAL）',
    vector: '本地文件持久化（精确检索）',
  });

  // 启动时初始化向量库：注册 documentProvider + 重建索引
  // 修复延迟初始化 bug：DocumentService.indexingService 是懒加载，
  // 如果没人调用索引方法，registerDocumentProvider 永远不触发，向量为空。
  // 这里主动触发一次，确保启动后向量库就绪。
  try {
    const { DocumentService } = require('./services/document.service');
    const { vectorStore } = require('./services/vector-store-qdrant.service');
    const docService = new DocumentService();
    // 触发 indexingService getter → 注册 provider
    // 然后 ensureReady 会从文档库重建向量
    docService.indexingService; // 触发 provider 注册
    await vectorStore.ensureReady();
    const vectorCount = await vectorStore.count();
    logEvent('info', 'vector_store_init_done', { vectorCount });
  } catch (err) {
    logEvent('warn', 'vector_store_init_failed', { message: '向量库初始化失败（不影响启动）', error: err.message });
  }

  // 上传目录定期清理（聊天上传孤儿文件，7 天过期）
  try {
    const { startUploadsCleanup } = require('./services/file-upload.service');
    startUploadsCleanup();
  } catch (err) {
    logEvent('warn', 'upload_dir_cleanup_start_failed', { message: '上传目录清理任务启动失败', error: err.message });
  }
});

// 优雅关闭：先停向量库保存，再关 server
let isShuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logEvent('info', 'server_shutdown_signal', { signal });
  try {
    const { vectorStore } = require('./services/vector-store-qdrant.service');
    vectorStore.flush();
  } catch (error) {
    logEvent('warn', 'vector_store_persist_failed', { message: '向量数据落盘失败', error: error.message });
  }
  operationalMetrics.flush();
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
