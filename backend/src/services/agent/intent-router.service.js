"use strict";

const { AiService } = require("../llm/ai.service");
const { logEvent } = require("../observability/observability.service");

/**
 * IntentRouter — 意图识别与自动路由层（V2.0）
 *
 * 面试官反馈①：RAG 不应让用户手动开关，应加一层意图识别自动路由。
 * 本层对应架构图中的 "意图识别层 (NLU)" + "任务路由"，让用户无感知：
 *   用户只负责提问，系统自动决定走哪条链路。
 *
 * 路由设计（裁剪存档版 intent-router，路由表收敛为三类）：
 *   - chat   普通对话（闲聊、写作、翻译、通用知识）→ 纯 LLM，不触发检索（快、省）
 *   - agent  多步/复合任务（规划、综合对比分析）→ 工具调度（见 P1 工具层）
 *   - rag    明确的校内知识或本地课程资料问答 → RAG 检索管道
 *
 * 关键原则（来自存档回退教训）：
 *   1. fastRoute 只保留"零误判"的高置信关键词规则，不做低置信正则硬路由
 *      （低置信正则误路由率高，会架空 LLM 决策，也是当初 Agent 回退的原因之一）。
 *   2. 只有明确命中校园/课程资料/文档检索词时才走 rag；
 *      其余普通问题默认走 chat，避免无关问题产生低质量检索和错误引用。
 *   3. LLM 分类默认关闭（INTENT_CLASSIFY_ENABLED=true 才启用），
 *      避免每条消息多一次 LLM 调用拖慢首包延迟（简历口径 SSE 首包 ~130ms 不回退）；
 *      fastRoute 零成本路由常开。
 */

// 意图类型定义
const INTENT_TYPES = {
  KNOWLEDGE_QUERY: "knowledge_query", // 校内知识问答 → rag
  GENERAL_CHAT: "general_chat",       // 普通闲聊 → chat
  COMPLEX_TASK: "complex_task",       // 多步/复合任务 → agent
  CALCULATION_TASK: "calculation_task", // 明确数学计算 → agent/calculate
};

// 意图路由表：意图类型 → { route, description }
const ROUTE_MAP = {
  [INTENT_TYPES.KNOWLEDGE_QUERY]: { route: "rag", description: "知识库检索" },
  [INTENT_TYPES.GENERAL_CHAT]: { route: "chat", description: "普通对话" },
  [INTENT_TYPES.COMPLEX_TASK]: { route: "agent", description: "多步任务" },
  [INTENT_TYPES.CALCULATION_TASK]: { route: "agent", description: "数学计算" },
};

const KNOWLEDGE_PATTERNS = [
  /(知识库|文档库|资料库|根据.{0,8}(文档|资料|手册|指南|笔记|题库)|(?:查找|查询|检索|搜索).{0,8}(文档|资料|知识库)|(?:文档|资料|手册|指南|笔记|题库).{0,8}(?:怎么说|写了什么|有没有|在哪里|原文|来源))/,
  /(武理|武汉理工|学校|本校|校内|校园|校区|教务|食堂|宿舍|图书馆|奖学金|助学金|资助|社团|培养方案|选课|学分|绩点|期末考试|考试安排|缓考|补考|成绩复核|学籍|保研|推免|大创|学科竞赛|校招|校园招聘|毕业设计|论文答辩|校园卡|校园网|信息化服务|实验室安全|校园应急|心理健康|学术诚信|新生入学)/,
  /(计算机网络|计算机组成(?:原理)?|离散结构|面向对象编程|软件工程基础|数据结构|算法设计与分析|前端.{0,6}面试题|codetop|python.{0,6}题库|rag系统|agent学习)/i,
];

/**
 * 问候/感谢/告别模式（唯一事实来源）
 * fastRoute 用于零误判 chat 路由；ConversationOrchestrator 在意图路由关闭时
 * 复用同一模式判断"纯寒暄"，避免两处正则漂移。
 */
const GREETING_PATTERN = /^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|早上好|中午好|下午好|晚上好|晚安|谢谢|感谢|多谢|再见|拜拜|bye|goodbye|辛苦了|好的|好的吧)[!！.。~～]?$/i;

/**
 * 轻量级意图分类 prompt（LLM 兜底，默认关闭）
 * 只做分类，不做推理 — 快、省 token
 */
const CLASSIFICATION_PROMPT = `你是一个意图分类器。请分析用户的消息，返回 JSON 格式的分类结果。

可能的意图类型：
- knowledge_query: 明确涉及武汉理工校园事务、本地课程资料，或用户明确要求查询知识库/文档（如"学校食堂几点关门"、"奖学金怎么申请"、"数据结构复习重点"、"根据文档回答"）——需要检索校内知识库
- general_chat: 普通对话、写作、翻译、编程和通用知识（如"你好"、"今天天气怎么样"、"帮我写首诗"、"什么是闭包"）——不需要检索知识库
- complex_task: 多步/复合任务（如"帮我制定一个期末复习计划"、"综合对比两个方案"、"规划考研时间线"）——需要多步规划与多个信息来源
- calculation_task: 明确数学计算（如"128 乘以 46"、"sqrt(144)"、"23 的 3 次方"）——需要调用计算工具

规则：
1. 只返回 JSON，不要其他内容
2. intent 字段必须取上述值之一
3. confidence 字段表示置信度（0-1）
4. 提取相关的参数到 params 字段

用户消息：{message}

返回格式：
{
  "intent": "意图类型",
  "confidence": 0.95,
  "params": {},
  "reason": "简短分类理由"
}`;

class IntentRouter {
  constructor(aiService = null) {
    this.aiService = aiService || new AiService();
  }

  /**
   * 快速路由：只做零误判的关键词匹配，不调用 LLM（~0ms）
   *
   * 设计原则：
   *   fastRoute 只保留高置信规则：问候、多步任务、数学计算，以及明确命中
   *   校园/本地课程资料/文档检索词的知识问答。其余意图返回 null，默认走 chat。
   *
   * @param {string} message - 用户消息
   * @returns {{intent, confidence, params, route, tool, reason}|null}
   */
  fastRoute(message) {
    const lower = String(message || "").toLowerCase().trim();

    // 问候/感谢/告别 —— 零误判，走纯 LLM 聊天（不触发检索）
    if (GREETING_PATTERN.test(lower)) {
      return {
        intent: INTENT_TYPES.GENERAL_CHAT,
        confidence: 0.95,
        params: {},
        route: "chat",
        tool: null,
        reason: "关键词匹配：问候/感谢/告别",
      };
    }

    // 明确的多步/复合任务 —— 动词明确，置信高，走工具调度
    if (/(规划|制定.*计划|学习计划|复习计划|安排.*计划|时间线|综合.*分析|全面.*分析|权衡|利弊|对比.*(方案|计划)|哪个更适合|帮我计划|分步|一步一步)/.test(lower)) {
      return {
        intent: INTENT_TYPES.COMPLEX_TASK,
        confidence: 0.75,
        params: {},
        route: "agent",
        tool: null,
        reason: "关键词匹配：多步/复合任务",
      };
    }

    const hasNumericExpression = /\d|sqrt\s*\(|(?:sin|cos|tan|log|abs)\s*\(|\bpi\b/i.test(lower);
    const hasCalculationCue = /(算一下|计算|求值|等于多少|是多少|次方|平方|立方|平方根|开方|[+\-*/^×÷])/i.test(lower);
    if (hasNumericExpression && hasCalculationCue) {
      return {
        intent: INTENT_TYPES.CALCULATION_TASK,
        confidence: 0.9,
        params: {},
        route: "agent",
        tool: "calculate",
        reason: "能力匹配：数学计算工具",
      };
    }

    if (KNOWLEDGE_PATTERNS.some((pattern) => pattern.test(lower))) {
      return {
        intent: INTENT_TYPES.KNOWLEDGE_QUERY,
        confidence: 0.85,
        params: {},
        route: "rag",
        tool: null,
        reason: "关键词匹配：校园或本地知识库资料",
      };
    }

    // 普通写作、翻译、编程、通用知识等不做硬路由，交给 chat 兜底。
    return null;
  }

  /**
   * LLM 分类兜底（默认由配置开关控制，INTENT_CLASSIFY_ENABLED=true 才启用）
   * 15s 超时 + 失败/无法解析 JSON → 兜底路由
   */
  async classify(message) {
    try {
      const prompt = CLASSIFICATION_PROMPT.replace("{message}", String(message || ""));
      let timer;
      const classifyPromise = this.aiService.getCompletion(prompt, [], { timeout: 15000, retries: 0 });
      // 超时胜出后 classifyPromise 不再被 race 观察，须吞掉迟到的 rejection 防击穿进程
      classifyPromise.catch(() => {});
      const response = await Promise.race([
        classifyPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ content: "", _timeout: true }), 15000);
        }),
      ]);
      clearTimeout(timer);
      if (response._timeout) {
        logEvent("warn", "intent_classify_timeout", { timeoutMs: 15000 });
        return this._fallbackRoute(message);
      }

      const content = String(response.content || "").trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logEvent("warn", "intent_classify_invalid_json", { content });
        return this._fallbackRoute(message);
      }

      const result = JSON.parse(jsonMatch[0]);
      const intent = ROUTE_MAP[result.intent]
        ? result.intent
        : INTENT_TYPES.GENERAL_CHAT;
      const routeInfo = ROUTE_MAP[intent];

      return {
        intent,
        confidence: result.confidence || 0.5,
        params: result.params || {},
        reason: result.reason || "",
        route: routeInfo.route,
        tool: null,
      };
    } catch (err) {
      logEvent("error", "intent_classify_failed", { error: err.message });
      return this._fallbackRoute(message);
    }
  }

  /**
   * 完整路由：先零成本 fastRoute，未命中且启用 LLM 分类时再调 LLM，否则兜底
   * @param {string} message - 用户消息
   * @returns {Promise<{intent, confidence, params, route, tool, reason}>}
   */
  async route(message) {
    const quickRoute = this.fastRoute(message);
    if (quickRoute) {
      logEvent("info", "intent_route", { via: "fast", intent: quickRoute.intent, route: quickRoute.route });
      return quickRoute;
    }

    // 未命中高置信规则时默认走普通聊天，避免所有问题都触发知识库检索。
    const fallback = this._fallbackRoute(message);

    // 需要 LLM 分类且配置允许时才调用（默认关闭，避免每条消息多一次 LLM 调用）
    try {
      const config = require("../../config");
      if (config.rag?.intentClassifyEnabled) {
        const classified = await this.classify(message);
        logEvent("info", "intent_route", { via: "llm", intent: classified.intent, route: classified.route });
        return classified;
      }
    } catch (err) {
      logEvent("warn", "intent_config_read_failed", { error: err.message });
    }

    logEvent("info", "intent_route", { via: "fallback", intent: fallback.intent, route: fallback.route });
    return fallback;
  }

  /**
   * 兜底路由：默认普通对话（chat）
   */
  _fallbackRoute(_message) {
    return {
      intent: INTENT_TYPES.GENERAL_CHAT,
      confidence: 0.3,
      params: {},
      route: "chat",
      tool: null,
      reason: "兜底：未命中知识库或工具规则，走普通对话",
    };
  }
}

module.exports = { IntentRouter, INTENT_TYPES, GREETING_PATTERN };
