# 功能清单与设计要点（面试自查表）

> 用途：对照本表逐条检查"能不能讲清楚为什么这么设计"。每条附代码落点，讲不出设计理由的功能先去读对应文件。更新代码时同步更新本表。

## 一、RAG 检索链路

| 功能 | 关键文件 | 设计要点（一句话） |
| --- | --- | --- |
| 混合检索（dense + sparse） | `backend/src/services/embedding.service.js` | 本地 BGE-small-zh dense + n-gram sparse，零模型 API 成本 |
| Qdrant 混合检索与融合 | `vector-store-qdrant.service.js` | 加权融合默认（官方评测优于 RRF k=60；RRF k=10 打平），payload 索引加速元数据过滤 |
| 父子分段 | `indexing.service.js` | 父级段落给 LLM 上下文，子级句子向量化，兼顾语义聚焦与上下文完整 |
| 重排 + 自适应截断 + MMR | `rag-ranking.service.js` | cross-encoder 精排，类型化阈值零成本差异化，bigram MMR 去冗余 |
| Query 改写 | `rag-query-rewrite.service.js` | 多轮指代/省略正则检测 + LLM 改写，6 条历史窗口 hash 缓存 |
| 跨文档问题分解 | `query-decompose.service.js` | 纯正则拆对比/列举类问题为子查询，只扩召回池不改打分 |
| 多路检索合并 | `rag-retrieval.service.js` | 原问题必选 + 改写/子查询并行，chunk id 去重保留高分 |
| 检索缓存（三级） | `rag-retrieval.service.js` / `utils/query-cache.js` | 精确 LRU+TTL → 语义缓存（余弦 ≥0.95 复用召回池，默认关）→ embedding 进程内缓存 |
| 增量重索引 | `indexing.service.js` + 两个向量后端 | chunk 内容 sha256 对齐，未变段落复用向量，只重算变化部分 |
| 上下文组装 | `rag-context-builder.service.js` | 父段按 rerank 分数排序，maxContextLength 内装满，支持请求级覆盖（A/B 用） |

## 二、回答质量与透明化

| 功能 | 关键文件 | 设计要点 |
| --- | --- | --- |
| 行内引用徽章 | `src/utils/citations.js` + `MarkdownRenderer.vue` | 【文档N】/[N] 双格式渲染，跳过代码块与链接，悬停显示来源摘要 |
| 引用弹窗 + 原文跳转 | `CitationPopup.vue` | snippet 首词做高亮关键词，跳知识库自动预览定位 |
| Grounding 溯源校验 | `backend/src/services/grounding.service.js` | 句级 bigram 覆盖率，零模型调用，旁路不阻断，前端徽章标注 |
| 追问建议 | `rag-followups.service.js` | 从引用父段章节标题 + 文档标题零 LLM 生成，与问题重叠的排除 |
| 拒答引导 | `MessageBubble.vue` | 无可靠来源时给"换个问法/去知识库"行动建议，不硬编 |
| 工具轨迹面板 | `AgentToolPanel.vue` | tool_call/result + 轮次/收尾原因/耗时，Agent 决策全透明 |
| 检索轨迹 | `rag-tracer.service.js` + `RetrievalTracePanel.vue` | 分阶段耗时随 SSE 下发，前端可视化 |
| token 用量展示 | `ai.service.js` + `MessageBubble.vue` | 流式收尾透传 streamUsage，多字段名兼容 |

## 三、对话体验

| 功能 | 关键文件 | 设计要点 |
| --- | --- | --- |
| SSE 流式渲染 | `useStreaming.js` | RAF 合并高频增量，后台 Tab 暂停 RAF 时立即落盘 |
| 断线重连 | `useStreaming.js` + `api/chat.js` | 指数退避，重试从头流，清空半截内容防拼接 |
| 意图自动路由 | `conversation-orchestrator.service.js` + `intent-router.service.js` | 高置信规则优先，默认兜底 RAG，Agent 失败降级 RAG |
| Agent 工具调度 | `agent.service.js` + `tool-registry.service.js` | 有界轮次 + 无进展检测 + 工具超时降级为观测结果 |
| 消息分叉 | `memory-store.js` + `MessageActions.vue` | 复制到目标消息为止建新会话，原会话不动 |
| 编辑重发 | `useStreaming.js` | 更新文本后走 retry 通道，换掉旧的用户+回复对再重流 |
| 会话搜索 | `ConversationList.vue` | 标题 + 消息内容匹配，命中预览按会话缓存 |
| 动态快捷提问 | `starterQuestions.js` + `AIChat.vue` | 按类别轮转取知识库文档生成，失败回退静态兜底 |
| 语音交互 | `audio.service.js` + `VoiceRecorder.vue` | Web Speech 转写 + StepFun TTS，内存缓存 64MB 上限 |
| 文件对话与 OCR | `file-upload.service.js` + `ocr.service.js` | 文本型 PDF 直取，扫描件视觉 OCR，表格页重建 Markdown |

## 四、知识库运营与数据飞轮

| 功能 | 关键文件 | 设计要点 |
| --- | --- | --- |
| 反馈闭环 | `rag.controller.js` + `export-badcases.cjs` | 点踩 → 一键入队 → 导出评测集 → 回写 exported 状态 |
| 知识缺口看板 | `KnowledgeBase.vue` + `quality-governance.service.js` | 线上审计按主题聚合，缺口问题一键创建补资料任务 |
| 入库清洗 | `doc-sanitizer.service.js` | prompt-injection 行清洗 + OCR 乱码占比闸门 |
| 文档去重 | `document.service.js` | 内容 sha256 重复上传直接返回已有文档 |
| 质量治理审计 | `quality-governance.service.js` | 六大校园主题分类 + 不确定性话术检测 |
| Wiki/RAG 治理 | `wiki.service.js` + `rag.service.js` | 正文修订 stale、管理员重新审核、Wiki/Qdrant 混合候选与统一引用编号 |

## 五、评测体系（`scripts/rag-eval/`）

| 能力 | 要点 |
| --- | --- |
| 检索评测 | Recall/MRR/nDCG@5/HitRate，full-coverage 32 题基线：97.4% / 0.977 / 0.970 / 100% |
| 消融实验 | 融合策略（加权 vs RRF k=10/k=60）、MMR 开关，结论沉淀在 CLAUDE.md 与 README |
| RAGAS 生成评测 | Faithfulness 91.7%（campus-qa 32 题，judge 模型独立 Key） |
| Agent 路由评测 | routing 数据集验证 chat/rag/agent 分流正确率；artifact 大结果读取闭环有 AgentService 回归 |
| 回归门禁 | CONTRIBUTING 约定：检索链路改动必须跑基线，回退需说明 |

## 六、工程与运维

| 能力 | 要点 |
| --- | --- |
| CI/CD | Lint → Test → Build → Trivy 扫描 → ECS 部署 + 健康检查回滚（`.github/workflows/deploy.yml`） |
| 备份恢复 | `scripts/backup.sh`：SQLite better-sqlite3 在线备份 + Qdrant snapshot API + 轮转 |
| 存储 | SQLite WAL（`memory-store.js` 当前唯一实现）+ Qdrant 向量库 |
| 安全 | httpOnly JWT Cookie、Helmet、限流、配额、私有附件用户/会话归属、MIME 校验、工具 Schema 校验 |
| 可观测 | 结构化日志 + RunEvent v1（SSE/JSONL 回放，默认关闭，`/api/metrics/runs/:runId/events` 管理员接口）+ 运行完成率/首事件/P95/工具与降级指标 + 运营看板（OperationsDashboard.vue）+ Prometheus `/api/metrics/prometheus`（env 门控 + token）+ OTLP trace 导出；Markdown Worker 低频上报队列深度、耗时与过期结果到 `/api/metrics/client-performance` |
| 部署 | Docker 三阶段（better-sqlite3 强制编译验证）+ 宿主机 nginx 反代 |
