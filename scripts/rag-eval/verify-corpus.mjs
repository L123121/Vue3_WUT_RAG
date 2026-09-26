/**
 * 校验「评测语料清单 ↔ 实际知识库 ↔ 评测数据集」三方是否对齐
 *
 * 为什么需要它：指标可复现的前提是"评测跑在同一个语料上"。此前语料是什么、
 * 数据集引用的文档在不在库里，全靠人记；一旦有人补传了几个文件，召回率的
 * 对比就失去意义，而且不会有任何报错。
 *
 * 用法：
 *   node scripts/rag-eval/verify-corpus.mjs
 *   RAG_EVAL_COOKIE='auth_token=...' node scripts/rag-eval/verify-corpus.mjs
 *
 * 退出码 0 = 三方一致；1 = 存在需要处理的偏差（明细见输出）。
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { checkBackendHealth, listDocuments, BACKEND_URL } from './utils/api-client.js';

const require = createRequire(import.meta.url);
// 复用后端同一份 ID 派生实现，避免脚本与线上算出两套 ID
const { deriveDocId } = require('../../backend/src/utils/doc-id.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = resolve(__dirname, 'dataset');
const MANIFEST_PATH = resolve(__dirname, 'corpus-manifest.json');

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/** 收集数据集里出现的全部 docId */
function collectDatasetDocIds() {
  const found = new Map(); // docId → 出现的文件
  const walk = (node, file) => {
    if (typeof node === 'string') {
      if (/^doc_[0-9a-zA-Z-]+$/.test(node)) {
        if (!found.has(node)) found.set(node, new Set());
        found.get(node).add(file);
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach((item) => walk(item, file));
    if (node && typeof node === 'object') return Object.values(node).forEach((v) => walk(v, file));
  };

  for (const file of readdirSync(DATASET_DIR).filter((f) => f.endsWith('.json'))) {
    walk(JSON.parse(readFileSync(resolve(DATASET_DIR, file), 'utf8')), file);
  }
  return found;
}

async function main() {
  const problems = [];

  const healthy = await checkBackendHealth();
  if (!healthy) {
    console.error(`✗ 后端不可达（${BACKEND_URL}）。本脚本需要读实际知识库，请先启动后端。`);
    process.exit(1);
  }

  const manifest = loadManifest();
  const docs = await listDocuments();
  console.log(`语料清单: ${manifest.docs.length} 篇    知识库实际: ${docs.length} 篇\n`);

  const liveIds = new Set(docs.map((d) => d.id));
  const manifestIds = new Set();

  // ── 方向一：清单里的文档是否都在库里（且 ID 与派生规则一致）──
  let missing = 0;
  for (const entry of manifest.docs) {
    const expected = deriveDocId(entry.title, entry.category);
    manifestIds.add(expected);
    if (!liveIds.has(expected)) {
      missing += 1;
      const legacy = entry.legacyId
        ? `（改造前 ID ${Array.isArray(entry.legacyId) ? entry.legacyId.join(' / ') : entry.legacyId}）`
        : '';
      problems.push(`清单文档缺失: 《${entry.title}》[${entry.category}] 期望 ID ${expected} ${legacy}`);
    }
  }

  // ── 方向二：库里有清单之外的文档 ──
  const extra = docs.filter((d) => !manifestIds.has(d.id));
  if (extra.length > 0) {
    problems.push(
      `知识库存在 ${extra.length} 篇清单外文档——它们会参与检索竞争，使指标无法与基线对比：`
    );
    for (const d of extra) problems.push(`   · 《${d.title}》[${d.category}] ${d.id}`);
  }

  // ── 方向三：数据集引用的文档是否都在库里 ──
  // 区分两类：引用清单内文档（重入库后即对齐，只提示）vs 引用清单外文档（地面真值坏了，算偏差）
  const datasetIds = collectDatasetDocIds();
  const pendingReimport = [...datasetIds.keys()].filter((id) => !liveIds.has(id) && manifestIds.has(id));
  if (pendingReimport.length > 0) {
    console.log(
      `\nℹ️  数据集引用了 ${pendingReimport.length} 篇清单内但暂未入库的文档（按清单重入库后自动对齐，无需改数据集）：`
    );
    for (const id of pendingReimport) {
      console.log(`   · ${id}（出现在 ${[...datasetIds.get(id)].join(', ')}）`);
    }
  }
  for (const [id, files] of datasetIds) {
    if (liveIds.has(id) || manifestIds.has(id)) continue;
    problems.push(`数据集引用了清单与库中都不存在的文档: ${id}（出现在 ${[...files].join(', ')}）`);
  }

  console.log(`清单文档缺失: ${missing}`);
  console.log(`清单外文档: ${extra.length}`);
  console.log(`数据集引用文档: ${datasetIds.size}（其中库中不存在 ${[...datasetIds.keys()].filter((id) => !liveIds.has(id)).length}）`);

  if (problems.length === 0) {
    console.log('\n✅ 三方一致：语料清单、知识库、数据集已对齐，指标具备可比性');
    return;
  }

  console.log('\n✗ 存在偏差：');
  for (const line of problems) console.log(line.startsWith('   ') ? line : `  · ${line}`);
  console.log('\n处理建议：');
  console.log('  1. 清单文档缺失 → 按清单重新入库（标题/类别必须与清单一致，ID 由二者派生）');
  console.log('  2. 存在清单外文档 → 删除这些文档，或确认后把它们补进 corpus-manifest.json 并重跑基线');
  console.log('  3. 数据集引用了不存在的文档 → 修数据集的地面真值，否则该条目恒定判为未召回');
  process.exit(1);
}

main().catch((err) => {
  console.error(`✗ 校验失败: ${err.message}`);
  process.exit(1);
});
