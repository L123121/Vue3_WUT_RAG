"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../../config");
const { logEvent } = require('../observability/observability.service');
const { createObjectStorage, getObjectStorage, normalizeKey } = require('../storage/object-storage.service');

/**
 * ContextCompactionService — Agent 上下文压缩与受控工具工件。
 *
 * 大工具结果写入私有工件目录，上下文只携带短摘录和 opaque artifactId；
 * Agent 需要细节时必须调用 read_tool_artifact，不能访问服务器路径。
 */

const SPILL_EXCERPT_CHARS = 600;
const HARD_CAP_CHARS = 4000;
const DEFAULT_READ_LIMIT = 4000;
const ARTIFACT_ID_RE = /^spill_[a-zA-Z0-9_-]{20,100}$/;
let cleanupTimer = null;

function isEnabled() {
  return config.agent?.contextCompactionEnabled === true;
}

function createArtifactId() {
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : crypto.randomBytes(24).toString("hex");
  return `spill_${id}`;
}

function normalizeOwner(value) {
  return String(value || "").slice(0, 160);
}

function buildMetadata(artifactId, name, text, meta) {
  return {
    artifactId,
    tool: normalizeOwner(name),
    traceId: normalizeOwner(meta.traceId),
    userId: normalizeOwner(meta.userId),
    conversationId: normalizeOwner(meta.conversationId),
    round: Number.isFinite(Number(meta.round)) ? Number(meta.round) : null,
    originalLength: text.length,
    createdAt: new Date().toISOString(),
  };
}

function serializeSpill(metadata, text) {
  return `# 工具结果落盘\n\n<!-- spill-meta:${JSON.stringify(metadata)} -->\n\n---\n\n${text}`;
}

function parseSpill(raw) {
  const match = String(raw || '').match(/<!-- spill-meta:([\s\S]*?) -->/);
  if (!match) return { metadata: {}, content: String(raw || '') };
  let metadata = {};
  try { metadata = JSON.parse(match[1]); } catch { metadata = {}; }
  const delimiter = '\n---\n\n';
  const index = String(raw).indexOf(delimiter);
  return {
    metadata,
    content: index >= 0 ? String(raw).slice(index + delimiter.length) : String(raw || ''),
  };
}

function resolveSpillPath(spillDir, artifactId) {
  if (!spillDir || !ARTIFACT_ID_RE.test(artifactId)) return null;
  const root = path.resolve(spillDir);
  const target = path.resolve(root, `${artifactId}.md`);
  if (path.dirname(target) !== root) return null;
  return target;
}

function artifactObjectKey(artifactId) {
  return normalizeKey(`artifacts/${artifactId}.md`);
}

function artifactStorage(spillDir) {
  // 本地兼容模式沿用 toolSpillDir 作为对象根；S3 模式与附件共享同一 bucket。
  if (config.storage?.backend !== 's3') {
    return createObjectStorage({ backend: 'local', rootDir: spillDir || config.agent?.toolSpillDir || config.storage?.localDir });
  }
  return getObjectStorage();
}

/**
 * L1 大结果落盘。
 * meta: { traceId, userId, conversationId, round, index, spillDir }
 */
async function spillToolResult(name, content, meta = {}) {
  const text = String(content ?? "");
  const threshold = config.agent?.toolResultSpillThreshold || 2000;
  if (!isEnabled() || text.length <= threshold) {
    return { content: text.substring(0, HARD_CAP_CHARS), spilled: false, originalLength: text.length, spillPath: null, artifactId: null };
  }

  const artifactId = createArtifactId();
  const objectKey = artifactObjectKey(artifactId);
  const metadata = buildMetadata(artifactId, name, text, meta);
  let written = false;

  if (objectKey) {
    try {
      await artifactStorage(meta.spillDir).putObject(objectKey, serializeSpill(metadata, text), { contentType: 'text/markdown; charset=utf-8' });
      written = true;
      pruneSpillDir(meta.spillDir).catch(() => {});
    } catch (err) {
      logEvent('warn', 'compaction_tool_result_persist_failed', { error: err.message });
    }
  }

  const excerpt = text.substring(0, SPILL_EXCERPT_CHARS);
  const reference = written
    ? `[完整结果共 ${text.length} 字符，已保存至工件 ${artifactId}；如需细节请调用 read_tool_artifact]`
    : `[结果共 ${text.length} 字符，超出上下文预算，此处仅保留前 ${SPILL_EXCERPT_CHARS} 字符]`;
  return {
    content: `${excerpt}\n\n${reference}`,
    spilled: written,
    originalLength: text.length,
    spillPath: null,
    objectKey: written ? objectKey : null,
    artifactId: written ? artifactId : null,
  };
}

function isOwner(metadata, context = {}) {
  const ownerUserId = normalizeOwner(metadata.userId);
  const ownerConversationId = normalizeOwner(metadata.conversationId);
  const ownerTraceId = normalizeOwner(metadata.traceId);
  const contextUserId = normalizeOwner(context.userId);
  const contextConversationId = normalizeOwner(context.conversationId);
  const contextTraceId = normalizeOwner(context.traceId);

  // 工件缺少最基本的 owner/run 元数据时 fail-closed，不能把“未绑定”解释为公开可读。
  if (!ownerUserId || !ownerTraceId || !contextUserId || !contextTraceId) return false;
  if (ownerUserId !== contextUserId || ownerTraceId !== contextTraceId) return false;
  if (ownerConversationId && ownerConversationId !== contextConversationId) return false;
  return true;
}

/**
 * 读取受控工件，不接受路径，只接受 opaque artifactId。
 * 返回指定字符区间，默认最多 4000 字符。
 */
async function readToolSpill(artifactId, context = {}, options = {}) {
  const id = String(artifactId || '');
  if (!ARTIFACT_ID_RE.test(id)) return { ok: false, content: '工件标识无效', artifactId: null };
  const objectKey = artifactObjectKey(id);
  try {
    const ttl = config.agent?.toolSpillTtlMs || 60 * 60 * 1000;
    let object = await artifactStorage(config.agent?.toolSpillDir).getObject(objectKey);
    // 兼容第一阶段旧本地工件：新工件永远优先从统一对象存储读取。
    if (!object) {
      const legacyPath = resolveSpillPath(config.agent?.toolSpillDir, id);
      if (legacyPath) {
        const stat = await fs.promises.stat(legacyPath).catch(() => null);
        if (stat && stat.isFile()) object = { body: await fs.promises.readFile(legacyPath), lastModified: stat.mtime.toISOString() };
      }
    }
    if (!object) return { ok: false, content: '工件不存在或已清理', artifactId: id };
    if (object.lastModified && Date.now() - new Date(object.lastModified).getTime() > ttl) {
      await artifactStorage(config.agent?.toolSpillDir).deleteObject(objectKey).catch(() => {});
      return { ok: false, content: '工件已过期', artifactId: id };
    }
    const parsed = parseSpill(object.body.toString('utf8'));
    if (!isOwner(parsed.metadata, context)) return { ok: false, content: '无权读取该工件', artifactId: id };
    const full = parsed.content;
    const offset = Math.max(Number.parseInt(options.offset, 10) || 0, 0);
    const limit = Math.min(Math.max(Number.parseInt(options.limit, 10) || DEFAULT_READ_LIMIT, 1), DEFAULT_READ_LIMIT);
    const content = full.slice(offset, offset + limit);
    return {
      ok: true,
      content: content || '(工件该区间为空)',
      artifactId: id,
      offset,
      limit,
      totalChars: full.length,
      hasMore: offset + content.length < full.length,
    };
  } catch (err) {
    logEvent('warn', 'compaction_tool_result_read_failed', { error: err.message });
    return { ok: false, content: '工件读取失败', artifactId: id };
  }
}

/**
 * 按 TTL、最大文件数和总字节数清理工件。
 */
async function pruneSpillDir(spillDir = config.agent?.toolSpillDir) {
  const now = Date.now();
  const ttl = config.agent?.toolSpillTtlMs || 60 * 60 * 1000;
  const maxFiles = config.agent?.toolSpillMaxFiles || 200;
  const maxBytes = config.agent?.toolSpillMaxBytes || 64 * 1024 * 1024;
  const storage = artifactStorage(spillDir);
  const files = await storage.list('artifacts').catch(() => []);
  for (const file of [...files]) {
    const time = new Date(file.lastModified || 0).getTime();
    if (time && now - time > ttl) await storage.deleteObject(file.key).catch(() => {});
  }
  const active = files.filter((file) => {
    const time = new Date(file.lastModified || 0).getTime();
    return !time || now - time <= ttl;
  });
  active.sort((a, b) => new Date(a.lastModified || 0) - new Date(b.lastModified || 0));
  let totalBytes = active.reduce((sum, file) => sum + file.size, 0);
  const toDelete = [];
  while (active.length - toDelete.length > maxFiles || totalBytes > maxBytes) {
    const file = active[toDelete.length];
    if (!file) break;
    toDelete.push(file);
    totalBytes -= file.size;
  }
  await Promise.all(toDelete.map((file) => storage.deleteObject(file.key).catch(() => {})));
}

function startSpillCleanup() {
  if (cleanupTimer || !config.agent?.toolSpillDir) return;
  pruneSpillDir().catch(() => {});
  cleanupTimer = setInterval(() => { pruneSpillDir().catch(() => {}); }, 10 * 60 * 1000);
  cleanupTimer.unref?.();
}

function stopSpillCleanup() {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

function compactHistoricalToolResults(messages, opts = {}) {
  if (!isEnabled()) return { messages, compactedGroups: 0, savedChars: 0 };
  const keepRounds = Math.max(opts.keepRounds ?? config.agent?.toolResultKeepRounds ?? 1, 1);
  if (!Array.isArray(messages)) return { messages, compactedGroups: 0, savedChars: 0 };
  const groups = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    const toolIndexes = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === 'tool') {
      toolIndexes.push(j);
      j += 1;
    }
    if (toolIndexes.length > 0) groups.push({ assistantIndex: i, toolIndexes });
  }
  if (groups.length <= keepRounds) return { messages, compactedGroups: 0, savedChars: 0 };

  const compactGroups = groups.slice(0, groups.length - keepRounds);
  const next = messages.slice();
  let savedChars = 0;
  for (let g = 0; g < compactGroups.length; g += 1) {
    const group = compactGroups[g];
    const nameById = new Map((messages[group.assistantIndex].tool_calls || []).map((tc) => [tc.id, tc.function?.name || 'unknown']));
    for (const index of group.toolIndexes) {
      const message = next[index];
      const original = String(message?.content ?? '');
      if (!original || original.startsWith('[历史工具结果已压缩]')) continue;
      const toolName = nameById.get(message.tool_call_id) || 'unknown';
      const placeholder = `[历史工具结果已压缩] 工具 ${toolName} 的结果（${original.length} 字符）已在第 ${g + 1} 轮被消费，此处省略`;
      next[index] = { ...message, content: placeholder };
      savedChars += Math.max(original.length - placeholder.length, 0);
    }
  }
  return { messages: next, compactedGroups: compactGroups.length, savedChars };
}

module.exports = {
  spillToolResult,
  readToolSpill,
  compactHistoricalToolResults,
  pruneSpillDir,
  startSpillCleanup,
  stopSpillCleanup,
  SPILL_EXCERPT_CHARS,
  HARD_CAP_CHARS,
};
