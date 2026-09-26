import { describe, it, expect, beforeEach, vi } from "vitest";

// 与 memory.service.test.js 相同的内存版 memory-store mock
vi.mock("../src/services/memory/memory-store.service", () => {
  const store = new Map();
  return {
    redis: {
      rpush: vi.fn(async (k, v) => {
        if (!store.has(k)) store.set(k, []);
        store.get(k).push(v); return 1;
      }),
      lrange: vi.fn(async (k, start, end) => {
        const list = store.get(k) || [];
        return end === -1 ? list.slice(start) : list.slice(start, end + 1);
      }),
      del: vi.fn(async (k) => { store.delete(k); return 1; }),
    },
  };
});

/** 构造单位向量：第 idx 维为 1（彼此正交，cosine=0） */
function unitVector(idx, dims = 128) {
  const v = new Array(dims).fill(0);
  v[idx % dims] = 1;
  return v;
}

/** 与 v 近似的向量（cosine ≈ 0.98） */
function nearVector(v) {
  const w = v.map((x) => x * 0.98);
  w[0] += 0.02;
  return w;
}

describe("LongTermMemory 分类治理", () => {
  let LongTermMemory, MEMORY_TYPES, ltm;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ LongTermMemory, MEMORY_TYPES } = require("../src/services/memory/long-term-memory"));
    ltm = new LongTermMemory();
    // stub embedder：按内容映射到确定性向量
    ltm.embedder = {
      isAvailable: true,
      embedHybrid: vi.fn(async (text) => ({ dense: ltm.__vectors?.[text] || unitVector(text.length) })),
    };
    await ltm.clear("u_test");
    await ltm.clear("u_cap");
    await ltm.clear("u_fallback");
  });

  it("四类记忆类型常量", () => {
    expect(MEMORY_TYPES.preference).toBe("偏好");
    expect(MEMORY_TYPES.feedback).toBe("错误反馈");
    expect(MEMORY_TYPES.fact).toBe("事实");
    expect(MEMORY_TYPES.reference).toBe("外部参考");
  });

  it("语义重复（同类型、cosine≥0.9）合并而非新增", async () => {
    const v = unitVector(0);
    ltm.__vectors = { 偏好A: v, 偏好B: nearVector(v) };
    await ltm.add("u_test", { type: "preference", content: "偏好A" });
    const dup = await ltm.add("u_test", { type: "preference", content: "偏好B" });
    const list = await ltm.get("u_test");
    expect(list.length).toBe(1);
    expect(dup.mergedCount).toBe(2);
    expect(dup.accessCount).toBe(1);
  });

  it("语义相似但类型不同 → 不合并（类型隔离）", async () => {
    const v = unitVector(0);
    ltm.__vectors = { 偏好X: v, 事实X: nearVector(v) };
    await ltm.add("u_test", { type: "preference", content: "偏好X" });
    await ltm.add("u_test", { type: "fact", content: "事实X" });
    const list = await ltm.get("u_test");
    expect(list.length).toBe(2);
  });

  it("合并时保留信息量更大（更长）的内容", async () => {
    const v = unitVector(1);
    ltm.__vectors = { 短内容: v, 这是一句更长更完整的偏好描述: nearVector(v) };
    const first = await ltm.add("u_test", { type: "preference", content: "短内容" });
    await ltm.add("u_test", { type: "preference", content: "这是一句更长更完整的偏好描述" });
    const list = await ltm.get("u_test");
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(first.id);
    expect(list[0].content).toBe("这是一句更长更完整的偏好描述");
  });

  it("合并时 confidence 取高并小幅奖励（上限 0.99）", async () => {
    const v = unitVector(2);
    ltm.__vectors = { AA: v, BB: nearVector(v) };
    await ltm.add("u_test", { type: "fact", content: "AA", confidence: 0.7 });
    const merged = await ltm.add("u_test", { type: "fact", content: "BB", confidence: 0.9 });
    expect(merged.confidence).toBeCloseTo(0.95, 5);
  });

  it("超出上限时驱逐低价值记忆（低 confidence），而非简单 FIFO", async () => {
    // 为每条内容分配唯一正交向量，避免误触发语义合并
    const vectors = {};
    for (let i = 0; i < 100; i++) vectors[`第${i}条完全不同的事实陈述记录`] = unitVector(i);
    vectors["新加入的高价值事实"] = unitVector(100);
    ltm.__vectors = vectors;
    // 填满 100 条：默认 confidence 0.8，其中一条低价值 0.1
    for (let i = 0; i < 100; i++) {
      await ltm.add("u_cap", {
        type: "fact",
        content: `第${i}条完全不同的事实陈述记录`,
        confidence: i === 5 ? 0.1 : 0.8,
      });
    }
    // 最老的一条（index 0）confidence 高，再加一条应驱逐 index 5 而非 FIFO 的 index 0
    await ltm.add("u_cap", { type: "fact", content: "新加入的高价值事实", confidence: 0.9 });
    const list = await ltm.get("u_cap");
    expect(list.length).toBe(100);
    expect(list.some((m) => m.content === "第0条完全不同的事实陈述记录")).toBe(true);
    expect(list.some((m) => m.content === "第5条完全不同的事实陈述记录")).toBe(false);
    expect(list.some((m) => m.content === "新加入的高价值事实")).toBe(true);
  }, 20000);

  it("embedding 不可用时退化为文本级去重，不报错", async () => {
    ltm.embedder = { isAvailable: false };
    await ltm.add("u_fallback", { type: "fact", content: "完全相同的内容" });
    await ltm.add("u_fallback", { type: "fact", content: "完全相同的内容" });
    const list = await ltm.get("u_fallback");
    expect(list.length).toBe(1);
    expect(list[0].mergedCount).toBe(2);
  });
});
