"use strict";

/**
 * Agentic RAG vs 普通 RAG 对比评测脚本（进程内直跑，不走 HTTP）
 *
 * 对同一批数据集分别调用：
 *   - 普通 RAG：ragService.chat()（检索 → 精排 → 生成，一次成型）
 *   - Agentic RAG：agenticRagService.chat()（多轮检索 + 查询改写 + 证据判断 + 降级）
 * 每道题用 LLM-as-judge（JudgeService）打 faithfulness / answer_relevancy /
 * context_precision / context_recall 四维分，并统计检索命中率、延迟、多轮重检率等。
 *
 * 用法：
 *   node eval-agentic-compare.js                          # 全量默认数据集
 *   node eval-agentic-compare.js --limit 5                # 只跑前 5 题（快速验证）
 *   node eval-agentic-compare.js --dataset hardcases-qa.json
 *   node eval-agentic-compare.js --resume                 # 续跑（跳过已完成题目）
 *
 * 输出：results/eval-agentic-compare-<timestamp>.json + 控制台汇总
 */

const fs = require('fs');
const path = require('path');

// CJS 环境自带 __dirname / __filename 全局变量

// ─── 参数解析 ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};
const LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;       // 0 = 全量
const DATASET_NAME = getArg('--dataset', 'full-coverage-qa.json');
const RESUME = args.includes('--resume');
const REPORT_ONLY = args.includes('--report');                 // 只从快照出报告，不重跑评测
const RESULTS_DIR = path.join(__dirname, 'results');
const DATASET_PATH = path.resolve(__dirname, '../../../scripts/rag-eval/dataset', DATASET_NAME);
const SNAPSHOT_PATH = path.join(RESULTS_DIR, 'agentic-compare-snapshot.json');

// ─── 加载服务 ─────────────────────────────────────────────────
const { RagService } = require('../../src/services/rag/rag.service');
const { AgenticRagService } = require('../../src/services/agent/agentic-rag.service');
const { aiService } = require('../../src/services/llm/ai.service');
const { request } = require('../../src/utils/httpClient');
const config = require('../../src/config');

const ragService = new RagService(aiService);
const MIN_SOURCES = parseInt(process.env.MIN_SOURCES || '1', 10);
const agenticRagService = new AgenticRagService({
  aiService,
  ragService,
  enabled: true,
  minSources: MIN_SOURCES,
});

// ─── LLM-as-judge（自定义：max_tokens 1024，避免推理模型思考链吃光输出预算） ───
function judgeUrl() {
  const base = (config.judge.baseUrl || 'https://api.stepfun.com/v1').replace(/\/+$/, '');
  const hasVersion = /\/v\d+$/.test(base);
  return `${base}${hasVersion ? '' : '/v1'}/chat/completions`;
}

async function judgeOne({ question, answer, context, ground_truth }) {
  if (!answer || !config.judge.apiKey) return null;
  const systemPrompt = `你是一个严格的 RAG 评测员。请评估以下回答的质量，只输出 JSON：
{
  "faithfulness": 0-1,        // 回答是否忠实于上下文，无幻觉
  "answer_relevancy": 0-1,    // 回答是否切题
  "context_precision": 0-1,   // 上下文是否包含回答问题所需信息
  "context_recall": 0-1,      // 上下文是否覆盖了 ground_truth 的关键信息
  "reason": "简短原因，一句话说明扣分点"
}`;
  const userPrompt = `## 问题
${question}

## 上下文（检索到的资料）
${context || '无'}

## 标准答案
${ground_truth || '无'}

## 模型回答
${answer}`;

  const url = new URL(judgeUrl());
  const body = JSON.stringify({
    model: config.judge.model || 'step-3.5-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1024,
    temperature: 0,
  });

  try {
    const res = await request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${config.judge.apiKey}`,
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
      timeout: 20000,
      retries: 2,
    }, body);
    const content = res.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[Judge] 解析失败: ${content.slice(0, 120)}`);
      return null;
    }
    const m = JSON.parse(jsonMatch[0]);
    return {
      faithfulness: Number(m.faithfulness) || 0,
      answer_relevancy: Number(m.answer_relevancy) || 0,
      context_precision: Number(m.context_precision) || 0,
      context_recall: Number(m.context_recall) || 0,
      reason: String(m.reason || '').slice(0, 120),
      model: config.judge.model || 'step-3.5-flash',
    };
  } catch (err) {
    console.warn(`[Judge] API 失败: ${err.message}`);
    return null;
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────
function buildContext(result) {
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  return sources.map((s) => s.snippet || s.content || s.text || '').join('\n');
}

function computeHit(sources, relevantIds) {
  if (!relevantIds || relevantIds.length === 0) return null;
  const retrievedIds = sources.map((s) => s.id || s.docId).filter(Boolean);
  const hits = retrievedIds.filter((id) => relevantIds.includes(id));
  return { hit: hits.length > 0, hitCount: hits.length, retrievedCount: retrievedIds.length };
}

function pick(r, key) {
  if (r == null) return undefined;
  return typeof key === 'function' ? key(r) : r[key];
}
function sum(arr, key) {
  return arr.reduce((s, r) => s + (pick(r, key) || 0), 0);
}
function avg(arr, key) {
  const valid = arr.filter((r) => {
    const v = pick(r, key);
    return v !== undefined && v !== null && typeof v === 'number';
  });
  return valid.length > 0 ? sum(valid, key) / valid.length : 0;
}
function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

// ─── 单题评测 ─────────────────────────────────────────────────
async function runOne(tc) {
  const question = tc.question || '';
  const gt = tc.ground_truth || '';
  const relevantIds = (tc.relevant_doc_ids || []).filter((id) => id && !id.startsWith('TODO'));

  // 1. 普通 RAG
  let plain = { error: null };
  let plainLatency = 0;
  try {
    const t0 = Date.now();
    const r = await ragService.chat(question, [], { enableRag: true, userId: 'eval' });
    plainLatency = Date.now() - t0;
    plain = {
      reply: r.reply || r.answer || '',
      sources: Array.isArray(r.sources) ? r.sources : [],
      context: buildContext(r),
    };
  } catch (e) {
    plain.error = e.message;
  }

  // 2. Agentic RAG
  let agentic = { error: null };
  let agenticLatency = 0;
  try {
    const t0 = Date.now();
    const r = await agenticRagService.chat(question, [], { userId: 'eval', traceId: `eval-${tc.id}` });
    agenticLatency = Date.now() - t0;
    agentic = {
      reply: r.reply || r.answer || '',
      sources: Array.isArray(r.sources) ? r.sources : [],
      context: buildContext(r),
      trace: r.agenticRag || null,
    };
  } catch (e) {
    agentic.error = e.message;
  }

  // 3. LLM-as-judge 打分（各链路独立评测，避免交叉影响）
  const jPlain = plain.reply && !plain.error
    ? await judgeOne({ question, answer: plain.reply, context: plain.context, ground_truth: gt })
    : null;
  const jAgentic = agentic.reply && !agentic.error
    ? await judgeOne({ question, answer: agentic.reply, context: agentic.context, ground_truth: gt })
    : null;

  return {
    id: tc.id,
    question: question.slice(0, 60),
    difficulty: tc.difficulty || null,
    category: tc.category || null,
    plain: {
      ...plain,
      trace: null,
      latencyMs: plainLatency,
      judge: jPlain,
      hit: computeHit(plain.sources, relevantIds),
    },
    agentic: {
      ...agentic,
      latencyMs: agenticLatency,
      judge: jAgentic,
      hit: computeHit(agentic.sources, relevantIds),
    },
  };
}

// ─── 汇总 ─────────────────────────────────────────────────
function summarize(results) {
  const valid = results.filter((r) => !r.plain.error && !r.agentic.error);
  const key = (side) => ['faithfulness', 'answer_relevancy', 'context_precision', 'context_recall'];

  const metrics = (side) => {
    const out = {};
    for (const k of key()) {
      out[k] = avg(valid.map((r) => r[side].judge), k);
    }
    out.overall = (out.faithfulness + out.answer_relevancy + out.context_precision + out.context_recall) / 4;
    return out;
  };

  const hitRate = (side) => {
    const withRelevant = valid.filter((r) => r[side].hit !== null);
    return withRelevant.length > 0
      ? withRelevant.filter((r) => r[side].hit.hit).length / withRelevant.length
      : null;
  };

  // Agentic 特有：多轮重检率 / 查询改写率 / 收尾原因分布 / 降级率
  const agenticTraces = valid.map((r) => r.agentic.trace).filter(Boolean);
  const multiRound = agenticTraces.filter((t) => (t.rounds || 1) > 1).length;
  const rewriteCalls = agenticTraces.reduce(
    (s, t) => s + (t.toolCalls || []).filter((c) => c.name === 'rewrite_knowledge_query').length,
    0
  );
  const finishReasons = {};
  for (const t of agenticTraces) {
    const r = t.finishReason || 'unknown';
    finishReasons[r] = (finishReasons[r] || 0) + 1;
  }

  return {
    sampleCount: results.length,
    validCount: valid.length,
    metrics: {
      plain: metrics('plain'),
      agentic: metrics('agentic'),
    },
    hitRate: {
      plain: hitRate('plain'),
      agentic: hitRate('agentic'),
    },
    avgLatencyMs: {
      plain: Math.round(avg(valid, (r) => 0) || avg(valid.map((r) => r.plain), 'latencyMs')),
      agentic: Math.round(avg(valid.map((r) => r.agentic), 'latencyMs')),
    },
    agentic: {
      avgRounds: agenticTraces.length > 0 ? sum(agenticTraces, (t) => t.rounds || 1) / agenticTraces.length : 0,
      multiRoundRate: agenticTraces.length > 0 ? multiRound / agenticTraces.length : 0,
      rewriteCalls,
      finishReasons,
    },
  };
}

// ─── 打印报告 ─────────────────────────────────────────────────
function printReport(summary, datasetName) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('      Agentic RAG vs 普通 RAG 对比评测报告');
  console.log('══════════════════════════════════════════════════════');
  console.log(`数据集: ${datasetName} | 有效样本: ${summary.validCount}/${summary.sampleCount}`);
  console.log('──────────────────────────────────────────────────────');
  console.log('指标           普通 RAG    Agentic RAG    Δ');
  const m = summary.metrics;
  for (const k of ['faithfulness', 'answer_relevancy', 'context_precision', 'context_recall', 'overall']) {
    const p = m.plain[k] || 0;
    const a = m.agentic[k] || 0;
    const delta = a - p;
    console.log(`  ${k.padEnd(16)} ${pct(p).padStart(8)}   ${pct(a).padStart(10)}   ${(delta >= 0 ? '+' : '')}${pct(delta)}`);
  }
  console.log('──────────────────────────────────────────────────────');
  if (summary.hitRate.plain !== null) {
    console.log(`检索命中率       ${pct(summary.hitRate.plain).padStart(8)}   ${pct(summary.hitRate.agentic).padStart(10)}   ${(summary.hitRate.agentic - summary.hitRate.plain >= 0 ? '+' : '')}${pct(summary.hitRate.agentic - summary.hitRate.plain)}`);
  }
  console.log(`平均延迟         ${`${summary.avgLatencyMs.plain}ms`.padStart(8)}   ${`${summary.avgLatencyMs.agentic}ms`.padStart(10)}   ${summary.avgLatencyMs.agentic - summary.avgLatencyMs.plain >= 0 ? '+' : ''}${summary.avgLatencyMs.agentic - summary.avgLatencyMs.plain}ms`);
  console.log('──────────────────────────────────────────────────────');
  const ag = summary.agentic;
  console.log(`[Agentic 行为] 平均轮次 ${ag.avgRounds.toFixed(2)} | 多轮重检率 ${pct(ag.multiRoundRate)} | 查询改写 ${ag.rewriteCalls} 次 | 收尾原因 ${JSON.stringify(ag.finishReasons)}`);
}

// ─── 主流程 ─────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // ─── 报告模式：直接从快照汇总，不重跑评测 ─────────────────
  if (REPORT_ONLY) {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      console.error(`快照不存在: ${SNAPSHOT_PATH}`);
      process.exit(1);
    }
    const results = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    console.log(`[Report] 从快照加载 ${results.length} 题结果`);
    const summary = summarize(results);
    printReport(summary, DATASET_NAME);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = path.join(RESULTS_DIR, `eval-agentic-compare-${timestamp}.json`);
    fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), dataset: DATASET_NAME, summary, results }, null, 2));
    console.log(`\n[Report] 结果已保存: ${outputPath}`);
    return;
  }

  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  if (!Array.isArray(dataset) || dataset.length === 0) {
    console.error(`数据集为空: ${DATASET_PATH}`);
    process.exit(1);
  }
  const cases = LIMIT > 0 ? dataset.slice(0, LIMIT) : dataset;
  console.log(`[Eval] 数据集: ${DATASET_NAME} (${cases.length}/${dataset.length} 题), judge=${config.judge.model || '(fallback)'}`);

  // 续跑支持
  const done = new Map();
  if (RESUME && fs.existsSync(SNAPSHOT_PATH)) {
    for (const r of JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))) {
      done.set(r.id, r);
    }
    console.log(`[Eval] 续跑模式：已跳过 ${done.size} 题`);
  }

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    if (done.has(tc.id)) {
      results.push(done.get(tc.id));
      continue;
    }

    process.stdout.write(`[Eval #${i + 1}/${cases.length}] ${tc.id} ${(tc.question || '').slice(0, 30)}... `);
    const startAll = Date.now();
    const r = await runOne(tc);
    const ms = Date.now() - startAll;

    results.push(r);
    // 增量快照（每完成一题即存，防中断丢进度；续跑时按 id 去重跳过）
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(results, null, 2));
    console.log(`(${ms}ms) plain_f=${(r.plain.judge?.faithfulness ?? 0).toFixed(2)} agentic_f=${(r.agentic.judge?.faithfulness ?? 0).toFixed(2)} rounds=${r.agentic.trace?.rounds ?? 0}`);
  }
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(results, null, 2));

  const summary = summarize(results);

  // ─── 打印汇总 ──────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('      Agentic RAG vs 普通 RAG 对比评测报告');
  console.log('══════════════════════════════════════════════════════');
  console.log(`数据集: ${DATASET_NAME} | 有效样本: ${summary.validCount}/${summary.sampleCount}`);
  console.log('──────────────────────────────────────────────────────');
  console.log('指标           普通 RAG    Agentic RAG    Δ');
  const m = summary.metrics;
  for (const k of ['faithfulness', 'answer_relevancy', 'context_precision', 'context_recall', 'overall']) {
    const p = m.plain[k] || 0;
    const a = m.agentic[k] || 0;
    const delta = a - p;
    console.log(`  ${k.padEnd(16)} ${pct(p).padStart(8)}   ${pct(a).padStart(10)}   ${(delta >= 0 ? '+' : '')}${pct(delta)}`);
  }
  console.log('──────────────────────────────────────────────────────');
  if (summary.hitRate.plain !== null) {
    console.log(`检索命中率       ${pct(summary.hitRate.plain).padStart(8)}   ${pct(summary.hitRate.agentic).padStart(10)}   ${(summary.hitRate.agentic - summary.hitRate.plain >= 0 ? '+' : '')}${pct(summary.hitRate.agentic - summary.hitRate.plain)}`);
  }
  console.log(`平均延迟         ${`${summary.avgLatencyMs.plain}ms`.padStart(8)}   ${`${summary.avgLatencyMs.agentic}ms`.padStart(10)}   ${summary.avgLatencyMs.agentic - summary.avgLatencyMs.plain >= 0 ? '+' : ''}${summary.avgLatencyMs.agentic - summary.avgLatencyMs.plain}ms`);
  console.log('──────────────────────────────────────────────────────');
  const ag = summary.agentic;
  console.log(`[Agentic 行为] 平均轮次 ${ag.avgRounds.toFixed(2)} | 多轮重检率 ${pct(ag.multiRoundRate)} | 查询改写 ${ag.rewriteCalls} 次 | 收尾原因 ${JSON.stringify(ag.finishReasons)}`);

  // ─── 保存结果 ──────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = path.join(RESULTS_DIR, `eval-agentic-compare-${timestamp}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ timestamp: new Date().toISOString(), dataset: DATASET_NAME, summary, results }, null, 2));
  console.log(`\n[Eval] 结果已保存: ${outputPath}`);
}

main().catch((err) => {
  console.error('[Eval] 运行失败:', err);
  process.exit(1);
});
