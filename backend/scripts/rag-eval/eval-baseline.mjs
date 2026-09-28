"use strict";

/**
 * RAG 检索回归基线
 *
 * 读取 full-coverage-qa.json 测试集，调用本地后端 API 逐题检索，
 * 输出 Recall@K / MRR / nDCG@K / HitRate 指标，并保存结果到 results/ 目录。
 *
 * 用法：
 *   node eval-baseline.mjs                          # 使用默认数据集
 *   DATASET_PATH=dataset/campus-qa.json node eval-baseline.mjs  # 指定数据集
 *   RESULTS_DIR=results/2026-08-20 node eval-baseline.mjs       # 指定输出目录
 *
 * 输出：
 *   results/eval-baseline-<timestamp>.json  — 逐题结果 + 汇总指标
 *   控制台打印汇总指标表格
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 配置 ─────────────────────────────────────────────────────

const API_BASE = process.env.EVAL_API_BASE || 'http://localhost:3000';
const AUTH_TOKEN = process.env.EVAL_AUTH_TOKEN || '';
const DEFAULT_DATASET_PATH = resolve(__dirname, '../../../scripts/rag-eval/dataset/full-coverage-qa.json');
const DATASET_PATH = process.env.DATASET_PATH
  ? resolve(__dirname, process.env.DATASET_PATH)
  : DEFAULT_DATASET_PATH;
const RESULTS_DIR = resolve(__dirname, process.env.RESULTS_DIR || 'results');
const EVAL_KS = [1, 3, 5];

// ─── 工具函数 ──────────────────────────────────────────────────

function computeDcg(retrievedIds, relevantSet, k) {
  return retrievedIds.slice(0, k).reduce((score, docId, index) => {
    return relevantSet.has(docId) ? score + 1 / Math.log2(index + 2) : score;
  }, 0);
}

function computeNdcgAtK(retrievedIds, relevantIds, k) {
  const relevantSet = new Set(relevantIds);
  if (relevantSet.size === 0) return 0;
  const idealHits = Math.min(relevantSet.size, k);
  const ideal = Array.from({ length: idealHits }).reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
  return ideal > 0 ? computeDcg(retrievedIds, relevantSet, k) / ideal : 0;
}

function computeQueryMetrics(rawRetrievedIds, relevantIds) {
  const relevantSet = new Set(relevantIds.filter(id => id && !id.startsWith('TODO')));
  if (relevantSet.size === 0) return null;

  const retrievedIds = [...new Set(rawRetrievedIds)];
  const hits = retrievedIds.filter(id => relevantSet.has(id));
  const recall = hits.length / relevantSet.size;
  const precision = retrievedIds.length > 0 ? hits.length / retrievedIds.length : 0;
  const firstHitIdx = retrievedIds.findIndex(id => relevantSet.has(id));
  const reciprocalRank = firstHitIdx >= 0 ? 1 / (firstHitIdx + 1) : 0;

  const ndcg = {};
  for (const k of EVAL_KS) {
    ndcg[`ndcg@${k}`] = computeNdcgAtK(retrievedIds, relevantIds, k);
  }

  return { recall, precision, reciprocalRank, hitRate: hits.length > 0 ? 1 : 0, ndcg, hitCount: hits.length };
}

// ─── API 调用 ──────────────────────────────────────────────────

async function checkBackend() {
  const url = `${API_BASE}/api/health`;
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers['Cookie'] = `auth_token=${AUTH_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`后端健康检查失败: ${res.status} ${res.statusText}`);
  const data = await res.json();
  console.log(`[Baseline] 后端状态: ${JSON.stringify(data.status || data)}`);
}

async function ragQuery(message) {
  const url = `${API_BASE}/api/rag/chat/stream`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (AUTH_TOKEN) headers['Cookie'] = `auth_token=${AUTH_TOKEN}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, history: [], stream: false }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`查询失败 [${res.status}]: ${text.slice(0, 200)}`);
  }

  const sources = [];
  let error = null;

  for await (const line of res.body) {
    const text = Buffer.from(line).toString('utf8').trim();
    if (!text.startsWith('data:')) continue;
    const payload = text.slice(5).trim();
    if (payload === '[DONE]') break;

    try {
      const evt = JSON.parse(payload);
      // SSE 线上格式不带 type 字段（控制器按 chunk.type 路由后只写数据字段），
      // 必须按形状匹配：此前按 evt.type 匹配永远落空，sources 恒为空、指标恒为 0
      if (Array.isArray(evt.sources)) {
        sources.push(...evt.sources);
      } else if (evt.error) {
        error = typeof evt.error === 'string' ? evt.error : (evt.error.message || evt.content);
      }
    } catch {
      // skip non-JSON lines
    }
  }

  if (error) throw new Error(error);
  return sources;
}

// ─── 主流程 ────────────────────────────────────────────────────

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  // 检查后端
  await checkBackend();

  // 加载数据集
  const dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
  if (!Array.isArray(dataset) || dataset.length === 0) {
    console.error(`[Baseline] 数据集为空或格式错误: ${DATASET_PATH}`);
    process.exit(1);
  }
  console.log(`[Baseline] 加载数据集: ${dataset.length} 题 (${DATASET_PATH})`);

  // 逐题评测
  const results = [];
  for (const item of dataset) {
    const question = item.question || item.user_input || item.query || '';
    const relevantIds = (item.relevant_doc_ids || item.relevantDocIds || []).filter(
      id => id && !id.startsWith('TODO')
    );

    if (!question) {
      console.warn(`[Baseline] 跳过空问题: ${item.id}`);
      results.push({ id: item.id, question, skip: true, reason: 'empty_question' });
      continue;
    }

    const startTime = Date.now();
    let sources = [];
    let error = null;
    let latencyMs = 0;

    try {
      sources = await ragQuery(question);
      latencyMs = Date.now() - startTime;
    } catch (err) {
      error = err.message;
      latencyMs = Date.now() - startTime;
    }

    const retrievedIds = sources.map(s => s.id || s.docId).filter(Boolean);
    const metrics = relevantIds.length > 0 && !error
      ? computeQueryMetrics(retrievedIds, relevantIds)
      : null;

    const result = {
      id: item.id,
      question: question.slice(0, 80),
      category: item.category || null,
      difficulty: item.difficulty || null,
      relevantIds,
      retrievedIds: retrievedIds.slice(0, 10),
      retrievedCount: retrievedIds.length,
      hitCount: metrics?.hitCount || 0,
      latencyMs,
      error,
      metrics,
    };

    results.push(result);

    // 进度指示
    const hit = metrics?.hitRate ? 'HIT' : 'MISS';
    const latency = `${latencyMs}ms`;
    process.stdout.write(`\r[Baseline] ${results.length}/${dataset.length} ${hit} ${latency}  `);
  }

  console.log(`\n[Baseline] 评测完成`);

  // ─── 汇总指标 ──────────────────────────────────────────────

  const validResults = results.filter(r => r.metrics && !r.error);
  const totalRelevant = new Set(results.flatMap(r => r.relevantIds)).size;

  const aggregate = {};
  for (const k of EVAL_KS) {
    aggregate[`recall@${k}`] = 0;
    aggregate[`precision@${k}`] = 0;
  }
  aggregate.mrr = 0;
  aggregate.hitRate = 0;
  aggregate.ndcg = { '1': 0, '3': 0, '5': 0 };
  aggregate.avgLatencyMs = 0;
  aggregate.errorCount = results.filter(r => r.error).length;

  if (validResults.length > 0) {
    for (const r of validResults) {
      aggregate.mrr += r.metrics.reciprocalRank;
      aggregate.hitRate += r.metrics.hitRate;
      for (const k of EVAL_KS) {
        const topK = r.retrievedIds.slice(0, k);
        const hits = topK.filter(id => r.relevantIds.includes(id)).length;
        aggregate[`recall@${k}`] += hits / r.relevantIds.length;
        aggregate[`precision@${k}`] += topK.length > 0 ? hits / topK.length : 0;
        aggregate.ndcg[k] += r.metrics.ndcg[`ndcg@${k}`] || 0;
      }
      aggregate.avgLatencyMs += r.latencyMs;
    }
    const n = validResults.length;
    aggregate.mrr /= n;
    aggregate.hitRate /= n;
    for (const k of EVAL_KS) {
      aggregate[`recall@${k}`] /= n;
      aggregate[`precision@${k}`] /= n;
      aggregate.ndcg[k] /= n;
    }
    aggregate.avgLatencyMs /= n;
  }

  // 打印表格
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║              RAG 检索回归基线报告                     ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  数据集:          ${DATASET_PATH.split('/').pop().padEnd(28)} ║`);
  console.log(`║  题目数:          ${String(validResults.length).padEnd(28)} ║`);
  console.log(`║  平均延迟:        ${`${Math.round(aggregate.avgLatencyMs)}ms`.padEnd(28)} ║`);
  console.log(`║  错误数:          ${String(aggregate.errorCount).padEnd(28)} ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  for (const k of EVAL_KS) {
    console.log(`║  Recall@${k}:       ${(aggregate[`recall@${k}`] * 100).toFixed(1).padStart(5)}%    Precision@${k}: ${(aggregate[`precision@${k}`] * 100).toFixed(1).padStart(5)}%  ║`);
  }
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  MRR:             ${aggregate.mrr.toFixed(4).padEnd(28)} ║`);
  console.log(`║  HitRate:         ${(aggregate.hitRate * 100).toFixed(1).padStart(5)}%${''.padEnd(23)} ║`);
  for (const k of EVAL_KS) {
    console.log(`║  nDCG@${k}:         ${aggregate.ndcg[k].toFixed(4).padEnd(28)} ║`);
  }
  console.log('╚══════════════════════════════════════════════════════╝');

  // ─── 保存结果 ──────────────────────────────────────────────

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = resolve(RESULTS_DIR, `eval-baseline-${timestamp}.json`);
  writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    dataset: DATASET_PATH,
    apiBase: API_BASE,
    aggregate,
    results,
  }, null, 2));

  console.log(`\n[Baseline] 结果已保存: ${outputPath}`);

  // ─── 退出码门禁 ────────────────────────────────────────────
  // Recall@5 是默认硬门禁；p95 延迟门禁通过 EVAL_MAX_P95_MS 显式开启
  // （未设置不拦截，避免首次接入或环境抖动直接卡死部署）。
  const failures = [];
  const minRecall5 = Number.parseFloat(process.env.EVAL_MIN_RECALL5);
  const recallThreshold = Number.isFinite(minRecall5) ? minRecall5 : 0.80;
  if (aggregate[`recall@5`] < recallThreshold) {
    failures.push(`Recall@5 = ${(aggregate[`recall@5`] * 100).toFixed(1)}% < 阈值 ${(recallThreshold * 100).toFixed(1)}%`);
  }

  const latencies = validResults.map((r) => r.latencyMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : 0;
  const maxP95 = Number.parseFloat(process.env.EVAL_MAX_P95_MS);
  if (Number.isFinite(maxP95) && maxP95 > 0 && p95 > maxP95) {
    failures.push(`p95 延迟 = ${Math.round(p95)}ms > 阈值 ${maxP95}ms`);
  }

  console.log(`[Baseline] 门禁: Recall@5 阈值 ${(recallThreshold * 100).toFixed(1)}%` +
    (Number.isFinite(maxP95) && maxP95 > 0 ? `，p95 阈值 ${maxP95}ms（实测 ${Math.round(p95)}ms）` : '，p95 门禁未启用'));

  if (failures.length > 0) {
    for (const line of failures) console.warn(`\n[Baseline] 门禁未通过: ${line}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[Baseline] 运行失败:', err.message);
  process.exit(1);
});
