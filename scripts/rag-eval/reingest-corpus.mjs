/**
 * 语料重入库：按 corpus-manifest.json 把 ragdata 源文件重建为确定性 ID 文档
 *
 * 背景：知识库现存文档全部是改造前的随机 UUID 世代，而数据集 relevant_doc_ids
 * 已统一到确定性 ID（doc_<sha256(title\0category)[0:32]>）。重新入库（标题/类别
 * 与清单一致）即可让库、清单、数据集三方对齐，评测指标恢复可比性。
 *
 * 与 upload-ragdata.js 的区别：那个脚本"猜分类、全量上传"，本脚本以清单为
 * 唯一事实来源——标题、类别精确取自清单（不再猜测），旧世代文档先删后传，
 * 避免 sha256 内容去重把新上传映射回旧 UUID 文档。
 *
 * 用法：
 *   node scripts/rag-eval/reingest-corpus.mjs                 # 演练：只打印计划
 *   node scripts/rag-eval/reingest-corpus.mjs --write         # 执行：删旧档+入库
 *   node scripts/rag-eval/reingest-corpus.mjs --write --prune # 额外删除清单外文档
 *   node scripts/rag-eval/reingest-corpus.mjs --write --force # 已对齐文档也重新上传
 *
 * 认证：优先 RAG_EVAL_COOKIE；否则用 backend/.env 的 JWT_SECRET 铸 admin JWT。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createRequire } from 'module';
import { checkBackendHealth, BACKEND_URL } from './utils/api-client.js';

const require = createRequire(import.meta.url);
// 复用后端同一份 ID 派生实现，保证脚本与线上算出同一套 ID
const { deriveDocId } = require('../../backend/src/utils/doc-id.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, 'corpus-manifest.json');
const RAGDATA_DIR = resolve(__dirname, '../../ragdata');
const SUPPORTED_EXT = ['.md', '.docx', '.pptx', '.txt', '.pdf'];
const LIST_LIMIT = 500;

const WRITE = process.argv.includes('--write');
const PRUNE = process.argv.includes('--prune');
const FORCE = process.argv.includes('--force');

// ── 认证 ────────────────────────────────────────────────────────────────

function mintAdminCookie() {
  const secretEnv = resolve(__dirname, '../../backend/.env');
  const secret =
    process.env.JWT_SECRET ||
    (existsSync(secretEnv) && readFileSync(secretEnv, 'utf8').match(/^JWT_SECRET=(.+)$/m)?.[1].trim());
  if (!secret) return '';
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ userId: 'admin', username: 'admin', role: 'admin', iat: now, exp: now + 3600 });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `auth_token=${header}.${payload}.${sig}`;
}

function getCookie() {
  return process.env.RAG_EVAL_COOKIE || process.env.EVAL_COOKIE || mintAdminCookie();
}

async function apiFetch(path, options = {}) {
  const cookie = getCookie();
  if (!cookie) throw new Error('缺少认证：设置 RAG_EVAL_COOKIE，或在 backend/.env 配置 JWT_SECRET');
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: { Cookie: cookie, ...(options.headers || {}) },
  });
  return response;
}

// ── 清单 ↔ ragdata 映射 ─────────────────────────────────────────────────

/** 与 upload-ragdata.js 相同的标题归一化：剥书名号/括号 + trim */
function normalizeTitle(name) {
  return name.replace(/[()（）《》]/g, '').trim();
}

/** 递归收集 ragdata 下全部受支持文件 */
function collectRagdataFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const fp = resolve(dir, entry);
      if (statSync(fp).isDirectory()) walk(fp);
      else if (SUPPORTED_EXT.includes(extname(fp).toLowerCase())) files.push(fp);
    }
  };
  walk(RAGDATA_DIR);
  return files;
}

function buildFileIndex() {
  const index = new Map(); // normalizeTitle(basename) → 文件路径
  for (const fp of collectRagdataFiles()) {
    const key = normalizeTitle(basename(fp, extname(fp)));
    if (index.has(key)) console.warn(`⚠️  ragdata 存在同名文件（后者被忽略）: ${index.get(key)} / ${fp}`);
    else index.set(key, fp);
  }
  return index;
}

// ── 知识库 API ──────────────────────────────────────────────────────────

async function listAllDocuments() {
  const response = await apiFetch(`/api/rag/documents?page=1&limit=${LIST_LIMIT}`);
  if (!response.ok) throw new Error(`获取文档列表失败: ${response.status}`);
  const result = await response.json();
  return result.data?.documents || [];
}

async function deleteDocument(id) {
  const response = await apiFetch(`/api/rag/documents/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`删除失败 ${response.status}: ${text.substring(0, 150)}`);
  }
}

async function uploadFile(filePath, title, category) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)]), basename(filePath));
  form.append('title', title);
  form.append('category', category);
  const response = await apiFetch('/api/rag/documents/upload', { method: 'POST', body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    throw new Error(`上传失败 ${response.status}: ${(result.message || JSON.stringify(result)).substring(0, 150)}`);
  }
  return result.data;
}

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main() {
  if (!WRITE) console.log('（演练模式：只打印计划，加 --write 执行）\n');

  const healthy = await checkBackendHealth();
  if (!healthy) {
    console.error(`✗ 后端不可达（${BACKEND_URL}）。请先启动后端与 Qdrant：docker compose -p wuli-elf up -d qdrant && npm start`);
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const fileIndex = buildFileIndex();
  const docs = await listAllDocuments();
  const docsById = new Map(docs.map((d) => [d.id, d]));

  // ── 预检：清单条目必须能映射到 ragdata 源文件 ──
  const entries = [];
  const preflightErrors = [];
  for (const entry of manifest.docs) {
    const expectedId = deriveDocId(entry.title, entry.category);
    const file = fileIndex.get(entry.title);
    if (!file) {
      preflightErrors.push(`清单文档找不到 ragdata 源文件: 《${entry.title}》[${entry.category}]（期望文件名去括号后为"${entry.title}"）`);
      continue;
    }
    const legacyIds = Array.isArray(entry.legacyId) ? entry.legacyId : entry.legacyId ? [entry.legacyId] : [];
    // 待删旧档：已存在确定性 ID 文档视为对齐（除非 --force）；legacyId 或同名不同 ID 视为旧世代
    const staleDocs = docs.filter(
      (d) => d.id !== expectedId && (legacyIds.includes(d.id) || normalizeTitle(d.title) === entry.title)
    );
    entries.push({ entry, expectedId, file, staleDocs, aligned: docsById.has(expectedId) });
  }
  if (preflightErrors.length > 0) {
    console.error('✗ 预检失败：');
    for (const line of preflightErrors) console.error(`  · ${line}`);
    process.exit(1);
  }

  // ── 计划 ──
  const aligned = entries.filter((e) => e.aligned && !FORCE);
  const toReingest = entries.filter((e) => !e.aligned || FORCE);
  const outOfManifest = docs.filter((d) => !manifest.docs.some((e) => deriveDocId(e.title, e.category) === d.id));

  console.log(`清单: ${manifest.docs.length} 篇    知识库: ${docs.length} 篇    ragdata 源文件: ${fileIndex.size} 个\n`);
  console.log(`已对齐（跳过${FORCE ? '，--force 将重建' : ''}）: ${aligned.length}`);
  for (const e of aligned) console.log(`  ✓ ${e.entry.id === e.expectedId ? '' : ''}《${e.entry.title}》[${e.entry.category}] ${e.expectedId}`);

  console.log(`\n待重入库: ${toReingest.length}`);
  for (const e of toReingest) {
    console.log(`  《${e.entry.title}》[${e.entry.category}] → ${e.expectedId}`);
    console.log(`     源文件: ${e.file.replace(RAGDATA_DIR, 'ragdata')}`);
    for (const d of e.staleDocs) console.log(`     删旧档: ${d.id}（${d.title}）`);
  }

  console.log(`\n清单外文档: ${outOfManifest.length}${PRUNE && WRITE ? '（--prune 将删除）' : '（仅报告；确认后补进清单或加 --prune 删除）'}`);
  for (const d of outOfManifest) console.log(`  · 《${d.title}》[${d.category}] ${d.id}`);

  if (!WRITE) {
    console.log('\n演练结束。确认无误后执行: node scripts/rag-eval/reingest-corpus.mjs --write');
    return;
  }

  // ── 执行 ──
  let ok = 0;
  const failures = [];
  for (const e of toReingest) {
    const label = `《${e.entry.title}》`;
    try {
      // 先删旧档再上传：内容去重（sha256）否则会把新上传映射回旧 UUID 文档
      for (const d of e.staleDocs) {
        await deleteDocument(d.id);
        console.log(`  🗑  ${d.id}（${d.title}）`);
      }
      const data = await uploadFile(e.file, e.entry.title, e.entry.category);
      const newId = data?.id || '?';
      if (newId !== e.expectedId) {
        throw new Error(`入库 ID 不符: 得到 ${newId}，期望 ${e.expectedId}（检查标题/类别是否与清单完全一致）`);
      }
      console.log(`  ✅ ${label} id=${newId} chunks=${data?.chunkCount ?? '?'}`);
      ok += 1;
    } catch (err) {
      console.error(`  ❌ ${label}: ${err.message}`);
      failures.push({ title: e.entry.title, error: err.message });
    }
  }

  if (PRUNE) {
    for (const d of outOfManifest) {
      try {
        await deleteDocument(d.id);
        console.log(`  🗑 清单外: ${d.id}（${d.title}）`);
      } catch (err) {
        console.error(`  ❌ 清单外删除失败 ${d.id}: ${err.message}`);
        failures.push({ title: d.title, error: err.message });
      }
    }
  }

  console.log(`\n入库完成: ${ok}/${toReingest.length}${failures.length ? `，失败 ${failures.length}` : ''}`);
  console.log('⏳ 等待向量索引写入缓冲 (10s)…');
  await new Promise((r) => setTimeout(r, 10000));

  // ── 终检：与 verify-corpus 同口径的三方对齐摘要 ──
  const finalDocs = await listAllDocuments();
  const finalIds = new Set(finalDocs.map((d) => d.id));
  const manifestIds = new Set(manifest.docs.map((e) => deriveDocId(e.title, e.category)));
  const missing = [...manifestIds].filter((id) => !finalIds.has(id));
  const extra = finalDocs.filter((d) => !manifestIds.has(d.id));

  if (missing.length === 0 && extra.length === 0) {
    console.log('\n✅ 三方对齐：清单、知识库、数据集一致。可运行 npm run eval:rag-baseline 复现基线。');
  } else {
    console.log(`\n✗ 仍未对齐：清单缺失 ${missing.length} 篇，清单外 ${extra.length} 篇。运行 npm run eval:corpus-check 查看明细。`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`✗ 重入库失败: ${err.message}`);
  process.exit(1);
});
