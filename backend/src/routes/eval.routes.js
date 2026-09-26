const { Router } = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');
const { RagService } = require('../services/rag/rag.service');
const { aiService } = require('../services/llm/ai.service');
const { JudgeService } = require('../services/agent/judge.service');
const { metrics } = require('../services/observability/metrics.service');
const { operationalMetrics } = require('../services/observability/operational-metrics.service');
const { getFeedbackSummary } = require('../controllers/rag.controller');
const { saveEvaluation, getEvaluations, compareEvaluations, importEvaluation, getEvaluationPayload, updateEvaluationScores } = require('../services/agent/quality-governance.service');
const { doubleJudgeStepForRatio, shouldDoubleJudge, computeJudgeAgreement, averageJudgeResults } = require('../services/agent/judge-agreement.service');
const config = require('../config');

const router = Router();

// 评测接口需要登录（消耗 LLM 配额）
router.use(requireAuth);

// 自定义用例上限：防止恶意传超大 testCases 烧光配额
const MAX_EVAL_CASES = 50;

/**
 * GET /api/eval/metrics
 * 获取系统实时指标(仅管理员:指标含全站请求量/延迟等运营数据)
 */
router.get('/metrics', requireAdmin, (req, res) => {
  const summary = metrics.getSummary();
  res.json({ success: true, data: summary });
});

/**
 * POST /api/eval/import
 * 导入离线评测报告（eval-report.json）：聚合入库（source=manual）并持久化完整报告与人工打分
 */
router.post('/import', requireAdmin, async (req, res, next) => {
  try {
    const saved = await importEvaluation(req.body || {});
    res.json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/eval/import
 * 已导入的人工评测列表（轻量记录，payload 走 /:id）
 */
router.get('/import', requireAdmin, async (req, res, next) => {
  try {
    const list = (await getEvaluations()).filter((item) => item.source === 'manual');
    res.json({ success: true, data: list });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/eval/import/:id
 * 取导入报告的完整 payload（results + 人工打分），工作台免上传回放
 */
router.get('/import/:id', requireAdmin, async (req, res, next) => {
  try {
    const payload = await getEvaluationPayload(req.params.id);
    if (!payload) {
      return res.status(404).json({ success: false, error: '评测记录不存在' });
    }
    res.json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/eval/import/:id
 * 回写人工打分（humanScores / comments 整体替换）
 */
router.put('/import/:id', requireAdmin, async (req, res, next) => {
  try {
    const updated = await updateEvaluationScores(req.params.id, req.body || {});
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/eval/run
 * 真实 RAG 评测 — 调用实际 RAG 管道 + LLM-as-judge（独立 Key，不抢生产配额）
 */
router.post('/run', requireAdmin, async (req, res) => {
  const {
    datasetSize = 5,
    enableRag = true,
    datasetVersion = 'campus-qa-v1',
    promptVersion = process.env.RAG_PROMPT_VERSION || 'rag-prompt-v1',
  } = req.body;
  const operationsBefore = operationalMetrics.snapshot();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendLog = (text) => {
    res.write(`data: ${JSON.stringify({ type: 'log', text, timestamp: new Date().toISOString() })}\n\n`);
  };

  sendLog('🎨 [Eval] 初始化评测管道...');

  try {
    const rawCases = Array.isArray(req.body.testCases) ? req.body.testCases : getDefaultTestCases();
    const testCases = rawCases.slice(0, MAX_EVAL_CASES);
    const totalCases = Math.min(datasetSize, testCases.length);

    sendLog(`📦 [Eval] 加载评测数据集: ${totalCases} 条 ground-truth pairs`);

    const ragService = new RagService(aiService);
    const judge = new JudgeService();
    const results = [];

    // 双判抽样：每 step 条抽 1 条复判，量化 judge 一致性（容差 ±0.1）
    const doubleJudgeStep = doubleJudgeStepForRatio(config.judge?.doubleJudgeRatio ?? 0.1);
    if (doubleJudgeStep > 0) {
      sendLog(`⚖️ [Eval] 双判抽样已启用: 每 ${doubleJudgeStep} 条抽 1 条复判`);
    }
    const doubleJudgeStats = { sampled: 0, consistent: 0, inconsistent: 0, judgeFailed: 0, diffSum: 0, diffCount: 0 };

    for (let i = 0; i < totalCases; i++) {
      const tc = testCases[i];
      sendLog(`🔄 [Eval #${i + 1}/${totalCases}] 问题: ${tc.question.substring(0, 30)}...`);

      try {
        // 1. 走 RAG 管道检索并生成回答
        const start = Date.now();
        const ragResult = await ragService.chat(tc.question, [], { enableRag });
        const latency = Date.now() - start;

        const answer = ragResult.reply || ragResult.answer || '';
        const context = (ragResult.sources || []).map(s => s.snippet || s.content || s.text || '').join('\n');

        // 2. LLM-as-judge 评测（独立 Key，不抢生产配额）
        let judgeResult = await judge.evaluate({
          question: tc.question,
          answer,
          context,
          ground_truth: tc.ground_truth,
        });

        // 双判抽样：首判成功才复判；复判降级（关键词匹配）不计入一致率
        let doubleJudge = null;
        if (!judgeResult.error && shouldDoubleJudge(i, doubleJudgeStep)) {
          const second = await judge.evaluate({
            question: tc.question,
            answer,
            context,
            ground_truth: tc.ground_truth,
          });
          const agreement = computeJudgeAgreement(judgeResult, second);
          doubleJudge = {
            metricDiffs: agreement.metricDiffs,
            maxDiff: agreement.maxDiff,
            consistent: agreement.consistent,
          };
          doubleJudgeStats.sampled++;
          if (second.error) {
            doubleJudge.consistent = null;
            doubleJudge.judgeError = second.error;
            doubleJudgeStats.judgeFailed++;
          } else if (agreement.consistent === true) {
            doubleJudgeStats.consistent++;
          } else if (agreement.consistent === false) {
            doubleJudgeStats.inconsistent++;
          }
          if (Number.isFinite(agreement.avgDiff)) {
            doubleJudgeStats.diffSum += agreement.avgDiff;
            doubleJudgeStats.diffCount++;
          }
          judgeResult = averageJudgeResults(judgeResult, second);
          sendLog(`⚖️ [Eval #${i + 1}] 双判复评: maxDiff=${agreement.maxDiff} consistent=${agreement.consistent}`);
        }

        const metrics = {
          faithfulness: judgeResult.faithfulness ?? 0,
          answer_relevancy: judgeResult.answer_relevancy ?? 0,
          context_precision: judgeResult.context_precision ?? 0,
          context_recall: judgeResult.context_recall ?? 0,
          overall: (judgeResult.faithfulness + judgeResult.answer_relevancy + judgeResult.context_precision + judgeResult.context_recall) / 4,
        };

        results.push({
          id: tc.id,
          question: tc.question,
          answer,
          ground_truth: tc.ground_truth,
          context,
          sources: ragResult.sources || [],
          metrics,
          model: ragResult.model || config.ai.model,
          usage: ragResult.usage || null,
          judgeModel: judgeResult.model,
          judgeLatency: judgeResult.latency,
          latency,
          reason: judgeResult.reason || '',
          ...(doubleJudge ? { doubleJudge } : {}),
        });

        sendLog(`✔️ [Eval #${i + 1}] faithful=${(metrics.faithfulness * 100).toFixed(0)}% ` +
                `relevancy=${(metrics.answer_relevancy * 100).toFixed(0)}% ` +
                `recall=${(metrics.context_recall * 100).toFixed(0)}% ` +
                `(${latency}ms, judge=${judgeResult.model})`);
      } catch (err) {
        sendLog(`❌ [Eval #${i + 1}] 失败: ${err.message}`);
        results.push({
          id: tc.id,
          question: tc.question,
          answer: `[错误: ${err.message}]`,
          ground_truth: tc.ground_truth,
          metrics: { faithfulness: 0, answer_relevancy: 0, context_precision: 0, context_recall: 0, overall: 0 },
          latency: 0,
          error: err.message,
        });
      }
    }

    // 计算总体平均分
    const validMetrics = results.filter(r => r.metrics && r.metrics.overall > 0);
    const overallScore = validMetrics.length > 0
      ? validMetrics.reduce((s, r) => s + r.metrics.overall, 0) / validMetrics.length
      : 0;

    const avgLatency = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.latency, 0) / results.length)
      : 0;

    sendLog(`📊 [Eval] 汇总: ${results.length} 条, 平均延迟 ${avgLatency}ms, 综合得分 ${(overallScore * 100).toFixed(0)}%`);

    const avgMetrics = validMetrics.length > 0 ? {
      faithfulness: validMetrics.reduce((s, r) => s + r.metrics.faithfulness, 0) / validMetrics.length,
      answer_relevancy: validMetrics.reduce((s, r) => s + r.metrics.answer_relevancy, 0) / validMetrics.length,
      context_precision: validMetrics.reduce((s, r) => s + r.metrics.context_precision, 0) / validMetrics.length,
      context_recall: validMetrics.reduce((s, r) => s + r.metrics.context_recall, 0) / validMetrics.length,
    } : null;

    const citationCoverage = results.length > 0
      ? results.filter((result) => Array.isArray(result.sources) && result.sources.length > 0).length / results.length
      : 0;

    // 双判一致性汇总（judge 稳定性的量化证据，随评测结果返回）
    const judged = doubleJudgeStats.consistent + doubleJudgeStats.inconsistent;
    const doubleJudgeSummary = doubleJudgeStats.sampled > 0 ? {
      sampled: doubleJudgeStats.sampled,
      consistent: doubleJudgeStats.consistent,
      inconsistent: doubleJudgeStats.inconsistent,
      judgeFailed: doubleJudgeStats.judgeFailed,
      agreementRate: judged > 0 ? Math.round((doubleJudgeStats.consistent / judged) * 1000) / 10 : null,
      avgMetricDiff: doubleJudgeStats.diffCount > 0
        ? Math.round((doubleJudgeStats.diffSum / doubleJudgeStats.diffCount) * 10000) / 10000
        : null,
    } : null;
    if (doubleJudgeSummary) {
      sendLog(`⚖️ [Eval] 双判汇总: ${doubleJudgeStats.sampled} 条抽判, 一致 ${doubleJudgeStats.consistent}/` +
              `不一致 ${doubleJudgeStats.inconsistent}, 一致率 ${doubleJudgeSummary.agreementRate}%`);
    }

    const feedback = await getFeedbackSummary();
    const operationsAfter = operationalMetrics.snapshot();
    const costCny = Math.max(0, Number(operationsAfter.llm?.estimatedCostCny || 0) - Number(operationsBefore.llm?.estimatedCostCny || 0));
    const evaluation = await saveEvaluation({
      datasetVersion,
      model: results.find((result) => result.model)?.model || config.ai.model,
      promptVersion,
      metrics: avgMetrics ? { ...avgMetrics, overall: overallScore } : null,
      avgLatency,
      costCny,
      satisfactionRate: feedback.satisfactionRate === null ? null : feedback.satisfactionRate / 100,
      citationCoverage,
      sampleCount: results.length,
    });
    const comparison = compareEvaluations(await getEvaluations());

    metrics.recordEvaluation({
      metrics: avgMetrics ? { ...avgMetrics, overall: overallScore } : null,
      avgLatency,
      sampleCount: results.length,
    });

    res.write(`data: ${JSON.stringify({
      type: 'done',
      overallScore,
      avgLatency,
      metrics: avgMetrics,
      evaluation,
      comparison,
      costCny,
      doubleJudge: doubleJudgeSummary,
      results,
    })}\n\n`);

    res.end();
  } catch (err) {
    sendLog(`❌ [Eval] 评测管道异常: ${err.message}`);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  }
});

/**
 * 默认评测数据集
 */
function getDefaultTestCases() {
  return [
    {
      id: 't001',
      question: '武汉理工大学有哪些校区？',
      category: 'campus',
      difficulty: 'easy',
      ground_truth: '武汉理工大学有三个校区：马房山校区、余家头校区和南湖校区。马房山校区位于武汉市洪山区珞狮路，余家头校区位于武汉市武昌区和平大道，南湖校区位于武汉市洪山区南湖大道。'
    },
    {
      id: 't002',
      question: '如何查询我的成绩？',
      category: 'academic',
      difficulty: 'easy',
      ground_truth: '可以通过教务系统查询成绩，登录后在成绩查询页面可以看到各科成绩、学分、绩点等信息。'
    },
    {
      id: 't003',
      question: '学校的转专业政策是什么？',
      category: 'academic',
      difficulty: 'medium',
      ground_truth: '转专业通常在大一下学期或大二上学期申请，需要满足一定的成绩要求（如GPA达到指定标准），并通过转入学院的考核。具体政策以当年教务处的通知为准。'
    },
    {
      id: 't004',
      question: '武汉理工大学的图书馆开放时间是怎样的？',
      category: 'campus',
      difficulty: 'easy',
      ground_truth: '图书馆的开放时间通常为早上8点到晚上10点，考试周可能会延长至晚上11点。具体开放时间可在图书馆官网或门口公告查看。'
    },
    {
      id: 't005',
      question: '如何申请休学？',
      category: 'academic',
      difficulty: 'medium',
      ground_truth: '休学需要向所在学院提交书面申请，说明休学原因和期限，经学院审核同意后报教务处备案。休学期限一般不超过一年，期满需及时申请复学。'
    },
  ];
}

module.exports = router;
