#!/usr/bin/env node
/**
 * JEV 决策模型联调/巡检脚本。
 *
 *   node scripts/jev-probe.cjs                 # 用内置最小示例探活
 *   node scripts/jev-probe.cjs --prompt "..."  # 自定义 state
 *   node scripts/jev-probe.cjs --models        # 只查模型目录是否上架
 *
 * 退出码：
 *   0 调用成功            2 403 MODEL_ACCESS_DENIED（账号未在灰度名单）
 *   3 未配置 API Key       1 其它错误
 *
 * 说明：CLI 脚本按项目约定直接使用 console 输出（不进 logEvent 结构化日志）。
 */
'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ENDPOINT = process.env.JEV_DECISION_ENDPOINT || 'https://tokenrhythm.studio/v1/decision';
const MODEL = process.env.JEV_DECISION_MODEL || 'NeoHorse-Jev-4B';
const API_KEY = process.env.JEV_API_KEY || process.env.TOKENRHYTHM_API_KEY || process.env.TYPESAFE_API_KEY || '';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

async function listModels() {
  const response = await fetch(`${originOf(ENDPOINT)}/v1/models`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  const models = Array.isArray(body.data) ? body.data : [];
  const hit = models.find((item) => String(item.id).toLowerCase() === MODEL.toLowerCase());
  console.log(`[models] HTTP ${response.status}，目录共 ${models.length} 个模型`);
  console.log(`[models] ${MODEL} ${hit ? '已在目录中' : '未出现在目录中（可能仅灰度可见）'}`);
  if (hit) {
    console.log(`[models] 定价 ${hit.pricing?.unit || '?'} ${hit.pricing?.prompt || '?'} / ${hit.pricing?.completion || '?'} ${hit.pricing?.currency || ''}`);
  }
  return { status: response.status, listed: Boolean(hit) };
}

async function callDecision(state) {
  const body = {
    model: MODEL,
    state,
    questions: {
      stop: {
        type: 'noul',
        instructions: '现在是否应停车？',
      },
    },
  };

  const startedAt = Date.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const latencyMs = Date.now() - startedAt;
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text.slice(0, 500) };
  }

  console.log(`\n[decision] POST ${ENDPOINT}`);
  console.log(`[decision] HTTP ${response.status}  ${latencyMs}ms`);
  console.log(`[decision] model=${payload.model || '(未返回)'}  traceId=${payload.traceId || '-'}`);
  if (payload.answers) console.log(`[decision] answers=${JSON.stringify(payload.answers)}`);
  if (payload.usage) console.log(`[decision] usage=${JSON.stringify(payload.usage)}`);
  if (!payload.answers) console.log(`[decision] body=${JSON.stringify(payload)}`);

  return { status: response.status, payload };
}

(async () => {
  if (!API_KEY) {
    console.error('[error] 未配置 JEV_API_KEY（backend/.env）');
    process.exit(3);
  }

  console.log(`[config] endpoint=${ENDPOINT}`);
  console.log(`[config] model=${MODEL}`);
  console.log(`[config] key=${API_KEY.slice(0, 7)}…${API_KEY.slice(-4)}（len=${API_KEY.length}）`);

  try {
    if (flag('--models')) {
      const result = await listModels();
      process.exit(result.listed ? 0 : 2);
    }

    const catalog = await listModels();
    const state = valueOf('--prompt') || '路口信号灯为红色，前方有行人。';
    const decision = await callDecision(state);

    if (decision.status >= 200 && decision.status < 300) {
      console.log('\n[结果] 模型可用：可以切 JEV_DECISION_MODE=shadow 观察一致性，再切 enforce。');
      process.exit(0);
    }
    if (decision.status === 403 && decision.payload?.code === 'MODEL_ACCESS_DENIED') {
      console.log(`\n[结果] 账号未在灰度名单：${decision.payload.message || ''}`);
      console.log('       Key 有效（能访问 /v1/models），仅缺少该模型权限。');
      console.log(`       目录状态：${catalog.listed ? '已上架' : '未在公开目录（灰度可见）'}`);
      process.exit(2);
    }
    console.log('\n[结果] 调用失败，见上方响应体。');
    process.exit(1);
  } catch (error) {
    console.error(`\n[error] ${error.message}`);
    process.exit(1);
  }
})();
