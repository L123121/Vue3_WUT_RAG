# JEV 结构化决策模型接入

> 模型：`NeoHorse-Jev-4B`（结构化决策模型，不是聊天模型）
> 端点：`POST https://tokenrhythm.studio/v1/decision`（推荐）/ `POST https://tokenrhythm.studio/v1/systemone`（兼容格式，请求体一致）
> 鉴权：`Authorization: Bearer <平台 API Key>`，非流式 JSON
> 接入日期：2026-10-27

## 1. 项目里的三个接入面

| 接入面 | 位置 | 作用 |
| --- | --- | --- |
| 意图路由（内部） | `backend/src/services/agent/jev-decision.service.js` → `decideRoute()`，由 `ConversationOrchestrator.routeIntent` 调用 | 用决策模型在 `chat` / `rag` / `agent` 三条链路之间选择，替代纯关键词基线 |
| HTTP 直连 | `POST /api/decision`、`GET /api/decision/status`（`backend/src/routes/decision.routes.js`） | 业务侧自定义 `state` + `questions` 的结构化决策，和官方 `/v1/decision` 一一对应 |
| 可观测 | `GET /api/health` 的 `decision_model` 字段、`node backend/scripts/jev-probe.cjs` | 不放量/放量状态、冷却剩余时间、最近失败原因；密钥永远不出现在响应里 |

## 2. 协议要点（实测，2026-10-27）

请求体（两个端点一致）：

```json
{
  "model": "NeoHorse-Jev-4B",
  "state": "路口信号灯为红色，前方有行人。",
  "questions": {
    "stop": { "type": "noul", "instructions": "现在是否应停车？" }
  }
}
```

`state` 可以是字符串，也可以是结构化 JSON。`questions` 的键由调用方定义，读取答案时按同一 ID 查找。

### noul（成立概率）

```json
{
  "model": "NeoHorse-Jev-4B",
  "answers": {
    "stop": {
      "type": "noul",
      "noul": 0.9895584583282471,
      "probabilities": { "false": 0.0104, "true": 0.9896 }
    }
  },
  "input_tokens": 20,
  "input_details": { "input_tokens": 20, "expanded_tokens": 26, "question_count": 1 },
  "decision_seconds": 0.058,
  "probability_source": "pointer_head"
}
```

- 概率字段实测为 `noul`（不是 `probability`）；解析器同时兼容 `probability` / `prob` / `p` / `score` / `value` / `likelihood` / `confidence` 以及 `probabilities.true` 回退。
- `noul` 返回 0~1，业务上的"是/否"阈值由调用方决定；本项目直连接口原样返回，不做阈值化。

### choice（单选）

```json
{
  "answers": {
    "route": {
      "type": "choice",
      "choice": "rag",
      "probabilities": { "chat": 0.365, "rag": 0.632, "agent": 0.003 }
    }
  }
}
```

`criteria`（可选）用于给出每个选项的口径描述，实测生效。

### Token 口径（与官方文档一致）

| 端点 | 用量位置 | 记录规则 |
| --- | --- | --- |
| `/v1/decision` | 顶层 `input_tokens` + `input_details`（无 `usage` 包裹） | 优先 `input_tokens`；缺失时回退 `input_details.expanded_tokens`；**两者不相加** |
| `/v1/systemone` | `usage.input_tokens` / `usage.output_tokens` | `output_tokens` 是答案序列化长度，不代表生成 Token |

客户端统一由 `extractUsage()` 归一化为 `{ inputTokens, outputTokens, totalTokens, source, raw }`，`source` 明确标注取值来源（`input_tokens` / `expanded_tokens` / `unknown`）。上游未上报时标为 `unknown`，不臆造 0。

## 3. 路由问题为什么用 choice 而不是三个 noul

2026-10-27 同一批样本对比（6 题，人工标注期望路由）：

| 协议 | 命中 | 问题 |
| --- | --- | --- |
| 单个 `choice` + criteria | **6/6 正确**（其中 1 题置信度 0.536 被 `minConfidence=0.55` 拒绝，回落基线仍正确） | 分布分明：chat 0.99 / rag 0.63~0.98 / agent 0.54 |
| 每个路由一个 `noul` 取 argmax | 4/6 | "推免保研需要准备哪些材料" 被判 chat **0.967**，"图书馆几点开门" 被判 chat 0.873 |

结论：路由用 `choice`；`noul` 多问形态保留为解析兼容路径（`normalizeRouteAnswer` 仍支持），供其它部署按 noul 提问时使用。

实测路由（`decideRoute`，enforce 模式）：

| 消息 | 路由 | 置信度 | 延迟 | 输入 Token |
| --- | --- | --- | --- | --- |
| 你好 | chat | 0.996 | 732ms（冷启动） | 82 |
| 图书馆几点开门 | rag | 0.632 | 521ms | 84 |
| 推免保研需要准备哪些材料 | rag | 0.697 | 286ms | 88 |
| 帮我对比三个学院的培养方案并给出建议 | 拒绝（0.536 < 0.55）→ 基线 agent | — | 291ms | 90 |
| 帮我写一封请假邮件 | chat | 0.994 | 232ms | 86 |
| 武汉理工有哪些食堂，分别在哪 | rag | 0.981 | 252ms | 88 |

> 注意 `你好` 这类问候在生产链路上会被 `fastRoute` 零成本短路，不会真的调用模型；上表是直接打服务的测量值。

## 4. 灰度与熔断

模型可能仅对灰度账号开放，未放量时两个端点都返回：

```json
{ "code": "MODEL_ACCESS_DENIED", "message": "当前模型仅对灰度用户开放", "traceId": "trace_..." }
```

处理方式：

- 识别为 `JEV_MODEL_ACCESS_DENIED`（HTTP 403 → 对外 503），**不重试**（403 重试没有意义）。
- 立刻进入冷却期（`JEV_DECISION_UNAVAILABLE_COOLDOWN_MS`，默认 5 分钟）：期间 `shouldEvaluate()` 返回 `false`，编排层直接走基线路由，**不再逐条请求上游**；`/api/decision` 直接返回 503 + `Retry-After`。
- 冷却结束自动重试，账号被放量后无需重启进程。
- 首次命中只记一条 `jev_model_access_denied` 警告，避免日志刷屏。

> 2026-10-27 实测：当天早些时候同 Key 调 `/v1/decision` 与 `/v1/systemone` 均返回 403，数分钟后放量成功（HTTP 200）。说明灰度是动态的，熔断 + 自动恢复是必要设计。

## 5. 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JEV_API_KEY` | 空 | 平台 API Key（也接受 `TOKENRHYTHM_API_KEY` / `TYPESAFE_API_KEY`） |
| `JEV_DECISION_ENABLED` | `true` | 总开关；`false` 时完全不启用 |
| `JEV_DECISION_MODE` | `enforce` | `off` / `shadow`（只记录与基线的一致性）/ `canary`（按百分比放量）/ `enforce`（决策覆盖路由） |
| `JEV_DECISION_ENDPOINT` | `https://tokenrhythm.studio/v1/decision` | 可切 `/v1/systemone` |
| `JEV_DECISION_MODEL` | `NeoHorse-Jev-4B` | 模型 ID 固定 |
| `JEV_DECISION_TIMEOUT_MS` | `1500` | 单次请求超时；超时即回退基线路由 |
| `JEV_DECISION_MAX_RETRIES` | `1` | 仅对 429/529 退避重试（0~2） |
| `JEV_DECISION_MIN_CONFIDENCE` | `0.55` | 低于阈值的决策被拒绝并回落基线；实测分布偏软，可下调到 `0.5` |
| `JEV_DECISION_ROLLOUT_PERCENT` | `100` | `canary` 模式的灰度百分比（按 runId 稳定分桶） |
| `JEV_DECISION_UNAVAILABLE_COOLDOWN_MS` | `300000` | 403 后的冷却时长 |
| `JEV_DECISION_MAX_STATE_CHARS` | `8000` | `/api/decision` 的 `state` 上限 |
| `JEV_DECISION_MAX_QUESTIONS` | `8` | 单次决策最多问题数 |
| `JEV_DECISION_MAX_INSTRUCTIONS_CHARS` | `2000` | 单个问题指令长度上限 |

## 6. 直连接口

### `POST /api/decision`

需要登录（`auth_token` Cookie）。按用户限流 30 次/分钟，并计入每日配额。

```bash
curl -X POST http://localhost:3000/api/decision \
  -H 'Content-Type: application/json' \
  -H 'Cookie: auth_token=...' \
  -d '{
    "state": "路口信号灯为红色，前方有行人。",
    "questions": { "stop": { "type": "noul", "instructions": "现在是否应停车？" } }
  }'
```

成功：

```json
{
  "success": true,
  "data": {
    "provider": "jev",
    "model": "NeoHorse-Jev-4B",
    "answers": { "stop": { "type": "noul", "probability": 0.9896 } },
    "usage": { "inputTokens": 20, "outputTokens": null, "totalTokens": 20, "source": "input_tokens", "raw": { "...": "..." } },
    "decisionSeconds": 0.058,
    "latencyMs": 231,
    "decisionId": "jev_...",
    "traceId": "req_..."
  }
}
```

### `GET /api/decision/status`

不带密钥的可用性快照，可直接给前端做降级提示：

```json
{
  "success": true,
  "data": {
    "provider": "jev",
    "model": "NeoHorse-Jev-4B",
    "endpointHost": "tokenrhythm.studio",
    "mode": "shadow",
    "enabled": true,
    "available": true,
    "status": "available",
    "retryAfterMs": 0,
    "lastFailure": null,
    "questionTypes": ["noul", "choice"]
  }
}
```

## 7. 错误码映射

| 错误码 | HTTP | 含义 | 处理 |
| --- | --- | --- | --- |
| `JEV_INVALID_REQUEST` | 400 | `state` 为空 / 超长、`questions` 非法、类型不支持 | 修入参；不做重试 |
| `JEV_DISABLED` | 503 | 未配置 Key 或总开关关闭 | 确认 `.env` |
| `JEV_MODEL_ACCESS_DENIED` | 503 | 403 灰度限制 | 等放量；冷却期内自动回退 |
| `JEV_UNAVAILABLE` | 503 | 冷却期内再次请求 | 看 `Retry-After` |
| `JEV_UNAUTHORIZED` | 502 | Key 无效/失效 | 换 Key |
| `JEV_TIMEOUT` | 504 | 超过 `JEV_DECISION_TIMEOUT_MS` | 可重试 |
| `JEV_INVALID_RESPONSE` | 502 | 响应缺 `answers` / 缺问题答案 | 记录 body 排查 |
| `JEV_LOW_CONFIDENCE` | 502 | 路由置信度低于阈值 | 回落基线（预期行为） |
| `JEV_API_ERROR` / `JEV_NETWORK_ERROR` | 502 | 其它上游/网络异常 | 可重试 |

## 8. 上线步骤

1. 配 `JEV_API_KEY`（`backend/.env`），先 `JEV_DECISION_MODE=shadow`。
2. `node backend/scripts/jev-probe.cjs` 确认模型可用（退出码 0 可用 / 2 未放量）。
3. 观察日志 `jev_shadow_decision`（含 `agreement`、`baselineRoute`、`candidateRoute`、`confidence`）累计一致性。
4. 一致率与延迟可接受后切 `enforce`；想控风险用 `canary` + `JEV_DECISION_ROLLOUT_PERCENT`。
5. 出问题立即 `JEV_DECISION_MODE=off` 或 `JEV_DECISION_ENABLED=false`，无需改代码。

## 9. 已知限制

- **延迟**：单次决策实测 230~730ms（网络+模型），`enforce` 模式会串在首包之前。本项目默认 `shadow` 不阻塞响应；若切 `enforce`，注意与 `fastRoute` 的分工（问候/明确多步任务已被零成本规则拦截）。
- **置信度分布偏软**：`choice` 的 top1 概率在 0.53~0.99 之间，"对比/综合"类问题常落在 0.53~0.55，会被 `minConfidence` 拒绝并回落基线——这是保守设计，不是故障。
- **模型目录不展示**：`GET /v1/models` 只列聊天模型（25 个），`NeoHorse-Jev-4B` 不在其中；这不代表不可用，以 `/v1/decision` 的实际返回为准。
- **答案字段非文档化**：`noul` 字段名与顶层用量位置均与文档示例不同，故解析层做了宽容匹配；上游若再改字段名，只需更新 `PROBABILITY_KEYS` / `extractUsage`。
