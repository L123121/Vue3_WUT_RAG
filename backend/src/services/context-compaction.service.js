"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { logEvent } = require('./observability.service');

/**
 * ContextCompactionService — Agent 上下文压缩分层（借鉴 AgentHarness 四层压缩中的两层）
 *
 * 背景：agent 链路把 search_knowledge_base 的检索结果（单条可达数千字符）以
 * tool 角色消息回注上下文，多轮工具调度后这是最大的 token 膨胀源。
 *
 * L1 大结果落盘（spill）：单条 tool result 超过 spillThreshold 时，完整内容写入
 *    data/tool-spills/，上下文中只保留头部摘要 + 文件引用。保留 4000 字符硬上限兜底。
 * L2 历史 tool result 替换：多轮工具调度中仅保留最近 keepRounds 轮完整 tool 消息，
 *    更早轮次替换为短占位符——该结果已在当时轮次被 LLM 消费，后续轮次只需知道
 *    "调过这个工具、命中过什么"，不再需要原文。
 *
 * 两层均为纯函数/幂等落盘，失败静默降级为原截断逻辑，不影响主链路。
 */

// 落盘后上下文中保留的头部摘要长度（字符）
const SPILL_EXCERPT_CHARS = 600;
// 单条 tool 消息最终硬上限（兜底，与压缩前行为一致）
const HARD_CAP_CHARS = 4000;

function isEnabled() {
  return config.agent?.contextCompactionEnabled === true;
}

/**
 * 安全文件名：traceId/工具名只保留字母数字与短横线，避免路径注入
 */
function safeSegment(value, fallback = "x") {
  const s = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return s || fallback;
}

/**
 * L1 大结果落盘
 *
 * @param {string} name - 工具名
 * @param {string} content - 工具结果原文
 * @param {Object} meta - { traceId, round, index, spillDir }
 * @returns {Promise<{ content: string, spilled: boolean, originalLength: number, spillPath: string|null }>}
 */
async function spillToolResult(name, content, meta = {}) {
  const text = String(content ?? "");
  const threshold = config.agent?.toolResultSpillThreshold || 2000;
  if (!isEnabled() || text.length <= threshold) {
    return { content: text.substring(0, HARD_CAP_CHARS), spilled: false, originalLength: text.length, spillPath: null };
  }

  const spillDir = meta.spillDir || config.agent?.toolSpillDir;
  const fileName = `${safeSegment(meta.traceId, "trace")}-r${meta.round ?? 0}-t${meta.index ?? 0}-${safeSegment(name, "tool")}.md`;
  const spillPath = spillDir ? path.join(spillDir, fileName) : null;

  // 落盘失败静默降级为硬截断，不影响主链路
  let written = false;
  if (spillPath) {
    try {
      await fs.promises.mkdir(spillDir, { recursive: true });
      const header = `# 工具结果落盘\n\n- 工具: ${name}\n- traceId: ${meta.traceId || "-"}\n- 轮次: ${meta.round ?? "-"}\n- 原始长度: ${text.length} 字符\n- 时间: ${new Date().toISOString()}\n\n---\n\n`;
      await fs.promises.writeFile(spillPath, header + text, "utf8");
      written = true;
      pruneSpillDir(spillDir).catch(() => {});
    } catch (err) {
      logEvent('warn', 'compaction_tool_result_persist_failed', { error: err.message });
    }
  }

  const excerpt = text.substring(0, SPILL_EXCERPT_CHARS);
  const reference = written
    ? `[完整结果共 ${text.length} 字符，已保存至 ${spillPath}，如需细节可读取该文件]`
    : `[结果共 ${text.length} 字符，超出上下文预算，此处仅保留前 ${SPILL_EXCERPT_CHARS} 字符]`;
  return {
    content: `${excerpt}\n\n${reference}`,
    spilled: written,
    originalLength: text.length,
    spillPath: written ? spillPath : null,
  };
}

/**
 * 落盘目录保留策略：超过 maxFiles 时按修改时间删除最旧文件（fire-and-forget）
 */
async function pruneSpillDir(spillDir) {
  const maxFiles = config.agent?.toolSpillMaxFiles || 200;
  const entries = await fs.promises.readdir(spillDir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const full = path.join(spillDir, e.name);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (stat) files.push({ full, mtimeMs: stat.mtimeMs });
  }
  if (files.length <= maxFiles) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toDelete = files.slice(0, files.length - maxFiles);
  await Promise.all(toDelete.map((f) => fs.promises.unlink(f.full).catch(() => {})));
}

/**
 * L2 历史 tool result 替换（纯函数）
 *
 * messages 中的"工具组" = 一条带 tool_calls 的 assistant 消息 + 其后连续的 tool 消息。
 * 仅保留最近 keepRounds 组完整内容，更早组的 tool 消息替换为占位符。
 *
 * @param {Array} messages - OpenAI 格式消息数组
 * @param {Object} opts - { keepRounds }
 * @returns {{ messages: Array, compactedGroups: number, savedChars: number }}
 */
function compactHistoricalToolResults(messages, opts = {}) {
  if (!isEnabled()) return { messages, compactedGroups: 0, savedChars: 0 };
  const keepRounds = Math.max(opts.keepRounds ?? config.agent?.toolResultKeepRounds ?? 1, 1);
  if (!Array.isArray(messages)) return { messages, compactedGroups: 0, savedChars: 0 };

  // 1) 定位工具组：assistant(tool_calls) 之后连续的 tool 消息下标区间
  const groups = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const toolIndexes = [];
      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "tool") {
        toolIndexes.push(j);
        j++;
      }
      if (toolIndexes.length > 0) groups.push({ assistantIndex: i, toolIndexes });
    }
  }

  if (groups.length <= keepRounds) return { messages, compactedGroups: 0, savedChars: 0 };

  // 2) 除最近 keepRounds 组外，其余组的 tool 消息替换为占位符
  const compactGroups = groups.slice(0, groups.length - keepRounds);
  const next = messages.slice();
  let savedChars = 0;

  for (let g = 0; g < compactGroups.length; g++) {
    const group = compactGroups[g];
    // tool_call_id → 工具名（从该组 assistant 消息的 tool_calls 建立映射）
    const nameById = new Map(
      (messages[group.assistantIndex].tool_calls || []).map((tc) => [tc.id, tc.function?.name || "unknown"])
    );
    for (const idx of group.toolIndexes) {
      const msg = next[idx];
      const original = String(msg?.content ?? "");
      if (!original || original.startsWith("[历史工具结果已压缩]")) continue;
      const toolName = nameById.get(msg.tool_call_id) || "unknown";
      const placeholder = `[历史工具结果已压缩] 工具 ${toolName} 的结果（${original.length} 字符）已在第 ${g + 1} 轮被消费，此处省略`;
      next[idx] = { ...msg, content: placeholder };
      savedChars += Math.max(original.length - placeholder.length, 0);
    }
  }

  return { messages: next, compactedGroups: compactGroups.length, savedChars };
}

module.exports = {
  spillToolResult,
  compactHistoricalToolResults,
  pruneSpillDir,
  SPILL_EXCERPT_CHARS,
  HARD_CAP_CHARS,
};
