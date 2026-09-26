#!/usr/bin/env node
/**
 * 把数据集中硬编码的 legacy docId 迁移到确定性 docId
 *
 * 背景：docId 曾由 crypto.randomUUID() 生成，而 dataset/*.json 的 relevant_doc_ids
 * 直接硬编码了那批 UUID。换成确定性 ID（见 backend/src/utils/doc-id.js）后，
 * 数据集必须同步，否则评测一跑就全是"找不到相关文档"。
 *
 * 用法：
 *   node scripts/rag-eval/migrate-dataset-docids.cjs --check   # 只报告，有需要改动的就退出码 1
 *   node scripts/rag-eval/migrate-dataset-docids.cjs --write   # 实际改写
 *
 * 映射来源只有 corpus-manifest.json（唯一的 legacyId → title/category 记录），
 * 解析不到的 ID 会明确报出来，绝不静默跳过。
 */
const fs = require('fs');
const path = require('path');
const { deriveDocId } = require('../../backend/src/utils/doc-id');

const HERE = __dirname;
const DATASET_DIR = path.join(HERE, 'dataset');
const MANIFEST_PATH = path.join(HERE, 'corpus-manifest.json');

const mode = process.argv.includes('--write') ? 'write' : 'check';

function loadLegacyMap() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`✗ 缺少语料清单: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const map = new Map();
  for (const doc of manifest.docs || []) {
    if (!doc.legacyId) continue;
    // legacyId 兼容字符串与数组（同一文档的多代历史 UUID）
    const ids = Array.isArray(doc.legacyId) ? doc.legacyId : [doc.legacyId];
    for (const id of ids) map.set(id, deriveDocId(doc.title, doc.category));
  }
  return map;
}

/** 递归替换任意层级里的 legacy id 字符串 */
function rewrite(node, legacyMap, stats) {
  if (typeof node === 'string') {
    if (legacyMap.has(node)) {
      stats.replaced += 1;
      return legacyMap.get(node);
    }
    if (/^doc_[0-9a-f-]{36}$/.test(node)) {
      stats.unresolved.add(node);
      return node;
    }
    // 早期 qa.json 用过老 UUID 的 8 位前缀做引用：唯一命中才迁移，歧义或未命中一律报出
    if (/^doc_[0-9a-f]{8}$/.test(node)) {
      const hits = [...legacyMap.keys()].filter((id) => id.startsWith(`${node}-`));
      if (hits.length === 1) {
        stats.replaced += 1;
        stats.prefixResolved += 1;
        return legacyMap.get(hits[0]);
      }
      stats.unresolved.add(node);
      return node;
    }
    return node;
  }
  if (Array.isArray(node)) return node.map(item => rewrite(item, legacyMap, stats));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = rewrite(value, legacyMap, stats);
    return out;
  }
  return node;
}

function main() {
  const legacyMap = loadLegacyMap();
  console.log(`语料清单映射: ${legacyMap.size} 条\n`);

  const files = fs.readdirSync(DATASET_DIR).filter(f => f.endsWith('.json')).sort();
  const unresolvedAll = new Set();
  let totalReplaced = 0;
  let changedFiles = 0;

  for (const file of files) {
    const full = path.join(DATASET_DIR, file);
    const raw = fs.readFileSync(full, 'utf8');
    const data = JSON.parse(raw);
    const stats = { replaced: 0, prefixResolved: 0, unresolved: new Set() };
    const next = rewrite(data, legacyMap, stats);

    stats.unresolved.forEach(id => unresolvedAll.add(id));
    totalReplaced += stats.replaced;

    if (stats.replaced > 0) {
      changedFiles += 1;
      const prefixNote = stats.prefixResolved > 0 ? `（其中 ${stats.prefixResolved} 处经 8 位前缀解析）` : '';
      const note = `  ${file}: 替换 ${stats.replaced} 处${prefixNote}`;
      if (mode === 'write') {
        fs.writeFileSync(full, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        console.log(`${note}  → 已写入`);
      } else {
        console.log(`${note}  → --check 模式未写入`);
      }
    }
  }

  console.log(`\n需要替换 ${totalReplaced} 处，涉及 ${changedFiles} 个文件`);
  if (unresolvedAll.size > 0) {
    console.log(`\n⚠️  以下 ${unresolvedAll.size} 个 docId 在语料清单中找不到映射（数据集引用了当前知识库里不存在的文档）：`);
    for (const id of unresolvedAll) console.log(`   ${id}`);
    console.log('   处理方式：确认这些条目是否还该留在数据集里；若要保留，需先按清单把文档重新入库。');
  }

  if (mode === 'check' && (totalReplaced > 0 || unresolvedAll.size > 0)) process.exit(1);
  if (mode === 'write') console.log('\n✅ 迁移完成，建议随后跑一次评测确认召回正常');
}

main();
