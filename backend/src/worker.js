'use strict';

require('dotenv').config();
const config = require('./config');
const { runMigrations } = require('./db/migration-runner');
const { isPostgresEnabled, runPostgresMigrations, closePostgres } = require('./db/postgres.service');
const { logEvent } = require('./services/observability/observability.service');
const { getRedisRuntime } = require('./services/runtime/redis-runtime.service');
const { getObjectStorage } = require('./services/storage/object-storage.service');
const { registerDefaultJobHandlers } = require('./services/jobs/job-handlers.service');
const { startJobRunner, closeJobStore } = require('./services/jobs/job.service');
const { startUploadsCleanup, stopUploadsCleanup } = require('./services/knowledge/file-upload.service');
const { startRetentionSweeper, stopRetentionSweeper } = require('./services/privacy/retention.service');
const { startSpillCleanup, stopSpillCleanup } = require('./services/conversation/context-compaction.service');

async function startWorker() {
  runMigrations();
  if (isPostgresEnabled()) await runPostgresMigrations();
  registerDefaultJobHandlers();
  void getRedisRuntime().probe();
  void getObjectStorage().probe?.();
  startUploadsCleanup();
  startRetentionSweeper();
  startSpillCleanup();
  startJobRunner();
  logEvent('info', 'worker_started', {
    role: config.runtime?.role || 'worker',
    queueBackend: config.jobs?.queueBackend || 'sqlite',
    redisEnabled: config.redis?.enabled === true,
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent('info', 'worker_shutdown_signal', { signal });
  stopUploadsCleanup();
  stopRetentionSweeper();
  stopSpillCleanup();
  await closeJobStore();
  await closePostgres();
  process.exit(0);
}

if (!process.env.VITEST) {
  startWorker().catch((error) => {
    logEvent('error', 'worker_startup_failed', { error: error.message });
    process.exit(1);
  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('unhandledRejection', (reason) => {
    logEvent('error', 'worker_unhandled_rejection', { detail: reason instanceof Error ? reason.stack || reason.message : String(reason) });
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logEvent('error', 'worker_uncaught_exception', { detail: error.stack || error.message });
    void shutdown('uncaughtException');
  });
}

module.exports = { startWorker };
