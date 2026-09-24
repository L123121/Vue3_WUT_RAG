<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  AlertCircle,
  Clock3,
  Coins,
  ClipboardCheck,
  DatabaseZap,
  FilePlus2,
  Flame,
  Gauge,
  GitCompareArrows,
  ListChecks,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
} from 'lucide-vue-next';
import { createKnowledgeTask, getOperationsDashboard, getRunEvents } from '../api/operations.js';
import { useToastStore } from '../stores/toast.store.js';

const dashboard = ref(null);
const isLoading = ref(true);
const errorMessage = ref('');
const lastUpdated = ref('');
const toast = useToastStore();
const creatingTaskId = ref('');
const runIdInput = ref('');
const replayRunId = ref('');
const replayEvents = ref([]);
const replayLoading = ref(false);
const replayError = ref('');

const emptyQuality = {
  evaluation: null,
  rag: { sourceCoverage: '0%', totalQueries: 0, ragQueries: 0, avgMatchedDocs: '0' },
  latency: { total: { avg: 0, p50: 0, p95: 0, count: 0 } },
  observability: { stages: {} },
};

const quality = computed(() => dashboard.value?.quality || emptyQuality);
const operations = computed(() => dashboard.value?.operations || {
  requests: { total: 0, errors: 0, p50Ms: 0, p95Ms: 0 },
  llm: { total: 0, promptTokens: 0, completionTokens: 0, estimatedCostCny: 0 },
  tts: { total: 0, characters: 0, estimatedCostCny: 0 },
  estimatedCostCny: 0,
});
const clientPerformance = computed(() => dashboard.value?.clientPerformance || []);
const latestMarkdownWorker = computed(() => [...clientPerformance.value].reverse().find((item) => item.name === 'markdown_worker') || null);
const satisfaction = computed(() => dashboard.value?.satisfaction || {
  total: 0, like: 0, dislike: 0, satisfactionRate: null,
});
const evaluationHistory = computed(() => dashboard.value?.evaluationHistory || { current: null, previous: null, deltas: {}, best: null, ranked: [] });
const riskAudit = computed(() => dashboard.value?.riskAudit || { totalQuestions: 0, highRiskCount: 0, knowledgeGapCount: 0, topTopics: [], highRisk: [], tasks: [] });
const evaluation = computed(() => {
  if (quality.value.evaluation) return quality.value.evaluation;
  const current = evaluationHistory.value.current;
  return current ? { ...current.metrics, avgLatency: current.avgLatency, sampleCount: current.sampleCount, evaluatedAt: current.createdAt } : null;
});
const stages = computed(() => Object.entries(quality.value.observability?.stages || {}));
const totalCost = computed(() => Number(operations.value.estimatedCostCny || 0));
const totalTokens = computed(() => Number(operations.value.llm?.promptTokens || 0) + Number(operations.value.llm?.completionTokens || 0));

const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
const formatCost = (value) => `¥${Number(value || 0).toFixed(3)}`;
const formatLatency = (value) => `${Math.round(Number(value || 0))} ms`;
const formatPercent = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number.parseFloat(String(value).replace('%', ''));
  return Number.isFinite(number) ? `${Math.round(number * 10) / 10}%` : '—';
};
const metricPercent = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number * 100)) : 0;
};
const formatDate = (value) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '尚未运行';
const formatSignedPercent = (value) => {
  if (value === null || value === undefined) return '—';
  return `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
};
const formatSignedLatency = (value) => {
  if (value === null || value === undefined) return '—';
  return `${value > 0 ? '+' : ''}${Math.round(value)} ms`;
};
const deltaTone = (value, inverse = false) => {
  if (value === null || value === undefined || value === 0) return 'text-slate-400';
  const positive = inverse ? value < 0 : value > 0;
  return positive ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300';
};

const createTask = async (item) => {
  if (!item?.id || creatingTaskId.value) return;
  creatingTaskId.value = item.id;
  try {
    const response = await createKnowledgeTask({ auditId: item.id });
    if (!response?.success) throw new Error(response?.error || '任务创建失败');
    toast.success('补充文档任务已创建');
    await loadDashboard();
  } catch (error) {
    toast.error(error.message || '任务创建失败');
  } finally {
    creatingTaskId.value = '';
  }
};

const qualityRows = computed(() => [
  { label: '检索召回率', hint: 'Context recall', value: evaluation.value?.context_recall, icon: DatabaseZap, tone: 'cyan' },
  { label: '答案准确度', hint: 'Faithfulness', value: evaluation.value?.faithfulness, icon: ShieldCheck, tone: 'emerald' },
  { label: '答案相关性', hint: 'Answer relevancy', value: evaluation.value?.answer_relevancy, icon: Sparkles, tone: 'amber' },
  { label: '上下文精度', hint: 'Context precision', value: evaluation.value?.context_precision, icon: Gauge, tone: 'violet' },
]);

const loadDashboard = async () => {
  isLoading.value = true;
  errorMessage.value = '';
  try {
    const response = await getOperationsDashboard();
    if (!response?.success) throw new Error(response?.error || '看板数据加载失败');
    dashboard.value = response.data;
    lastUpdated.value = response.data?.generatedAt || new Date().toISOString();
  } catch (error) {
    errorMessage.value = error?.message || '看板数据加载失败';
  } finally {
    isLoading.value = false;
  }
};

const loadRunEvents = async () => {
  const runId = runIdInput.value.trim();
  if (!runId || replayLoading.value) return;
  replayLoading.value = true;
  replayError.value = '';
  replayEvents.value = [];
  try {
    const response = await getRunEvents(runId);
    if (!response?.success) throw new Error(response?.error || 'RunEvent 回放加载失败');
    replayRunId.value = response.data?.runId || runId;
    replayEvents.value = response.data?.events || [];
  } catch (error) {
    replayError.value = error?.message || 'RunEvent 回放加载失败';
  } finally {
    replayLoading.value = false;
  }
};

const replayEventTone = (type) => {
  if (type === 'run.completed') return 'text-emerald-600 dark:text-emerald-300';
  if (type === 'run.failed') return 'text-rose-600 dark:text-rose-300';
  if (type === 'tool.call' || type === 'tool.result') return 'text-amber-600 dark:text-amber-300';
  return 'text-slate-600 dark:text-slate-300';
};

onMounted(loadDashboard);
</script>

<template>
  <div class="dashboard-shell min-h-screen overflow-y-auto px-4 py-5 text-slate-900 dark:text-slate-100 md:px-8 md:py-8">
    <div class="mx-auto max-w-7xl space-y-6">
      <header class="dashboard-hero relative overflow-hidden rounded-[2rem] border border-slate-200/80 bg-[#0b1727] px-6 py-7 text-white shadow-2xl shadow-slate-300/30 dark:border-slate-800 dark:shadow-black/30 md:px-9 md:py-9">
        <div class="hero-grid absolute inset-0 opacity-30" aria-hidden="true"></div>
        <div class="hero-orb hero-orb-one" aria-hidden="true"></div>
        <div class="hero-orb hero-orb-two" aria-hidden="true"></div>
        <div class="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div>
            <div class="mb-4 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.28em] text-cyan-300">
              <Activity :size="14" />
              Operations / RAG Quality
            </div>
            <h1 class="max-w-2xl text-3xl font-black tracking-tight md:text-5xl">校园智能助手<br /><span class="text-cyan-300">质量与运营驾驶舱</span></h1>
            <p class="mt-4 max-w-xl text-sm leading-6 text-slate-300">把检索质量、模型成本、响应性能和真实用户反馈放在同一张图上，为每一次答辩演示提供可验证的数字。</p>
          </div>
          <div class="flex shrink-0 flex-col items-start gap-3 md:items-end">
            <button class="refresh-button" :disabled="isLoading" @click="loadDashboard">
              <RefreshCw :size="15" :class="{ 'animate-spin': isLoading }" />
              {{ isLoading ? '同步中' : '刷新数据' }}
            </button>
            <div class="flex items-center gap-2 text-xs text-slate-400">
              <span class="status-dot"></span>
              数据更新时间：{{ lastUpdated ? formatDate(lastUpdated) : '读取中' }}
            </div>
          </div>
        </div>
      </header>

      <div v-if="errorMessage" class="flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
        <AlertCircle :size="18" />
        {{ errorMessage }}
      </div>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article class="metric-card metric-card-cyan">
          <div class="metric-icon"><BarChart3 :size="18" /></div>
          <div class="metric-label">综合评测得分</div>
          <div class="metric-value">{{ evaluation ? formatPercent(evaluation.overall) : '—' }}</div>
          <div class="metric-foot">{{ evaluation ? `${evaluation.sampleCount} 条测试样本` : '运行一次 RAG 评测后显示' }}</div>
        </article>
        <article class="metric-card metric-card-emerald">
          <div class="metric-icon"><DatabaseZap :size="18" /></div>
          <div class="metric-label">引用覆盖率</div>
          <div class="metric-value">{{ formatPercent(quality.rag?.sourceCoverage) }}</div>
          <div class="metric-foot">{{ formatNumber(quality.rag?.ragQueries) }} 次 RAG 查询</div>
        </article>
        <article class="metric-card metric-card-amber">
          <div class="metric-icon"><Clock3 :size="18" /></div>
          <div class="metric-label">平均响应时间</div>
          <div class="metric-value">{{ formatLatency(quality.latency?.total?.avg) }}</div>
          <div class="metric-foot">P95 {{ formatLatency(operations.requests?.p95Ms) }}</div>
        </article>
        <article class="metric-card metric-card-violet">
          <div class="metric-icon"><ThumbsUp :size="18" /></div>
          <div class="metric-label">用户满意率</div>
          <div class="metric-value">{{ satisfaction.satisfactionRate === null ? '—' : `${satisfaction.satisfactionRate}%` }}</div>
          <div class="metric-foot">{{ formatNumber(satisfaction.total) }} 条有效反馈</div>
        </article>
      </div>

      <section class="panel-card version-panel">
        <div class="section-heading">
          <div><div class="eyebrow">Evaluation lineage</div><h2>版本演进与自动决策</h2></div>
          <div class="heading-chip"><GitCompareArrows :size="14" /> 持续迭代</div>
        </div>
        <div v-if="evaluationHistory.current" class="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div class="version-summary">
            <div class="flex items-start justify-between gap-4">
              <div><div class="version-kicker">当前运行版本</div><div class="mt-2 text-2xl font-black tracking-tight">{{ evaluationHistory.current.promptVersion }}</div><div class="mt-2 flex flex-wrap gap-2 text-xs font-bold text-slate-500 dark:text-slate-400"><span class="meta-pill">{{ evaluationHistory.current.datasetVersion }}</span><span class="meta-pill">{{ evaluationHistory.current.model }}</span></div></div>
              <div class="recommend-badge"><ClipboardCheck :size="14" /> {{ evaluationHistory.best?.id === evaluationHistory.current.id ? '推荐上线' : '继续观察' }}</div>
            </div>
            <div class="mt-6 grid grid-cols-2 gap-3">
              <div class="decision-stat"><span>综合得分</span><strong>{{ formatPercent(evaluationHistory.current.metrics.overall) }}</strong></div>
              <div class="decision-stat"><span>平均延迟</span><strong>{{ formatLatency(evaluationHistory.current.avgLatency) }}</strong></div>
              <div class="decision-stat"><span>满意度</span><strong>{{ evaluationHistory.current.satisfactionRate === null ? '—' : formatPercent(evaluationHistory.current.satisfactionRate) }}</strong></div>
              <div class="decision-stat"><span>评测成本</span><strong>{{ formatCost(evaluationHistory.current.costCny) }}</strong></div>
            </div>
            <div v-if="evaluationHistory.previous" class="comparison-callout mt-4"><div class="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-cyan-700 dark:text-cyan-300"><ArrowUpRight :size="14" /> 相比上一次</div><div class="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm font-black"><span :class="deltaTone(evaluationHistory.deltas.context_recall)">召回率 {{ formatSignedPercent(evaluationHistory.deltas.context_recall) }}</span><span :class="deltaTone(evaluationHistory.deltas.citationCoverage)">引用 {{ formatSignedPercent(evaluationHistory.deltas.citationCoverage) }}</span><span :class="deltaTone(evaluationHistory.deltas.avgLatency, true)">延迟 {{ formatSignedLatency(evaluationHistory.deltas.avgLatency) }}</span><span :class="deltaTone(evaluationHistory.deltas.costPercent, true)">成本 {{ formatSignedPercent(evaluationHistory.deltas.costPercent) }}</span></div></div>
          </div>
          <div class="overflow-x-auto rounded-2xl border border-slate-100 dark:border-slate-800"><table class="history-table"><thead><tr><th>运行版本</th><th>召回率</th><th>引用覆盖</th><th>延迟</th><th>成本</th><th>决策</th></tr></thead><tbody><tr v-for="row in evaluationHistory.ranked" :key="row.id"><td><div class="font-black text-slate-800 dark:text-slate-100">{{ row.promptVersion }}</div><div class="mt-1 text-[10px] text-slate-400">{{ row.datasetVersion }} · {{ formatDate(row.createdAt) }}</div></td><td class="tabular-nums">{{ formatPercent(row.metrics.context_recall) }}</td><td class="tabular-nums">{{ row.citationCoverage === null ? '—' : formatPercent(row.citationCoverage) }}</td><td class="tabular-nums">{{ formatLatency(row.avgLatency) }}</td><td class="tabular-nums">{{ formatCost(row.costCny) }}</td><td><span v-if="evaluationHistory.best?.id === row.id" class="success-pill"><ClipboardCheck :size="12" /> 推荐</span><span v-else class="neutral-pill">{{ row.compositeScore.toFixed(3) }}</span></td></tr></tbody></table></div>
        </div>
        <div v-else class="empty-quality"><div class="empty-orbit"><GitCompareArrows :size="22" /></div><div><h3>等待第一次可追溯评测</h3><p>每次运行都会保存数据集、模型、Prompt、四项质量分、延迟与成本，下一次自动生成差异。</p></div></div>
      </section>

      <div class="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section class="panel-card">
          <div class="section-heading">
            <div>
              <div class="eyebrow">Quality signal</div>
              <h2>RAG 质量信号</h2>
            </div>
            <div class="heading-chip"><CheckCircle2 :size="14" /> 可追溯</div>
          </div>
          <div v-if="evaluation" class="mt-7 grid gap-5 sm:grid-cols-2">
            <div v-for="row in qualityRows" :key="row.label" class="quality-row">
              <div class="mb-2 flex items-center justify-between gap-3">
                <div class="flex items-center gap-2">
                  <component :is="row.icon" :size="15" :class="`text-${row.tone}-500`" />
                  <span class="text-sm font-bold">{{ row.label }}</span>
                </div>
                <span class="text-sm font-black tabular-nums">{{ formatPercent(row.value) }}</span>
              </div>
              <div class="progress-track"><div class="progress-fill" :class="`fill-${row.tone}`" :style="{ width: `${metricPercent(row.value)}%` }"></div></div>
              <div class="mt-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{{ row.hint }}</div>
            </div>
          </div>
          <div v-else class="empty-quality">
            <div class="empty-orbit"><Sparkles :size="22" /></div>
            <div>
              <h3>还没有离线评测样本</h3>
              <p>运行 RAG 评测后，这里会记录召回率、答案准确度和上下文精度。</p>
            </div>
          </div>
          <div class="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span>最近评测：{{ formatDate(evaluation?.evaluatedAt) }}</span>
            <span v-if="evaluation">评测平均延迟 {{ formatLatency(evaluation.avgLatency) }}</span>
          </div>
        </section>

        <section class="panel-card">
          <div class="section-heading">
            <div>
              <div class="eyebrow">Live telemetry</div>
              <h2>线上运行状态</h2>
            </div>
            <div class="heading-chip heading-chip-green"><span class="status-dot"></span> 实时采样</div>
          </div>
          <div class="mt-6 space-y-4">
            <div class="telemetry-line"><span>总请求量</span><strong>{{ formatNumber(operations.requests?.total) }}</strong></div>
            <div class="telemetry-line"><span>服务端错误</span><strong :class="operations.requests?.errors ? 'text-rose-600' : 'text-emerald-600'">{{ formatNumber(operations.requests?.errors) }}</strong></div>
            <div class="telemetry-line"><span>RAG 查询占比</span><strong>{{ operations.requests?.total ? `${Math.round((quality.rag?.ragQueries / operations.requests.total) * 100)}%` : '—' }}</strong></div>
            <div class="telemetry-line"><span>平均匹配父文档</span><strong>{{ quality.rag?.avgMatchedDocs || '0' }}</strong></div>
            <div v-if="latestMarkdownWorker" class="telemetry-line"><span>Markdown Worker P95</span><strong>{{ formatLatency(latestMarkdownWorker.p95Ms) }}</strong></div>
          </div>
          <div class="latency-band mt-7">
            <div><span>请求 P50</span><strong>{{ formatLatency(operations.requests?.p50Ms) }}</strong></div>
            <div><span>请求 P95</span><strong>{{ formatLatency(operations.requests?.p95Ms) }}</strong></div>
          </div>
        </section>
      </div>

      <div class="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <section class="panel-card cost-panel">
          <div class="section-heading">
            <div>
              <div class="eyebrow">Cost observability</div>
              <h2>Token / TTS 成本</h2>
            </div>
            <Coins class="text-amber-500" :size="21" />
          </div>
          <div class="cost-total">{{ formatCost(totalCost) }}</div>
          <div class="text-xs font-semibold text-slate-500 dark:text-slate-400">累计估算成本 · {{ formatNumber(totalTokens) }} tokens</div>
          <div class="mt-7 grid grid-cols-2 gap-3">
            <div class="cost-tile"><span>LLM</span><strong>{{ formatCost(operations.llm?.estimatedCostCny) }}</strong><small>{{ formatNumber(operations.llm?.total) }} 次调用</small></div>
            <div class="cost-tile"><span>TTS</span><strong>{{ formatCost(operations.tts?.estimatedCostCny) }}</strong><small>{{ formatNumber(operations.tts?.characters) }} 字符</small></div>
          </div>
        </section>

        <section class="panel-card">
          <div class="section-heading">
            <div>
              <div class="eyebrow">Pipeline health</div>
              <h2>RAG 阶段耗时与成功率</h2>
            </div>
            <ArrowUpRight class="text-cyan-500" :size="19" />
          </div>
          <div v-if="stages.length" class="mt-5 overflow-x-auto">
            <table class="stage-table">
              <thead><tr><th>阶段</th><th>调用次数</th><th>成功率</th><th>平均耗时</th></tr></thead>
              <tbody>
                <tr v-for="[name, stage] in stages" :key="name">
                  <td class="font-bold text-slate-700 dark:text-slate-200">{{ name }}</td>
                  <td>{{ formatNumber(stage.total) }}</td>
                  <td><span class="success-pill" :class="stage.failure ? 'is-warn' : ''">{{ stage.successRate }}</span></td>
                  <td class="tabular-nums">{{ formatLatency(stage.avgDurationMs) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="empty-table"><Gauge :size="18" /> 等待线上请求产生阶段样本</div>
        </section>
      </div>

      <section class="panel-card audit-panel">
        <div class="section-heading"><div><div class="eyebrow">High-risk answer review</div><h2>高风险回答审核与知识缺口</h2></div><div class="heading-chip heading-chip-danger"><Flame :size="14" /> {{ riskAudit.highRiskCount }} 条待关注</div></div>
        <div class="mt-6 grid gap-6 xl:grid-cols-[0.72fr_1.28fr]">
          <div><div class="audit-stats"><div><span>学生问题</span><strong>{{ formatNumber(riskAudit.totalQuestions) }}</strong></div><div><span>知识缺口</span><strong>{{ formatNumber(riskAudit.knowledgeGapCount) }}</strong></div></div><div class="mt-5 text-xs font-black uppercase tracking-wider text-slate-400">学生最常问什么</div><div v-if="riskAudit.topTopics.length" class="mt-3 space-y-3"><div v-for="(topic, index) in riskAudit.topTopics" :key="topic.key" class="topic-row"><div class="flex items-center justify-between gap-3 text-sm"><span class="font-bold">{{ index + 1 }}. {{ topic.label }}</span><strong>{{ topic.count }} 次</strong></div><div class="topic-track"><div class="topic-fill" :style="{ width: `${Math.max(10, (topic.count / riskAudit.topTopics[0].count) * 100)}%` }"></div></div><div class="mt-1 text-[10px] font-bold text-slate-400">{{ topic.gaps }} 条可能缺资料</div></div></div><div v-else class="empty-table"><ListChecks :size="18" /> 等待学生问题样本</div></div>
          <div class="audit-list"><div class="mb-3 flex items-center justify-between gap-3"><div class="text-xs font-black uppercase tracking-wider text-slate-400">需要管理员判断</div><span class="text-xs font-bold text-slate-400">高风险 / 资料不足</span></div><div v-if="riskAudit.highRisk.length" class="space-y-3"><article v-for="item in riskAudit.highRisk" :key="item.id" class="audit-item"><div class="flex items-start gap-3"><span class="risk-mark" :class="item.riskLevel === 'high' ? 'risk-mark-high' : 'risk-mark-medium'"><Flame :size="14" /></span><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="topic-tag">{{ item.topic?.label || '综合咨询' }}</span><span class="text-[10px] font-black uppercase tracking-wider text-slate-400">风险 {{ item.riskScore }}</span></div><p class="mt-2 text-sm font-bold leading-6 text-slate-800 dark:text-slate-100">{{ item.question }}</p><div class="mt-2 flex flex-wrap gap-2 text-[10px] font-bold text-slate-400"><span>{{ item.sources?.length ? `${item.sources.length} 个引用` : '无引用来源' }}</span><span>{{ item.knowledgeGap ? '建议补充知识库' : '需人工复核' }}</span></div></div><button v-if="item.knowledgeGap" class="task-button" :disabled="creatingTaskId === item.id" @click="createTask(item)"><FilePlus2 :size="14" />{{ creatingTaskId === item.id ? '创建中' : '建任务' }}</button></div></article></div><div v-else class="empty-table"><ShieldCheck :size="18" /> 当前没有待审核高风险回答</div></div>
        </div>
        <div v-if="riskAudit.tasks.length" class="mt-6 border-t border-slate-100 pt-4 dark:border-slate-800"><div class="text-xs font-black uppercase tracking-wider text-slate-400">最近补充文档任务</div><div class="mt-3 flex flex-wrap gap-2"><span v-for="task in riskAudit.tasks.slice(0, 4)" :key="task.id" class="task-pill"><ListChecks :size="13" />{{ task.title }}</span></div></div>
      </section>

      <section class="panel-card">
        <div class="section-heading">
          <div><div class="eyebrow">RunEvent replay</div><h2>运行事件回放</h2></div>
          <div class="heading-chip"><Activity :size="14" /> 协议审计</div>
        </div>
        <form class="mt-5 flex flex-col gap-2 sm:flex-row" @submit.prevent="loadRunEvents">
          <input v-model="runIdInput" class="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-mono outline-none focus:border-cyan-400 dark:border-slate-700 dark:bg-slate-900" placeholder="输入 runId，例如 run_..." />
          <button type="submit" class="task-button" :disabled="replayLoading || !runIdInput.trim()">{{ replayLoading ? '读取中…' : '加载回放' }}</button>
        </form>
        <p v-if="replayError" class="mt-2 text-xs font-semibold text-rose-600 dark:text-rose-300">{{ replayError }}</p>
        <div v-if="replayRunId" class="mt-5 rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/50">
          <div class="flex items-center justify-between gap-3 text-xs font-bold text-slate-600 dark:text-slate-300"><span class="font-mono">{{ replayRunId }}</span><span>{{ replayEvents.length }} 个事件</span></div>
          <ol v-if="replayEvents.length" class="mt-3 space-y-2">
            <li v-for="event in replayEvents" :key="`${event.attempt}:${event.seq}`" class="rounded-lg border border-slate-100 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
              <div class="flex flex-wrap items-center gap-2 text-[10px] font-bold"><span class="font-mono text-slate-400">#{{ event.seq }}</span><span :class="replayEventTone(event.type)">{{ event.type }}</span><span class="text-slate-400">attempt {{ event.attempt }}</span><span class="ml-auto text-slate-400">{{ formatDate(event.recordedAt) }}</span></div>
              <pre v-if="event.data && Object.keys(event.data).length" class="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all text-[10px] text-slate-500 dark:text-slate-400">{{ JSON.stringify(event.data, null, 2) }}</pre>
            </li>
          </ol>
          <p v-else class="mt-3 text-xs text-slate-400">没有可回放事件。请确认后端已开启 `RUN_EVENT_LOG_ENABLED=true`。</p>
        </div>
      </section>

      <footer class="flex flex-wrap items-center justify-between gap-3 px-1 pb-4 text-xs font-semibold text-slate-400">
        <span>指标口径：离线评测 + 线上请求 + 用户反馈</span>
        <span>仅管理员可见 · 用于运营监控与答辩展示</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.dashboard-shell {
  background: radial-gradient(circle at 12% 0%, rgba(14, 165, 233, 0.08), transparent 28rem), radial-gradient(circle at 92% 18%, rgba(16, 185, 129, 0.07), transparent 25rem), #f5f8fb;
}
.dark .dashboard-shell { background: radial-gradient(circle at 12% 0%, rgba(14, 165, 233, 0.1), transparent 28rem), #070d16; }
.dashboard-hero { isolation: isolate; }
.hero-grid { background-image: linear-gradient(rgba(103, 232, 249, 0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(103, 232, 249, 0.12) 1px, transparent 1px); background-size: 32px 32px; mask-image: linear-gradient(135deg, black, transparent 75%); }
.hero-orb { position: absolute; z-index: -1; border-radius: 999px; filter: blur(2px); }
.hero-orb-one { width: 18rem; height: 18rem; right: 5%; top: -8rem; background: radial-gradient(circle, rgba(34, 211, 238, 0.28), transparent 68%); }
.hero-orb-two { width: 20rem; height: 20rem; right: -8rem; bottom: -12rem; background: radial-gradient(circle, rgba(16, 185, 129, 0.2), transparent 68%); }
.refresh-button { display: inline-flex; align-items: center; gap: 0.5rem; border: 1px solid rgba(165, 243, 252, 0.25); border-radius: 999px; padding: 0.65rem 1rem; background: rgba(255,255,255,0.08); color: white; font-size: 0.75rem; font-weight: 800; transition: all 0.2s; }
.refresh-button:hover:not(:disabled) { background: rgba(255,255,255,0.16); transform: translateY(-1px); }
.refresh-button:disabled { opacity: 0.65; }
.status-dot { width: 0.45rem; height: 0.45rem; display: inline-block; border-radius: 999px; background: #34d399; box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.12), 0 0 12px rgba(52, 211, 153, 0.65); }
.metric-card, .panel-card { border: 1px solid rgba(148,163,184,0.2); background: rgba(255,255,255,0.82); box-shadow: 0 18px 55px rgba(15,23,42,0.06); backdrop-filter: blur(14px); }
.dark .metric-card, .dark .panel-card { border-color: rgba(71,85,105,0.35); background: rgba(15,23,42,0.72); box-shadow: 0 18px 55px rgba(0,0,0,0.18); }
.metric-card { position: relative; overflow: hidden; border-radius: 1.4rem; padding: 1.2rem 1.3rem; }
.metric-card::after { content: ''; position: absolute; right: -2rem; bottom: -3rem; width: 7rem; height: 7rem; border-radius: 999px; opacity: 0.12; }
.metric-card-cyan::after { background: #06b6d4; }.metric-card-emerald::after { background: #10b981; }.metric-card-amber::after { background: #f59e0b; }.metric-card-violet::after { background: #8b5cf6; }
.metric-icon { display:flex; width: 2rem; height: 2rem; align-items:center; justify-content:center; border-radius: 0.7rem; margin-bottom: 1.1rem; }
.metric-card-cyan .metric-icon { color:#0891b2; background:#cffafe; }.metric-card-emerald .metric-icon { color:#059669; background:#d1fae5; }.metric-card-amber .metric-icon { color:#d97706; background:#fef3c7; }.metric-card-violet .metric-icon { color:#7c3aed; background:#ede9fe; }
.dark .metric-icon { opacity: 0.9; }
.metric-label, .eyebrow { color:#64748b; font-size:0.68rem; font-weight:900; letter-spacing:0.12em; text-transform:uppercase; }.dark .metric-label, .dark .eyebrow { color:#94a3b8; }
.metric-value { margin-top:0.35rem; font-size:1.9rem; font-weight:950; letter-spacing:-0.05em; }.metric-foot { margin-top:0.4rem; color:#94a3b8; font-size:0.72rem; font-weight:700; }
.panel-card { border-radius: 1.6rem; padding: 1.35rem; }.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }.section-heading h2 { margin-top:0.3rem; font-size:1.25rem; font-weight:950; letter-spacing:-0.035em; }
.heading-chip { display:inline-flex; align-items:center; gap:0.35rem; border-radius:999px; background:#ecfeff; color:#0e7490; padding:0.4rem 0.65rem; font-size:0.65rem; font-weight:900; }.dark .heading-chip { background:rgba(8,145,178,0.16); color:#67e8f9; }.heading-chip-green { background:#ecfdf5; color:#047857; }.dark .heading-chip-green { background:rgba(16,185,129,0.15); color:#6ee7b7; }
.quality-row { border-radius: 1rem; background:rgba(241,245,249,0.65); padding:0.85rem; }.dark .quality-row { background:rgba(30,41,59,0.52); }.progress-track { height:0.45rem; overflow:hidden; border-radius:999px; background:#e2e8f0; }.dark .progress-track { background:#334155; }.progress-fill { height:100%; border-radius:999px; transition:width 0.5s ease; }.fill-cyan { background:#06b6d4; }.fill-emerald { background:#10b981; }.fill-amber { background:#f59e0b; }.fill-violet { background:#8b5cf6; }
.empty-quality { display:flex; align-items:center; gap:1rem; margin-top:2rem; border:1px dashed #cbd5e1; border-radius:1.2rem; padding:1.3rem; color:#64748b; }.dark .empty-quality { border-color:#475569; color:#94a3b8; }.empty-quality h3 { color:#334155; font-weight:900; }.dark .empty-quality h3 { color:#e2e8f0; }.empty-quality p { margin-top:0.25rem; font-size:0.78rem; line-height:1.5; }.empty-orbit { display:flex; width:3rem; height:3rem; align-items:center; justify-content:center; flex-shrink:0; border-radius:1rem; color:#0891b2; background:#cffafe; }
.telemetry-line { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #f1f5f9; padding-bottom:0.75rem; color:#64748b; font-size:0.82rem; font-weight:700; }.dark .telemetry-line { border-color:#1e293b; color:#94a3b8; }.telemetry-line strong { color:#0f172a; font-size:0.95rem; }.dark .telemetry-line strong { color:#f8fafc; }.latency-band { display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; border-radius:1rem; background:#0f172a; padding:1rem; color:white; }.latency-band div { display:flex; flex-direction:column; gap:0.25rem; }.latency-band span { color:#94a3b8; font-size:0.65rem; font-weight:800; text-transform:uppercase; letter-spacing:0.08em; }.latency-band strong { font-size:1.1rem; }
.cost-panel { background:linear-gradient(145deg, rgba(255,251,235,0.95), rgba(255,255,255,0.82)); }.dark .cost-panel { background:linear-gradient(145deg, rgba(69,45,8,0.34), rgba(15,23,42,0.75)); }.cost-total { margin-top:1.7rem; font-size:2.7rem; font-weight:950; letter-spacing:-0.07em; color:#b45309; }.dark .cost-total { color:#fbbf24; }.cost-tile { display:flex; flex-direction:column; gap:0.3rem; border:1px solid rgba(245,158,11,0.2); border-radius:1rem; background:rgba(255,255,255,0.55); padding:0.85rem; }.dark .cost-tile { background:rgba(30,41,59,0.5); }.cost-tile span { color:#92400e; font-size:0.65rem; font-weight:900; text-transform:uppercase; }.dark .cost-tile span { color:#fcd34d; }.cost-tile strong { font-size:1.1rem; }.cost-tile small { color:#a16207; font-size:0.68rem; font-weight:700; }.dark .cost-tile small { color:#fbbf24; }
.stage-table { width:100%; border-collapse:collapse; min-width:32rem; text-align:left; font-size:0.76rem; }.stage-table th { padding:0.65rem 0.75rem; color:#94a3b8; font-size:0.63rem; font-weight:900; text-transform:uppercase; letter-spacing:0.08em; }.stage-table td { border-top:1px solid #f1f5f9; padding:0.8rem 0.75rem; color:#64748b; font-weight:700; }.dark .stage-table td { border-color:#1e293b; color:#94a3b8; }.success-pill { display:inline-flex; border-radius:999px; background:#dcfce7; color:#15803d; padding:0.25rem 0.5rem; font-size:0.68rem; font-weight:900; }.success-pill.is-warn { background:#fef3c7; color:#b45309; }.dark .success-pill { background:rgba(16,185,129,0.15); color:#6ee7b7; }.dark .success-pill.is-warn { background:rgba(245,158,11,0.15); color:#fcd34d; }.empty-table { display:flex; align-items:center; justify-content:center; gap:0.5rem; min-height:10rem; color:#94a3b8; font-size:0.78rem; font-weight:700; }
.version-panel, .audit-panel { overflow: hidden; }
.version-summary { border-radius: 1.35rem; background: linear-gradient(145deg, #ecfeff, rgba(255,255,255,0.8)); padding: 1.2rem; }.dark .version-summary { background: linear-gradient(145deg, rgba(8,145,178,0.16), rgba(15,23,42,0.8)); }
.version-kicker { color:#0e7490; font-size:0.65rem; font-weight:900; letter-spacing:0.14em; text-transform:uppercase; }.dark .version-kicker { color:#67e8f9; }
.meta-pill, .topic-tag, .neutral-pill, .task-pill { display:inline-flex; align-items:center; gap:0.3rem; border-radius:999px; background:rgba(255,255,255,0.72); padding:0.35rem 0.55rem; }.dark .meta-pill, .dark .topic-tag, .dark .neutral-pill, .dark .task-pill { background:rgba(30,41,59,0.76); }
.recommend-badge { display:inline-flex; align-items:center; gap:0.35rem; border-radius:999px; background:#d1fae5; color:#047857; padding:0.4rem 0.6rem; font-size:0.65rem; font-weight:900; }.dark .recommend-badge { background:rgba(16,185,129,0.18); color:#6ee7b7; }
.decision-stat { border-radius:0.95rem; background:rgba(255,255,255,0.65); padding:0.8rem; }.dark .decision-stat { background:rgba(15,23,42,0.55); }.decision-stat span { display:block; color:#64748b; font-size:0.65rem; font-weight:800; }.decision-stat strong { display:block; margin-top:0.25rem; font-size:1.1rem; }
.comparison-callout { border-left:3px solid #06b6d4; border-radius:0.8rem; background:rgba(255,255,255,0.62); padding:0.8rem; }.dark .comparison-callout { background:rgba(15,23,42,0.52); }
.history-table { width:100%; min-width:40rem; border-collapse:collapse; text-align:left; font-size:0.75rem; }.history-table th { padding:0.75rem 0.85rem; color:#94a3b8; font-size:0.62rem; font-weight:900; letter-spacing:0.08em; text-transform:uppercase; }.history-table td { border-top:1px solid #f1f5f9; padding:0.85rem; color:#64748b; font-weight:700; }.dark .history-table td { border-color:#1e293b; color:#94a3b8; }.neutral-pill { color:#64748b; font-size:0.65rem; font-weight:900; }
.heading-chip-danger { background:#fff1f2; color:#be123c; }.dark .heading-chip-danger { background:rgba(225,29,72,0.15); color:#fda4af; }
.audit-stats { display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; }.audit-stats div { border-radius:1rem; background:#fff7ed; padding:0.9rem; }.dark .audit-stats div { background:rgba(120,53,15,0.18); }.audit-stats span { display:block; color:#9a3412; font-size:0.65rem; font-weight:900; }.dark .audit-stats span { color:#fdba74; }.audit-stats strong { display:block; margin-top:0.3rem; color:#7c2d12; font-size:1.55rem; }.dark .audit-stats strong { color:#fed7aa; }
.topic-row { border-bottom:1px solid #f1f5f9; padding-bottom:0.8rem; }.dark .topic-row { border-color:#1e293b; }.topic-row strong { color:#0891b2; }.topic-track { height:0.38rem; margin-top:0.45rem; overflow:hidden; border-radius:99px; background:#e2e8f0; }.dark .topic-track { background:#334155; }.topic-fill { height:100%; border-radius:99px; background:linear-gradient(90deg, #06b6d4, #10b981); }
.audit-item { border:1px solid #ffe4e6; border-radius:1rem; background:#fffafb; padding:0.8rem; }.dark .audit-item { border-color:rgba(190,24,93,0.28); background:rgba(76,5,25,0.16); }.risk-mark { display:flex; width:2rem; height:2rem; align-items:center; justify-content:center; flex-shrink:0; border-radius:0.7rem; }.risk-mark-high { background:#ffe4e6; color:#e11d48; }.risk-mark-medium { background:#fef3c7; color:#d97706; }.topic-tag { color:#9f1239; font-size:0.65rem; font-weight:900; }.dark .topic-tag { color:#fda4af; }.task-button { display:inline-flex; align-items:center; gap:0.3rem; flex-shrink:0; border-radius:0.7rem; background:#0f172a; padding:0.45rem 0.6rem; color:white; font-size:0.65rem; font-weight:900; transition:transform .2s, background .2s; }.task-button:hover:not(:disabled) { transform:translateY(-1px); background:#0e7490; }.task-button:disabled { opacity:0.6; }.task-pill { color:#0e7490; font-size:0.65rem; font-weight:900; }.dark .task-pill { color:#67e8f9; }
</style>
