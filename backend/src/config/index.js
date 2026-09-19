// config.js
require('dotenv').config();
const path = require('path');
const { logEvent } = require('../services/observability.service');
const aiBaseUrl = process.env.AI_BASE_URL || 'https://api.stepfun.com/v1';

if (!process.env.VITEST) {
  const requiredEnv = ['AI_API_KEY', 'JWT_SECRET'];
  const missing = requiredEnv.filter(key => !process.env[key]);
  if (missing.length > 0) {
    logEvent('error', 'config_missing_env', { missing: missing.join(', ') });
    logEvent('error', 'config_missing_env_hint', { message: '请检查 backend/.env 文件配置' });
    process.exit(1);
  }
}

module.exports = {
  // AI 模型服务（OpenAI-compatible API）
  ai: {
    apiKey: process.env.AI_API_KEY,
    baseUrl: aiBaseUrl,
    model: process.env.AI_MODEL || 'step-3.7-flash',
    maxTokens: 4000,
    temperature: 0.7,
    timeout: 60000,
    // 推理模型思考链开关（默认关闭，避免思考 token 耗尽输出预算导致空回复）
    enableThinking: process.env.AI_ENABLE_THINKING === 'true',
    // 备用 provider（可选，主 provider 失败时自动切换）
    fallback: {
      apiKey: process.env.AI_FALLBACK_API_KEY || '',
      baseUrl: process.env.AI_FALLBACK_BASE_URL || '',
      model: process.env.AI_FALLBACK_MODEL || '',
      maxTokens: parseInt(process.env.AI_FALLBACK_MAX_TOKENS, 10) || 4000,
      temperature: parseFloat(process.env.AI_FALLBACK_TEMPERATURE) || 0.7,
      timeout: parseInt(process.env.AI_FALLBACK_TIMEOUT, 10) || 60000,
    },
  },
  audio: {
    apiKey: process.env.STEPFUN_API_KEY || (aiBaseUrl.includes('api.stepfun.com') ? process.env.AI_API_KEY : ''),
    baseUrl: process.env.STEPFUN_AUDIO_BASE_URL || (aiBaseUrl.includes('/step_plan/v1') ? aiBaseUrl : 'https://api.stepfun.com/v1'),
    model: process.env.STEPFUN_TTS_MODEL || 'stepaudio-2.5-tts',
    voice: process.env.STEPFUN_TTS_VOICE || 'cixingnansheng',
    responseFormat: process.env.STEPFUN_TTS_FORMAT || 'mp3',
    speed: Number.parseFloat(process.env.STEPFUN_TTS_SPEED || '1'),
    instruction: process.env.STEPFUN_TTS_INSTRUCTION || '自然、亲切、清晰，像校园里的学长学姐耐心回答问题',
    timeout: parseInt(process.env.STEPFUN_TTS_TIMEOUT, 10) || 60000,
    maxInputLength: 1000,
    maxAudioBytes: parseInt(process.env.STEPFUN_TTS_MAX_AUDIO_BYTES, 10) || 16 * 1024 * 1024,
    cacheEnabled: process.env.STEPFUN_TTS_CACHE_ENABLED !== 'false',
    cacheTtlMs: parseInt(process.env.STEPFUN_TTS_CACHE_TTL_MS, 10) || 30 * 60 * 1000,
    cacheMaxEntries: parseInt(process.env.STEPFUN_TTS_CACHE_MAX_ENTRIES, 10) || 100,
    cacheMaxBytes: parseInt(process.env.STEPFUN_TTS_CACHE_MAX_BYTES, 10) || 64 * 1024 * 1024,
  },
  // LLM-as-judge 评测专用（独立 Key，不跟生产抢配额）
  judge: {
    apiKey: process.env.JUDGE_API_KEY || process.env.AI_API_KEY,
    baseUrl: process.env.AI_BASE_URL || 'https://api.stepfun.com/v1',
    model: process.env.JUDGE_MODEL || 'step-3.5-flash',
    maxTokens: 256,
    temperature: 0,
    timeout: 15000,
    // 双判抽样比例：0.1 = 每 10 条抽 1 条复判，量化 judge 一致性；0 关闭
    doubleJudgeRatio: Number.parseFloat(process.env.JUDGE_DOUBLE_JUDGE_RATIO || '0.1'),
  },
  // OCR / 视觉识别配置（扫描件 PDF 与图片表格识别，走 StepFun step-1o-turbo-vision）
  ocr: {
    enabled: process.env.OCR_ENABLED !== 'false',
    model: process.env.OCR_MODEL || 'step-1o-turbo-vision',
    // detail=low ~169 token/图（默认）；表格等细节场景可切 high（按图大小计费）
    detail: process.env.OCR_DETAIL || 'low',
    maxPages: parseInt(process.env.OCR_MAX_PAGES, 10) || 30,
    // 页级识别并发上限（成本与限流闸门）
    concurrency: parseInt(process.env.OCR_CONCURRENCY, 10) || 2,
    // pdf-parse 提取文本低于该阈值视为扫描件，触发 OCR 兜底
    pdfMinChars: parseInt(process.env.OCR_PDF_MIN_CHARS, 10) || 30,
    // 文本型 PDF 表格页检测 + 按页 OCR 重建 Markdown 表格（复用视觉模型，零新依赖）
    tableOcrEnabled: process.env.OCR_TABLE_ENABLED !== 'false',
  },
  // Embedding 配置（本地 BGE-small-zh dense + n-gram sparse）
  embedding: {
    model: process.env.EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5',
    cacheDir: process.env.EMBEDDING_CACHE_DIR || path.resolve(__dirname, '../../../.model-cache'),
    localFilesOnly: process.env.EMBEDDING_LOCAL_FILES_ONLY !== 'false',
    sparseDim: parseInt(process.env.EMBEDDING_SPARSE_DIM, 10) || 250002,
    // 单次送入 ONNX 的批大小：逐条推理会重复摊模型固定开销，真实批量可提升索引吞吐数倍
    batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE, 10) || 16,
    // BGE-zh v1.5 是 s2p 非对称检索模型：查询侧需加指令前缀、文档侧不加。
    // 置 false 可让查询与文档走同一编码路径，用于 A/B 对比前缀收益（索引无需重建）
    queryInstructionEnabled: process.env.EMBEDDING_QUERY_INSTRUCTION !== 'false',
    // 稀疏通道 BM25（idf + 长度归一化）。打开后文档侧权重会变，必须全量重索引；
    // 语料统计缺失时两侧一致退回纯 tf，不会出现单侧带 idf 的错配
    sparseIdfEnabled: process.env.EMBEDDING_SPARSE_IDF !== 'false',
  },
  // JWT 配置（必须通过环境变量设置，禁止硬编码默认值）
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: '7d',
  },
  // 向量数据库（Qdrant 独立服务）
  vectorStore: {
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY || '',
    collectionName: process.env.QDRANT_COLLECTION || 'wuli_elf_chunks',
    // 混合检索权重（dense/sparse 通道加权融合）
    vectorWeight: Number.parseFloat(process.env.RAG_VECTOR_WEIGHT || '0.6'),
    sparseWeight: Number.parseFloat(process.env.RAG_SPARSE_WEIGHT || '0.4'),
    // 融合前通道内归一化：sparse IDF 点积原始分（可达数十）量级远大于 dense 余弦（≤1），
    // 不归一化时 0.6/0.4 权重形同虚设（稠密通道被淹没）。RAG_FUSION_NORM=false 回退原始行为
    fusionNorm: process.env.RAG_FUSION_NORM !== 'false',
    // payload 索引：docId/category 建关键词索引，元数据过滤从全量扫描变为索引查找
    payloadIndexEnabled: process.env.QDRANT_PAYLOAD_INDEX !== 'false',
    // 标量量化（QDRANT_QUANTIZATION=int8）：向量内存约省 75%，需重建 collection 后全量生效
    quantization: process.env.QDRANT_QUANTIZATION || '',
  },
  // 文档入库清洗与质量闸门（Prompt injection 过滤 + 乱码占比检查）
  docSanitize: {
    enabled: process.env.DOC_SANITIZE_ENABLED !== 'false',
    // [UNK]/乱码字符占比超过 warn 阈值记告警，超过 reject 阈值拒绝入库
    warnUnkRatio: Number.parseFloat(process.env.DOC_SANITIZE_WARN_UNK_RATIO || '0.03'),
    rejectUnkRatio: Number.parseFloat(process.env.DOC_SANITIZE_REJECT_UNK_RATIO || '0.15'),
  },
  // 页眉页脚清洗（规则法正则 + 位置法跨页重复行检测，入库前一次完成）
  docClean: {
    enabled: process.env.DOC_CLEAN_ENABLED !== 'false',
    // 位置法：\f 分页数达到该值才启用（页太少无重复性证据）
    minPagesForPosition: parseInt(process.env.DOC_CLEAN_MIN_PAGES, 10) || 3,
    // 页眉/页脚候选行需出现的页数占比
    repeatRatio: Number.parseFloat(process.env.DOC_CLEAN_REPEAT_RATIO || '0.3'),
    // 每页顶部/底部各考察的非空行数
    zoneLines: parseInt(process.env.DOC_CLEAN_ZONE_LINES, 10) || 3,
  },
  // 文本归一化（字符级去脏 + 断行合并）：全角字母数字转半角、空白/BOM/控制字符、
  // 乱码 [UNK] 占位；硬断行 \n 换空格拼接（带结构行保护）。false 时两步全关
  docNormalize: {
    enabled: process.env.DOC_NORMALIZE_ENABLED !== 'false',
  },
  // Prometheus 文本格式 /metrics 抓取端点（默认关；抓取方放外部 Prometheus / Grafana Cloud，
  // 2G 小主机不本地塞监控栈）
  metricsPrometheus: {
    enabled: process.env.METRICS_PROMETHEUS_ENABLED === 'true',
    // 设置后抓取需带 Bearer token（或 ?token=）；本地留空即可
    token: process.env.METRICS_PROMETHEUS_TOKEN || '',
  },
  // OpenTelemetry traces（OTLP 导出）：设置 OTEL_EXPORTER_OTLP_ENDPOINT 即启用，
  // 关闭时零 SDK 加载、零 span 开销；服务名 OTEL_SERVICE_NAME（默认 wuli-elf-backend），
  // OTEL_TRACING_ENABLED=false 可在保留端点变量的同时显式关闭
  otel: {
    enabled: !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_TRACING_ENABLED !== 'false',
  },
  // 文档内容去重（sha256 归一化哈希）：重复上传直接返回已有文档，不再产生重复向量
  document: {
    dedupEnabled: process.env.DOC_DEDUP_ENABLED !== 'false',
    // 场景化子块切割：FAQ 整条 / 表格整表或按行 / 列表按条目（默认开；false 回退 25 字符句子包）
    adaptiveChunking: process.env.DOC_ADAPTIVE_CHUNKING !== 'false',
  },
  // RAG 检索链路配置
  rag: {
    hybridSearchEnabled: process.env.RAG_HYBRID_SEARCH !== 'false',
    searchTopK: parseInt(process.env.RAG_VECTOR_TOP_K, 10) || 50,
    rerankTopK: parseInt(process.env.RAG_RERANK_TOP_K, 10) || 10,
    // cross-encoder 精排开关：小内存机器（2G）可关——融合归一化修复后排序
    // 不再依赖 reranker，关闭可省约 300MB 内存与单次 ~2s 延迟，排序精度略降
    rerankEnabled: process.env.RAG_RERANK_ENABLED !== 'false',
    maxContextLength: parseInt(process.env.RAG_MAX_CONTEXT_LENGTH, 10) || 6000,
    minSourceScore: Number.parseFloat(process.env.RAG_MIN_SOURCE_SCORE || '0.03'),
    vectorWeight: Number.parseFloat(process.env.RAG_VECTOR_WEIGHT || '0.6'),
    rrfK: parseInt(process.env.RAG_RRF_K, 10) || 60,
    // 父段归并后 MMR 去重：剔除与已选父段高度相似的冗余段落
    mmrEnabled: process.env.RAG_MMR_ENABLED !== 'false',
    mmrLambda: Number.parseFloat(process.env.RAG_MMR_LAMBDA || '0.7'),
    mmrMaxSim: Number.parseFloat(process.env.RAG_MMR_MAX_SIM || '0.85'),
    // 元数据过滤（Multi-faceted Filtering）：按问题关键词自动推断文档类别过滤候选
    autoCategoryFilter: process.env.RAG_AUTO_CATEGORY_FILTER !== 'false',
    // 运行时引用校验（防幻觉兜底）：生成后逐句对照 RAG 上下文，低溯源回答标注 level=low
    groundingEnabled: process.env.RAG_GROUNDING_ENABLED !== 'false',
    groundingMinSupport: Number.parseFloat(process.env.RAG_GROUNDING_MIN_SUPPORT || '0.35'),
    // 跨文档问题分解：对比/列举类问题拆实体级子查询扩大召回池（reranker 仍按原问题打分）
    queryDecomposeEnabled: process.env.RAG_QUERY_DECOMPOSE_ENABLED !== 'false',
    queryDecomposeMaxSubQueries: parseInt(process.env.RAG_DECOMPOSE_MAX_SUB_QUERIES, 10) || 3,
    // 查询翻译（2026-09-03 新增）：HyDE 假设文档 / Step-Back 上位问题，作为额外召回变体
    // 扩大召回池（reranker 仍按原问题打分，精度不受影响）。默认关闭，灰度开启
    hydeEnabled: process.env.RAG_HYDE_ENABLED === 'true',
    stepBackEnabled: process.env.RAG_STEP_BACK_ENABLED === 'true',
    // 意图识别自动路由（V2.0）：前端不再手动开关 RAG，后端自动路由
    // rag=知识库检索 / chat=纯对话 / agent=工具调度（INTENT_ROUTING_ENABLED=false 可整体关闭，退回原链路）
    intentRoutingEnabled: process.env.INTENT_ROUTING_ENABLED !== 'false',
    // LLM 意图分类兜底（默认关：避免每条消息多一次 LLM 调用拖慢首包延迟；fastRoute 零成本路由常开）
    intentClassifyEnabled: process.env.INTENT_CLASSIFY_ENABLED === 'true',
    // 检索多级缓存（2026-08-20 新增）
    cacheEnabled: process.env.RAG_CACHE_ENABLED !== 'false',
    cacheTtlMs: parseInt(process.env.RAG_CACHE_TTL_MS, 10) || 300000,           // 5min
    cacheMaxEntries: parseInt(process.env.RAG_CACHE_MAX_ENTRIES, 10) || 500,
    rerankerCacheMaxEntries: parseInt(process.env.RAG_RERANKER_CACHE_MAX, 10) || 2000,
    rewriteCacheMaxEntries: parseInt(process.env.RAG_REWRITE_CACHE_MAX, 10) || 500,
    compactCacheMaxEntries: parseInt(process.env.RAG_COMPACT_CACHE_MAX, 10) || 200,
    compactCacheTtlMs: parseInt(process.env.RAG_COMPACT_CACHE_TTL_MS, 10) || 1800000, // 30min
    // 语义缓存：精确缓存 miss 后按查询向量余弦相似度复用近义问题的检索候选池
    // （reranker 仍按原始问题打分，共享召回池不影响精度）。默认关闭
    semanticCacheEnabled: process.env.RAG_SEMANTIC_CACHE_ENABLED === 'true',
    semanticCacheThreshold: Number.parseFloat(process.env.RAG_SEMANTIC_CACHE_THRESHOLD || '0.95'),
    semanticCacheMaxEntries: parseInt(process.env.RAG_SEMANTIC_CACHE_MAX_ENTRIES, 10) || 200,
  },
  // 轻量 Agent 工具调度（V2.0）：默认启用；AGENT_TOOL_ENABLED=false 可一键回退 RAG
  agent: {
    toolEnabled: process.env.AGENT_TOOL_ENABLED !== 'false',
    // 工具决策/执行超时（毫秒）
    decideTimeoutMs: parseInt(process.env.AGENT_DECIDE_TIMEOUT_MS, 10) || 15000,
    toolTimeoutMs: parseInt(process.env.AGENT_TOOL_TIMEOUT_MS, 10) || 15000,
    // 多轮工具调度上限（L2）：最多轮次，防止无限循环；配合无进展检测强制收尾
    maxToolRounds: parseInt(process.env.AGENT_MAX_TOOL_ROUNDS, 10) || 2,
    // 上下文压缩分层（2026-09-03 新增，借鉴 AgentHarness 四层压缩中的两层）：
    // L1 大结果落盘：单条 tool result 超阈值时完整内容写入 toolSpillDir，上下文只留摘要+引用
    // L2 历史 tool result 替换：仅保留最近 toolResultKeepRounds 轮完整结果，更早轮次替换为占位符
    // AGENT_CONTEXT_COMPACTION=false 一键回退
    contextCompactionEnabled: process.env.AGENT_CONTEXT_COMPACTION !== 'false',
    toolResultSpillThreshold: parseInt(process.env.AGENT_TOOL_RESULT_SPILL_THRESHOLD, 10) || 2000,
    toolResultKeepRounds: Math.max(parseInt(process.env.AGENT_TOOL_RESULT_KEEP_ROUNDS, 10) || 1, 1),
    toolSpillDir: process.env.AGENT_TOOL_SPILL_DIR || path.join(__dirname, '..', '..', 'data', 'tool-spills'),
    toolSpillMaxFiles: parseInt(process.env.AGENT_TOOL_SPILL_MAX_FILES, 10) || 200,
  },
  // 记忆系统（2026-09-03 新增）：LLM 记忆提取与分类治理
  memory: {
    // LLM 记忆提取：从每轮对话中抽取 偏好/错误反馈/事实/外部参考 四类记忆（fire-and-forget，
    // 失败自动回退正则提取）。MEMORY_LLM_EXTRACTION=false 关闭（每轮省一次 LLM 调用）
    llmExtractionEnabled: process.env.MEMORY_LLM_EXTRACTION !== 'false',
    // 语义去重阈值：同类型记忆 cosine 相似度 ≥ 该值视为重复，执行合并（而非新增）
    dedupSimilarity: Number.parseFloat(process.env.MEMORY_DEDUP_SIMILARITY || '0.9'),
  },
  // 受控 Agentic RAG：默认关闭，灰度开启后仅替换知识库问答链路
  agenticRag: {
    enabled: process.env.AGENTIC_RAG_ENABLED === 'true',
    // 最多 3 轮，避免检索循环失控
    maxRounds: Math.min(Math.max(parseInt(process.env.AGENTIC_RAG_MAX_ROUNDS, 10) || 2, 1), 3),
    maxDurationMs: parseInt(process.env.AGENTIC_RAG_MAX_DURATION_MS, 10) || 20000,
    rewriteTimeoutMs: parseInt(process.env.AGENTIC_RAG_REWRITE_TIMEOUT_MS, 10) || 8000,
    minSources: Math.max(parseInt(process.env.AGENTIC_RAG_MIN_SOURCES, 10) || 1, 1),
  },
  // 自有账号系统配置
  auth: {
    inviteCode: process.env.AUTH_INVITE_CODE || '',
  },
  // 用户级配额限制（每日 LLM 调用次数）
  quota: {
    dailyLimit: parseInt(process.env.QUOTA_DAILY_LIMIT, 10) || 100,
    anonymousLimit: parseInt(process.env.QUOTA_ANONYMOUS_LIMIT, 10) || 20,
  },
  // 管理员登录配置（密码未设置时生成随机密码，禁止空密码）
  admin: (() => {
    const fs = require('fs');
    const path = require('path');
    const username = process.env.ADMIN_USERNAME || 'admin';
    const fromEnv = process.env.ADMIN_PASSWORD || '';

    if (fromEnv) {
      // 环境变量已接管：清理历史生成的密码文件，避免旧凭据残留磁盘
      try { fs.unlinkSync(path.join(__dirname, '../../data/admin-password.txt')); } catch { /* 不存在或不可删均可忽略 */ }
      return { username, password: fromEnv };
    }

    // 未设置 ADMIN_PASSWORD：生成随机密码写入本地文件（backend/.gitignore 已排除 data/*），
    // 重启复用同一份避免轮换；密码本身绝不打印到控制台/日志
    const credFile = path.join(__dirname, '../../data/admin-password.txt');
    try {
      const persisted = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8').trim() : '';
      if (persisted) {
        logEvent('warn', 'config_admin_password_reused_file', { message: '未设置 ADMIN_PASSWORD，复用已生成的管理员密码文件', credFile });
        return { username, password: persisted };
      }
      const generated = require('crypto').randomBytes(12).toString('base64url');
      fs.mkdirSync(path.dirname(credFile), { recursive: true });
      fs.writeFileSync(credFile, generated, { mode: 0o600 });
      logEvent('warn', 'config_admin_password_generated', { message: '未设置 ADMIN_PASSWORD，已生成随机管理员密码并写入文件（不打印明文）', credFile });
      logEvent('warn', 'config_admin_password_hint', { message: '请尽快在 .env 中设置 ADMIN_PASSWORD 以固定管理员密码' });
      return { username, password: generated };
    } catch (err) {
      // 落盘失败（只读文件系统等）：fail-closed，不生成无人知晓的密码，也不打印明文
      logEvent('error', 'config_admin_password_file_error', { message: '管理员密码文件读写失败', error: err.message });
      logEvent('error', 'config_admin_password_env_hint', { message: '请通过环境变量 ADMIN_PASSWORD 显式指定管理员密码' });
      return { username, password: '' };
    }
  })(),
};
