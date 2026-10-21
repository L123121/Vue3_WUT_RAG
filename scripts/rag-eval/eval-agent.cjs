/**
 * eval-agent.cjs — Agent 链路评测（路由准确率 / 工具选择正确率 / 决策延迟）
 *
 * 用途：AGENT_TOOL_ENABLED 灰度放开的量化依据。
 *
 * 两个阶段：
 *   Phase 1（默认，零成本）：fastRoute 路由准确率——不调用 LLM，离线评估
 *     意图路由层对 24 条标注消息的路由正确率（含兜底 rag）。
 *   Phase 2（--with-llm，需 AI_API_KEY）：端到端能力选择正确率 + 决策延迟——
 *     先执行真实 IntentRouter.route()；rag 路径视为 search_knowledge_base 能力，
 *     仅 agent 路径继续调用 agentService.decide()，避免绕过生产路由制造虚假正确率。
 *
 * 用法：
 *   node eval-agent.cjs                # 仅 Phase 1（免费）
 *   node eval-agent.cjs --with-llm     # Phase 1 + Phase 2（消耗 LLM 配额，24 次调用以内）
 *
 * 数据集：dataset/agent-routing-qa.json
 *   - expectedRoute: chat | agent | rag（fastRoute 未命中时兜底为 chat）
 *   - expectedTool: search_knowledge_base | null（null 表示不强制要求工具选择，
 *     仅 rag 兜底下闲聊类样本，LLM 直接回答或调工具均不算错误，只记录行为）
 */

"use strict";

const path = require("path");
const fs = require("fs");

// 显式加载 backend/.env（backend config 的 dotenv 默认读 cwd，从 scripts 目录运行会读不到）
const { createRequire } = require("module");
const backendRequire = createRequire(path.join(__dirname, "..", "..", "backend", "package.json"));
backendRequire("dotenv").config({ path: path.join(__dirname, "..", "..", "backend", ".env") });

const DATASET_PATH = process.env.AGENT_DATASET_PATH ||
  path.join(__dirname, "dataset", "agent-routing-qa.json");
const WITH_LLM = process.argv.includes("--with-llm");

// 从 backend 加载服务（offline，无需启动服务器/无需 RAG_EVAL_COOKIE）
const BACKEND_SRC = path.join(__dirname, "..", "..", "backend", "src");
const { IntentRouter } = require(path.join(BACKEND_SRC, "services", "agent", "intent-router.service"));

function routeOf(fastRouteResult) {
  return fastRouteResult ? fastRouteResult.route : "chat"; // fastRoute 未命中 → 与生产一致兜底 chat
}

async function phase1(dataset) {
  console.log("=".repeat(60));
  console.log("Phase 1: fastRoute 路由准确率（零成本，不调 LLM）");
  console.log("=".repeat(60));

  const router = new IntentRouter(null);
  let correct = 0;
  const confusion = {}; // `${expected}->${actual}` 计数
  const failures = [];

  for (const item of dataset) {
    const actual = routeOf(router.fastRoute(item.message));
    const ok = actual === item.expectedRoute;
    if (ok) correct++;
    else failures.push({ id: item.id, message: item.message, expected: item.expectedRoute, actual });
    const key = `${item.expectedRoute} -> ${actual}`;
    confusion[key] = (confusion[key] || 0) + 1;
  }

  const acc = ((correct / dataset.length) * 100).toFixed(1);
  console.log(`\n路由准确率: ${correct}/${dataset.length} = ${acc}%`);
  console.log("\n混淆矩阵（expected -> actual : count）:");
  for (const [k, v] of Object.entries(confusion).sort()) {
    console.log(`  ${k} : ${v}`);
  }
  if (failures.length > 0) {
    console.log("\n误路由样本:");
    for (const f of failures) {
      console.log(`  [${f.id}] "${f.message}" 期望=${f.expected} 实际=${f.actual}`);
    }
  }
  return { total: dataset.length, correct, accuracy: parseFloat(acc), failures };
}

async function phase2(dataset) {
  console.log("\n" + "=".repeat(60));
  console.log("Phase 2: 工具选择正确率 + 决策延迟（--with-llm，真实 API）");
  console.log("=".repeat(60));

  // 延迟加载 AgentService（会初始化 rag.service 等重依赖，仅本阶段需要）
  const { AgentService } = require(path.join(BACKEND_SRC, "services", "agent", "agent.service"));
  const agent = new AgentService(null);
  const router = new IntentRouter(null);

  const samples = dataset.filter((d) => d.expectedTool !== undefined);
  let toolCorrect = 0;
  let toolTotal = 0;
  const latencies = [];
  const details = [];

  for (const item of samples) {
    const start = Date.now();
    let decision;
    let routing;
    try {
      routing = await router.route(item.message);
      if (routing.route === "agent") {
        decision = await agent.decide(item.message, []);
      }
    } catch (err) {
      details.push({ id: item.id, message: item.message, expectedRoute: item.expectedRoute, actualRoute: routing?.route || null, expectedTool: item.expectedTool, actualTool: `ERROR: ${err.message}`, ok: false });
      continue;
    }
    const latency = Date.now() - start;
    latencies.push(latency);

    const actualTool = routing.route === "rag"
      ? "search_knowledge_base"
      : decision?.toolCalls?.[0]?.function?.name || null;
    // expectedTool 为 null 的样本（rag 兜底闲聊）：不参与正确率，仅记录行为
    if (item.expectedTool === null) {
      details.push({ id: item.id, message: item.message, expectedRoute: item.expectedRoute, actualRoute: routing.route, expectedTool: null, actualTool, ok: null, latencyMs: latency });
      continue;
    }
    toolTotal++;
    const ok = routing.route === item.expectedRoute && actualTool === item.expectedTool;
    if (ok) toolCorrect++;
    details.push({ id: item.id, message: item.message, expectedRoute: item.expectedRoute, actualRoute: routing.route, expectedTool: item.expectedTool, actualTool, ok, latencyMs: latency });
  }

  const acc = toolTotal > 0 ? ((toolCorrect / toolTotal) * 100).toFixed(1) : "N/A";
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;
  const p95 = latencies.length > 0
    ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]
    : 0;

  console.log(`\n工具选择正确率: ${toolCorrect}/${toolTotal} = ${acc}%`);
  console.log(`决策延迟: avg=${avgLatency}ms, p95=${p95}ms（参考：RAG 链路 SSE 首包 ~130ms）`);
  console.log("\n逐样本明细:");
  for (const d of details) {
    const mark = d.ok === null ? "-" : d.ok ? "OK" : "X ";
    console.log(`  [${mark}] ${d.id} "${d.message}" 路由=${d.expectedRoute}->${d.actualRoute} 能力=${d.expectedTool}->${d.actualTool} ${d.latencyMs ? d.latencyMs + "ms" : ""}`);
  }
  return { toolTotal, toolCorrect, accuracy: acc, avgLatencyMs: avgLatency, p95LatencyMs: p95, details };
}

async function main() {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));
  console.log(`数据集: ${DATASET_PATH}（${dataset.length} 条）\n`);

  const report = { dataset: DATASET_PATH, total: dataset.length, ts: new Date().toISOString() };
  report.phase1 = await phase1(dataset);

  if (WITH_LLM) {
    report.phase2 = await phase2(dataset);
  } else {
    console.log("\n（跳过 Phase 2：加 --with-llm 启用工具选择正确率评测，需 AI_API_KEY）");
  }

  // 结果落盘
  const resultsDir = path.join(__dirname, "results");
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `agent-eval-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n结果已保存: ${outPath}`);
}

main().catch((err) => {
  console.error("评测失败:", err);
  process.exit(1);
});
