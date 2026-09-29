export const QUALITY_GATE_RULES = [
  ['recall@5', 'RAG_GATE_MIN_RECALL5'],
  ['faithfulness', 'RAG_GATE_MIN_FAITHFULNESS'],
  ['answer_relevancy', 'RAG_GATE_MIN_ANSWER_RELEVANCY'],
  ['context_precision', 'RAG_GATE_MIN_CONTEXT_PRECISION'],
  ['context_recall', 'RAG_GATE_MIN_CONTEXT_RECALL'],
];

function metricsOf(report = {}) {
  return report.aggregate || report.metrics || report.overall || report;
}

function finiteNumber(value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function evaluateQualityGate(report, env = {}) {
  const aggregate = metricsOf(report);
  const failures = [];
  const checked = [];

  for (const [name, envName] of QUALITY_GATE_RULES) {
    const thresholdValue = env[envName];
    if (thresholdValue === undefined || thresholdValue === '') continue;
    const threshold = finiteNumber(thresholdValue);
    const actual = finiteNumber(aggregate[name]);
    if (threshold === null) throw new Error(`无效门禁阈值: ${name}=${thresholdValue}`);
    checked.push({ name, actual, threshold });
    if (actual === null) {
      failures.push(`${name} 缺失`);
    } else if (actual < threshold) {
      failures.push(`${name}=${actual.toFixed(4)} < ${threshold.toFixed(4)}`);
    }
  }

  const maxRegression = finiteNumber(env.RAG_GATE_MAX_REGRESSION);
  if (env.baseline && maxRegression !== null) {
    const baselineMetrics = metricsOf(env.baseline);
    for (const [name] of QUALITY_GATE_RULES) {
      const actual = finiteNumber(aggregate[name]);
      const previous = finiteNumber(baselineMetrics[name]);
      if (actual !== null && previous !== null && previous - actual > maxRegression) {
        failures.push(`${name} 回归 ${(previous - actual).toFixed(4)} > ${maxRegression.toFixed(4)}`);
      }
    }
  }

  return { passed: failures.length === 0, failures, checked };
}
