import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/config");
const {
  spillToolResult,
  readToolSpill,
  compactHistoricalToolResults,
  SPILL_EXCERPT_CHARS,
} = require("../src/services/context-compaction.service");

describe("ContextCompactionService", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-spills-"));
    config.agent.contextCompactionEnabled = true;
    config.agent.toolResultSpillThreshold = 2000;
    config.agent.toolResultKeepRounds = 1;
    config.agent.toolSpillDir = tmpDir;
    config.agent.toolSpillTtlMs = 60 * 60 * 1000;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("L1 大结果落盘（spillToolResult）", () => {
    it("低于阈值时不落盘，原样返回", async () => {
      const r = await spillToolResult("calculate", "42", { spillDir: tmpDir });
      expect(r.spilled).toBe(false);
      expect(r.content).toBe("42");
      expect(fs.readdirSync(tmpDir).length).toBe(0);
    });

    it("超过阈值时落盘并返回摘要+引用", async () => {
      const big = "检索内容".repeat(1000); // 4000 字符
      const r = await spillToolResult("search_knowledge_base", big, {
        traceId: "trace_abc",
        userId: 'user-1',
        conversationId: 'conv-1',
        round: 1,
        index: 0,
        spillDir: tmpDir,
      });
      expect(r.spilled).toBe(true);
      expect(r.originalLength).toBe(4000);
      expect(r.content.length).toBeLessThan(1000);
      expect(r.content).toContain("已保存至");
      // 完整内容确实写入磁盘
      const files = fs.readdirSync(tmpDir);
      expect(files.length).toBe(1);
      const onDisk = fs.readFileSync(path.join(tmpDir, files[0]), "utf8");
      expect(onDisk).toContain(big.substring(0, 100));
      expect(onDisk).toContain("search_knowledge_base");
      const read = await readToolSpill(r.artifactId, {
        userId: 'user-1',
        conversationId: 'conv-1',
        traceId: 'trace_abc',
      }, { offset: 100, limit: 80 });
      expect(read.ok).toBe(true);
      expect(read.content).toBe(big.substring(100, 180));
      const denied = await readToolSpill(r.artifactId, {
        userId: 'other-user',
        conversationId: 'conv-1',
        traceId: 'trace_abc',
      });
      expect(denied.ok).toBe(false);
      const missingRun = await readToolSpill(r.artifactId, {
        userId: 'user-1',
        conversationId: 'conv-1',
      });
      expect(missingRun.ok).toBe(false);
    });

    it("落盘摘要保留头部内容", async () => {
      const head = "头部摘要内容";
      const big = head + "x".repeat(5000);
      const r = await spillToolResult("search_knowledge_base", big, { spillDir: tmpDir });
      expect(r.content.startsWith(head)).toBe(true);
      expect(r.content.length).toBeLessThanOrEqual(SPILL_EXCERPT_CHARS + 200);
    });

    it("开关关闭时硬截断到 4000 字符", async () => {
      config.agent.contextCompactionEnabled = false;
      const big = "y".repeat(6000);
      const r = await spillToolResult("search_knowledge_base", big, { spillDir: tmpDir });
      expect(r.spilled).toBe(false);
      expect(r.content.length).toBe(4000);
      expect(fs.readdirSync(tmpDir).length).toBe(0);
    });

    it("文件名过滤非法字符（路径注入防护）", async () => {
      const big = "z".repeat(3000);
      const r = await spillToolResult("search", big, {
        traceId: "../../etc/passwd",
        spillDir: tmpDir,
      });
      expect(r.spilled).toBe(true);
      const files = fs.readdirSync(tmpDir);
      expect(files.length).toBe(1);
      expect(files[0]).not.toContain("..");
      expect(files[0]).not.toContain("/");
    });
  });

  describe("L2 历史 tool result 替换（compactHistoricalToolResults）", () => {
    function buildMessages(rounds) {
      const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "问题" }];
      for (let i = 1; i <= rounds; i++) {
        msgs.push({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: `call_${i}`, type: "function", function: { name: "search_knowledge_base", arguments: "{}" } },
          ],
        });
        msgs.push({ role: "tool", tool_call_id: `call_${i}`, content: `第${i}轮检索结果`.repeat(200) });
      }
      return msgs;
    }

    it("工具组数 ≤ keepRounds 时不变", () => {
      const msgs = buildMessages(1);
      const r = compactHistoricalToolResults(msgs);
      expect(r.compactedGroups).toBe(0);
      expect(r.messages).toBe(msgs); // 同引用，零拷贝
    });

    it("更早轮次替换为占位符，最近一轮保留完整", () => {
      const msgs = buildMessages(2);
      const r = compactHistoricalToolResults(msgs);
      expect(r.compactedGroups).toBe(1);
      expect(r.savedChars).toBeGreaterThan(0);
      // 第 1 轮 tool 消息被压缩
      const round1Tool = r.messages.find((m) => m.tool_call_id === "call_1");
      expect(round1Tool.content).toContain("[历史工具结果已压缩]");
      expect(round1Tool.content).toContain("search_knowledge_base");
      // 第 2 轮保持完整
      const round2Tool = r.messages.find((m) => m.tool_call_id === "call_2");
      expect(round2Tool.content).toContain("第2轮检索结果");
      expect(round2Tool.content.length).toBeGreaterThan(500);
    });

    it("幂等：已压缩的消息不会重复压缩", () => {
      const msgs = buildMessages(2);
      const first = compactHistoricalToolResults(msgs);
      const second = compactHistoricalToolResults(first.messages);
      expect(second.savedChars).toBe(0);
    });

    it("不修改原数组", () => {
      const msgs = buildMessages(2);
      const before = msgs.find((m) => m.tool_call_id === "call_1").content;
      compactHistoricalToolResults(msgs);
      expect(msgs.find((m) => m.tool_call_id === "call_1").content).toBe(before);
    });

    it("开关关闭时原样返回", () => {
      config.agent.contextCompactionEnabled = false;
      const msgs = buildMessages(3);
      const r = compactHistoricalToolResults(msgs);
      expect(r.compactedGroups).toBe(0);
      expect(r.messages).toBe(msgs);
    });

    it("keepRounds=2 时保留最近两轮", () => {
      config.agent.toolResultKeepRounds = 2;
      const msgs = buildMessages(3);
      const r = compactHistoricalToolResults(msgs, { keepRounds: 2 });
      expect(r.compactedGroups).toBe(1);
      expect(r.messages.find((m) => m.tool_call_id === "call_2").content.length).toBeGreaterThan(500);
      expect(r.messages.find((m) => m.tool_call_id === "call_3").content.length).toBeGreaterThan(500);
    });
  });
});
