'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { getEmbeddingHealth } = require('../knowledge/embedding.service');
const { getRerankerHealth } = require('../knowledge/reranker.service');
const { getDatabasePath } = require('../../db/migration-runner');
const { probePostgres, isPostgresEnabled } = require('../../db/postgres.service');
const { getRedisRuntime } = require('../runtime/redis-runtime.service');
const { getObjectStorage } = require('../storage/object-storage.service');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

function checkSqlite(dbPath = getDatabasePath()) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const result = db.prepare('SELECT 1 AS ok').get();
    db.close();
    return result?.ok === 1
      ? { status: 'ready', path: dbPath }
      : { status: 'degraded', reason: 'probe_failed', path: dbPath };
  } catch (error) {
    return { status: 'unavailable', reason: error.code || error.message, path: dbPath };
  }
}

function checkDirectory(directory = UPLOAD_DIR) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    return { status: 'ready', path: directory };
  } catch (error) {
    return { status: 'unavailable', reason: error.code || error.message, path: directory };
  }
}

function normalizeEmbeddingHealth() {
  const health = getEmbeddingHealth();
  return {
    status: health.status === 'degraded' ? 'degraded' : 'ready',
    ...health,
  };
}

function normalizeVectorHealth(vectorStore) {
  if (vectorStore && typeof vectorStore === 'object' && typeof vectorStore.status === 'string') {
    return vectorStore;
  }
  if (!vectorStore || typeof vectorStore.getHealth !== 'function') {
    return { status: 'unavailable', reason: 'vector_store_not_registered' };
  }
  return vectorStore.getHealth();
}

function getDependencyHealth(options = {}) {
  const vectorStore = options.vectorStore || options.qdrant || require('../knowledge/vector-store-qdrant.service').vectorStore;
  const embedding = options.embedding || normalizeEmbeddingHealth();
  const reranker = options.reranker || getRerankerHealth();
  const sqlite = options.sqlite || checkSqlite(options.dbPath);
  const uploads = options.uploads || checkDirectory(options.uploadDir);
  const redis = options.redis || getRedisRuntime().getHealth();
  const storage = options.storage || getObjectStorage().getHealth();
  const hasApi = Boolean(config.ai?.apiKey);
  const llm = options.llm || {
    status: hasApi ? 'ready' : 'degraded',
    configured: hasApi,
    mode: hasApi ? 'online' : 'mock',
    model: config.ai?.model || config.DEFAULT_AI_MODEL,
  };
  const dependencies = { sqlite, qdrant: normalizeVectorHealth(vectorStore), embedding, reranker, llm, uploads, redis, storage };
  const required = [sqlite, dependencies.qdrant, embedding, uploads, storage];
  const unavailable = required.filter((item) => item.status === 'unavailable');
  const starting = required.filter((item) => item.status === 'starting');
  const degraded = required.some((item) => item.status === 'degraded') || llm.status === 'degraded' || reranker.status === 'degraded'
    || (redis.enabled === true && redis.status === 'unavailable');
  return {
    status: unavailable.length > 0 ? 'unavailable' : starting.length > 0 ? 'starting' : degraded ? 'degraded' : 'ready',
    ready: unavailable.length === 0 && starting.length === 0,
    timestamp: new Date().toISOString(),
    dependencies,
  };
}

async function getDependencyHealthAsync(options = {}) {
  const health = getDependencyHealth(options);
  const database = options.database || (isPostgresEnabled() ? await probePostgres() : health.dependencies.sqlite);
  const dependencies = { ...health.dependencies, database };
  const required = [database, dependencies.qdrant, dependencies.embedding, dependencies.uploads, dependencies.storage];
  const unavailable = required.some((item) => item.status === 'unavailable');
  const starting = required.some((item) => item.status === 'starting');
  const degraded = required.some((item) => item.status === 'degraded') || dependencies.llm.status === 'degraded' || dependencies.reranker.status === 'degraded'
    || (dependencies.redis.enabled === true && dependencies.redis.status === 'unavailable');
  return { ...health, status: unavailable ? 'unavailable' : starting ? 'starting' : degraded ? 'degraded' : 'ready', ready: !unavailable && !starting, dependencies };
}

module.exports = {
  UPLOAD_DIR,
  checkSqlite,
  checkDirectory,
  getDependencyHealth,
  getDependencyHealthAsync,
};
