# Agent 链路优化（2026-10-27）

对 `agent.service.js` / `agent-tools.service.js` / `tool-registry.service.js` 做了一轮审计，改动集中在"少跑一次工具、少烧一段 token、trace 不说谎"。

## 一、发现并修复的问题

### 1. 无进展检测在工具执行之后才做（白跑一次检索）

原实现：每轮先执行工具，执行完才比较签名。等检测到"和上轮完全相同的调用"时，第二次检索已经跑完了——`search_knowledge_base` 单次预算 15s，等于为了发现重复而先浪费一次。

现在：签名比较前移到执行前。命中重复直接注入"请基于已有信息回答"的提示并收尾，工具调用次数从 2 降到 1。

### 2. 同一轮内重复调用会执行两次

模型偶尔把同一个调用发起两遍（例如 `search_knowledge_base` 同一 query 出现两个 tool_call）。原实现照单全收，并行跑两次相同检索、回注两份相同上下文。

现在：按 `name + 规范化参数` 去重，assistant `tool_calls` 与 tool 消息同步收敛（协议仍合法），丢弃数量记 `agent_duplicate_tool_call_skipped`。

### 3. `parallelSafe: false` 的工具也被并行执行

注册表声明了 `parallelSafe`（默认 true）与 `sideEffect`，但调度层无条件 `Promise.all`。有副作用的工具同轮并发会互相干扰。

现在：按元信息分组——`parallelSafe` 的并行（延迟取最大值），其余串行；结果仍按模型发起顺序回填，事件/trace/回注顺序不变。

### 4. trace 的 `finishReason` 与实际不符

`finishReason` 初值是 `direct_answer`，工具执行后从不更新。于是"调了 2 次工具再回答"的运行也被记成"直接回答"，前端 `AgentToolPanel` 显示同样错误——这是 tracer 语义 bug，不是显示小瑕疵（灰度分析 finishReason 分布会失真）。

现在：工具执行后将 `finishReason` 置为 `tool_assisted`，`round_limit` / `no_progress` / `error` 仍在各自分支覆盖；前端补充中文文案。

### 5. 决策阶段的解释性文字会被丢弃，纯烧 token

模型若先输出"让我查一下…"再发 tool_calls，这段文本按设计被丢弃（前端只保留过程卡片）。系统提示新增一条规则："需要调用工具时直接发起调用，不要先输出解释性文字"。

### 6. `AGENT_MAX_TOOL_ROUNDS=0` 的边界

`maxRounds` 直接取配置，为 0 时跳过所有决策轮，收尾却带着 tools——模型可能再次发起调用但无人执行。现在 `Math.max(1, …)` 兜底。

## 二、验证

- 单测：新增 3 条（同轮去重、`parallelSafe=false` 串行、无进展不重复执行），并修正 1 条把错误语义写进断言的用例（`direct_answer` → `tool_assisted`）
- 全量：后端 **709** 用例、前端 **180** 用例通过，`lint:check` 清零
- 真实链路（tokenrhythm `deepseek-v4.1-flash-1017`，本地 Qdrant 未启动）：
  - 决策前言 **0 字符**（提示词生效，不再产生被丢弃的草稿）
  - 两轮检索参数不同 → 语义正确地记为 `round_limit`，两轮共 2207 prompt tokens + 186 completion tokens
  - 知识库无结果时如实回答"未检索到"，未编造开放时间

## 三、刻意没改的

| 候选 | 原因 |
| --- | --- |
| 首次检索 0 结果就提前收尾 | 换一种措辞可能命中，直接终止会降低召回；当前交还给模型决定是否再试 |
| Agentic RAG 无证据时回退整条 `rag.chatStream` | 回退会重跑检索（多 1~2 次），但复用上下文生成会改变拒答口径，风险大于收益 |
| 决策阶段改非流式 | 决策文本是前端"思考草稿"的数据源，改非流式会丢 UX |
| `decide()` 与 `chatStream()` 合并 | `decide()` 仅评测脚本使用，合并收益低、diff 风险高 |
