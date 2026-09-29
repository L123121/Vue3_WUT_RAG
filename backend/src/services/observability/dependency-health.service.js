'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { getEmbeddingHealth } = require('../knowledge/embedding.service');
const { getRerankerHealth } = require('../knowledge/reranker.service');
const { getDatabasePath } = require('../../db/migration-runner');

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
  const hasApi = Boolean(config.ai?.apiKey);
  const llm = options.llm || {
    status: hasApi ? 'ready' : 'degraded',
    configured: hasApi,
    mode: hasApi ? 'online' : 'mock',
    model: config.ai?.model || config.DEFAULT_AI_MODEL,
  };
  const dependencies = { sqlite, qdrant: normalizeVectorHealth(vectorStore), embedding, reranker, llm, uploads };
  const required = [sqlite, dependencies.qdrant, embedding, uploads];
  const unavailable = required.filter((item) => item.status === 'unavailable');
  const starting = required.filter((item) => item.status === 'starting');
  const degraded = required.some((item) => item.status === 'degraded') || llm.status === 'degraded' || reranker.status === 'degraded';
  return {
    status: unavailable.length > 0 ? 'unavailable' : starting.length > 0 ? 'starting' : degraded ? 'degraded' : 'ready',
    ready: unavailable.length === 0 && starting.length === 0,
    timestamp: new Date().toISOString(),
    dependencies,
  };
}

module.exports = {
  UPLOAD_DIR,
  checkSqlite,
  checkDirectory,
  getDependencyHealth,
};
