/**
 * 评测数据集与语料清单的**离线**一致性校验（不依赖运行中的后端）
 *
 * 与 verify-corpus.mjs 的分工：
 *   verify-corpus.mjs  —— 三方对齐（清单 ↔ 实际知识库 ↔ 数据集），需要后端可达，
 *                         适合部署前/评测前手动运行；
 *   本脚本             —— 纯文件级校验，CI 每次都跑，堵住"数据集/清单被人改坏
 *                         而无人知晓"这类回归。后端不参与，零网络依赖。
 *
 * 校验内容：
 *   1. corpus-manifest.json 可解析，条目 docId 与 deriveDocId(title, category) 一致
 *      —— 防止手工编辑清单时 ID 与 ID 派生方案脱钩（指标会静默失去可比性）
 *   2. 清单内 docId 无重复、legacyId 格式合法
 *   3. dataset/*.json 全部可解析；其中引用的每个 docId 都能解析到清单
 *      （当前 docId 或 legacyId 别名）——引用清单外的文档意味着该条目的
 *      地面真值已坏，检索指标恒定判为未召回
 *
 * 退出码 0 = 通过；1 = 存在问题（明细见输出）。
 *
 * 用法：npm run eval:dataset-check
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// 复用后端同一份 ID 派生实现，避免脚本与线上算出两套 ID
const { deriveDocId } = require('../../backend/src/utils/doc-id.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = resolve(__dirname, 'dataset');
const MANIFEST_PATH = resolve(__dirname, 'corpus-manifest.json');

const DOC_ID_RE = /^doc_[0-9a-zA-Z-]+$/;

function collectDocIds(node, file, found) {
  if (typeof node === 'string') {
    if (DOC_ID_RE.test(node)) {
      if (!found.has(node)) found.set(node, new Set());
      found.get(node).add(file);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => collectDocIds(item, file, found));
    return;
  }
  if (node && typeof node === 'object') {
    Object.values(node).forEach((value) => collectDocIds(value, file, found));
  }
}

function main() {
  const problems = [];

  // ── 1. 清单自身完整性 ──
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.error(`✗ corpus-manifest.json 无法解析: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(manifest.docs) || manifest.docs.length === 0) {
    console.error('✗ corpus-manifest.json 缺少 docs 数组或为空');
    process.exit(1);
  }

  const manifestIds = new Set();
  const legacyIds = new Set();
  for (const entry of manifest.docs) {
    const label = `《${entry.title}》[${entry.category}]`;
    if (typeof entry.title !== 'string' || !entry.title.trim()) {
      problems.push(`清单条目缺少 title: ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    const derived = deriveDocId(entry.title, entry.category);
    if (entry.docId !== derived) {
      problems.push(`${label} docId 与派生方案不一致: 清单=${entry.docId} 应为=${derived}`);
    }
    if (manifestIds.has(derived)) {
      problems.push(`${label} docId 重复: ${derived}（与另一条目冲突，覆盖语义下二者只能存在一个）`);
    }
    manifestIds.add(derived);
    const legacy = Array.isArray(entry.legacyId) ? entry.legacyId : (entry.legacyId ? [entry.legacyId] : []);
    for (const id of legacy) {
      if (!DOC_ID_RE.test(String(id))) {
        problems.push(`${label} legacyId 格式非法: ${id}`);
      }
      legacyIds.add(String(id));
    }
  }

  // ── 2. 数据集文件可解析 + 引用完整性 ──
  const datasetIds = new Map(); // docId → 出现的文件
  const datasetFiles = readdirSync(DATASET_DIR).filter((f) => f.endsWith('.json'));
  for (const file of datasetFiles) {
    try {
      const json = JSON.parse(readFileSync(resolve(DATASET_DIR, file), 'utf8'));
      collectDocIds(json, file, datasetIds);
    } catch (err) {
      problems.push(`数据集 ${file} 无法解析: ${err.message}`);
    }
  }

  const unresolvable = [...datasetIds.keys()].filter((id) => !manifestIds.has(id) && !legacyIds.has(id));
  for (const id of unresolvable) {
    problems.push(`数据集引用的文档 ${id} 既不在清单 docId 中，也不是任何清单条目的 legacyId 别名（出现在 ${[...datasetIds.get(id)].join(', ')}）`);
  }

  console.log(`清单条目: ${manifest.docs.length}    数据集文件: ${datasetFiles.length}    数据集引用 docId: ${datasetIds.size}`);
  if (problems.length === 0) {
    console.log('✅ 离线校验通过：清单 ID 方案一致、数据集引用全部可解析');
    return;
  }
  console.error(`\n✗ 存在 ${problems.length} 个问题:`);
  for (const line of problems) console.error(`  · ${line}`);
  process.exit(1);
}

main();
