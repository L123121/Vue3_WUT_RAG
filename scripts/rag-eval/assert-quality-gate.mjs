import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateQualityGate } from './quality-gate.mjs';

const inputPath = resolve(process.argv[2] || process.env.RAG_EVAL_RESULT || 'backend/scripts/rag-eval/results/quality-report.json');
const raw = JSON.parse(readFileSync(inputPath, 'utf8'));
const baseline = process.env.RAG_GATE_BASELINE ? JSON.parse(readFileSync(resolve(process.env.RAG_GATE_BASELINE), 'utf8')) : null;
const result = evaluateQualityGate(raw, { ...process.env, baseline });

console.log(`[RAG quality gate] result=${inputPath}`);
if (!result.passed) {
  result.failures.forEach((failure) => console.error(`[RAG quality gate] FAIL: ${failure}`));
  process.exit(1);
}
console.log('[RAG quality gate] PASS');
