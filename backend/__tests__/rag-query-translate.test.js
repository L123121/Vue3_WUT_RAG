import { describe, it, expect, vi } from "vitest";

const { generateHydeDocument, generateStepBackQuery } = require("../src/services/rag/rag-query-rewrite.service");

function mockAi(content) {
  return {
    getCompletion: vi.fn(async () => ({ content, isMock: true, model: "mock" })),
  };
}

describe("HyDE 假设文档生成", () => {
  it("生成合格的假设文档", async () => {
    const doc =
      "武汉理工大学图书馆开放时间为每天 7:00 至 22:30，考试周延长至 23:00。三楼自习区与总馆同步开放，节假日安排以馆方通知为准。";
    const ai = mockAi(doc);
    const result = await generateHydeDocument("图书馆三楼几点关门", ai);
    expect(result).toBe(doc);
    expect(ai.getCompletion).toHaveBeenCalledTimes(1);
  });

  it("过短输出视为无效，返回 null", async () => {
    const ai = mockAi("太短");
    expect(await generateHydeDocument("图书馆几点关门", ai)).toBeNull();
  });

  it("LLM 失败返回 null，不抛异常", async () => {
    const ai = { getCompletion: vi.fn(async () => { throw new Error("rate limit"); }) };
    expect(await generateHydeDocument("图书馆几点关门", ai)).toBeNull();
  });

  it("空问题直接返回 null，不调 LLM", async () => {
    const ai = mockAi("x".repeat(100));
    expect(await generateHydeDocument("", ai)).toBeNull();
    expect(ai.getCompletion).not.toHaveBeenCalled();
  });
});

describe("Step-Back 上位问题生成", () => {
  it("生成与原问题不同的上位问题", async () => {
    const ai = mockAi("武汉理工大学图书馆的开放时间和场馆规则是什么");
    const result = await generateStepBackQuery("图书馆三楼自习区几点关门", ai);
    expect(result).toBe("武汉理工大学图书馆的开放时间和场馆规则是什么");
  });

  it("与原问题相同时返回 null（无需抽象）", async () => {
    const q = "图书馆开放时间";
    const ai = mockAi(q);
    expect(await generateStepBackQuery(q, ai)).toBeNull();
  });

  it("过短问题不调 LLM", async () => {
    const ai = mockAi("xxxxxx");
    expect(await generateStepBackQuery("开门吗", ai)).toBeNull();
    expect(ai.getCompletion).not.toHaveBeenCalled();
  });

  it("LLM 失败返回 null，不抛异常", async () => {
    const ai = { getCompletion: vi.fn(async () => { throw new Error("timeout"); }) };
    // 用独立 query，避免命中前面用例写入的模块级缓存
    expect(await generateStepBackQuery("东院食堂一楼周末几点关门", ai)).toBeNull();
  });

  it("剥离模型输出首尾的引号", async () => {
    const ai = mockAi("「武汉理工大学图书馆的开放时间」");
    expect(await generateStepBackQuery("图书馆三楼几点关门", ai)).toBe("武汉理工大学图书馆的开放时间");
  });
});
