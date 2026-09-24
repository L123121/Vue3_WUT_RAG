"use strict";

/**
 * Agent 工具注册表（V2.0，移植自存档版裁剪）
 *
 * 内置工具：
 *   - search_knowledge_base：知识库 RAG 检索（复用 rag.service）
 *   - read_tool_artifact：读取当前 Agent 运行产生的受控大型工具结果工件
 *   - calculate：数学计算（mathjs 安全求值）
 * 教务系工具（查成绩/课表等）因当前项目无教务系统接入，不移植。
 */

const { ToolRegistry, TOOL_SOURCES } = require('./tool-registry.service');
const { readToolSpill } = require('./context-compaction.service');
const { RagService } = require('./rag.service');
const { aiService } = require('./ai.service');
const { create, all } = require('mathjs');

const ragService = new RagService(aiService);
const math = create(all);

// 工具执行超时分级：知识库检索走完整 RAG 链路，给 15s；本地计算 3s
const TIMEOUT_SCHOOL = 15000;
const TIMEOUT_LOCAL = 3000;

// ============================================================
// 创建全局注册表并注册内置工具
// ============================================================

const toolRegistry = new ToolRegistry();

const builtinTools = [
  {
    name: 'search_knowledge_base',
    description: '从校园知识库中检索相关信息。当用户询问学校相关问题时使用此工具。支持按类别检索：学校概况、专业课程、面试刷题、AI学习等。',
    category: '知识库',
    source: TOOL_SOURCES.BUILTIN,
    timeoutMs: TIMEOUT_SCHOOL,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词或问题',
          maxLength: 500,
        },
        category: {
          type: 'string',
          enum: ['学校概况', '专业课程', '面试刷题', 'AI学习', 'general'],
          description: '知识库分类（可选）'
        }
      },
      required: ['query'],
      additionalProperties: false,
    },
    parallelSafe: true,
    sideEffect: false,
    handler: async (args, context = {}) => {
      try {
        // 仅检索不生成（retrieveOnly）：agent 链路只生成一次（收尾统一生成），
        // 避免"决策 + RAG 内部生成 + 收尾"三次 LLM 调用；sources 结构化透传给 agent → 前端引用展示
        const result = await ragService.localSearchChat(args.query, [], {
          category: args.category,
          retrieveOnly: true,
          signal: context.signal,
          traceId: context.traceId,
          userId: context.userId,
          conversationId: context.conversationId,
        });
        if (!result || !result.context) return '检索结果：知识库中未找到相关信息';
        const sources = Array.isArray(result.sources) ? result.sources : [];
        const titles = sources.map(s => s.title).filter(Boolean).join(', ') || '无';
        return {
          content: `检索结果：\n${result.context}\n来源：${titles}`,
          uiSummary: `知识库检索完成，命中 ${sources.length} 个来源`,
          data: { sources },
        };
      } catch (err) {
        return `知识库检索失败：${err.message}`;
      }
    }
  },

  {
    name: 'read_tool_artifact',
    description: '读取当前 Agent 运行产生的大型工具结果工件。仅当工具结果提供 artifactId 且需要查看被截断的后续内容时使用；不要猜测 artifactId，也不要读取任意路径。',
    category: '工具工件',
    source: TOOL_SOURCES.BUILTIN,
    timeoutMs: TIMEOUT_LOCAL,
    parameters: {
      type: 'object',
      properties: {
        artifactId: {
          type: 'string',
          description: '工具结果中提供的 opaque artifactId',
          maxLength: 120,
        },
        offset: {
          type: 'integer',
          description: '从结果正文的字符偏移开始读取，默认 0',
        },
        limit: {
          type: 'integer',
          description: '读取字符数，最大 4000，默认 4000',
        },
      },
      required: ['artifactId'],
      additionalProperties: false,
    },
    parallelSafe: true,
    sideEffect: false,
    handler: async (args, context = {}) => {
      const result = await readToolSpill(args.artifactId, context, {
        offset: args.offset,
        limit: args.limit,
      });
      return {
        ok: result.ok,
        content: result.ok
          ? `${result.content}\n\n[工件 ${result.artifactId}，区间 ${result.offset}-${result.offset + result.content.length}/${result.totalChars}，${result.hasMore ? '仍有后续内容' : '已到末尾'}]`
          : result.content,
        uiSummary: result.ok ? `已读取工具工件 ${result.artifactId}` : '工具工件读取失败',
        data: result.ok ? {
          artifactId: result.artifactId,
          offset: result.offset,
          limit: result.limit,
          totalChars: result.totalChars,
          hasMore: result.hasMore,
        } : null,
      };
    },
  },

  {
    name: 'calculate',
    description: '执行数学计算。支持加减乘除、乘方、开方、三角函数等。当用户需要计算时使用。',
    category: '工具',
    source: TOOL_SOURCES.BUILTIN,
    timeoutMs: TIMEOUT_LOCAL,
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '数学表达式，如 "2+3*4", "sqrt(16)", "sin(3.14/2)"',
          maxLength: 200,
        }
      },
      required: ['expression'],
      additionalProperties: false,
    },
    parallelSafe: true,
    sideEffect: false,
    handler: async (args) => {
      try {
        const expr = args.expression;
        // 使用 mathjs 安全求值（模块级 create(all) 实例），避免 new Function() 注入风险
        const result = math.evaluate(expr);
        if (typeof result !== 'number' || !isFinite(result)) {
          return { ok: false, content: `计算结果无效: ${result}` };
        }
        return `${args.expression} = ${result}`;
      } catch (err) {
        // 结构化失败（executeToolDetailed 识别 ok=false），兼容字符串契约（executeTool 取 content）
        return { ok: false, content: `计算失败: ${err.message}` };
      }
    }
  },
];

for (const t of builtinTools) {
  toolRegistry.register(t);
}

/**
 * 生成 LLM 工具 schema（OpenAI function calling 格式）
 */
function getToolSchemas() {
  return toolRegistry.getToolSchemas();
}

/**
 * 执行工具（兼容契约：返回 content 字符串）
 * @param {string} name - 工具名
 * @param {Object} args - 参数
 * @param {Object} context - { userId }
 */
function executeTool(name, args, context = {}) {
  return toolRegistry.executeTool(name, args, context);
}

/**
 * 执行工具（结构化返回 { ok, content, data }，Agent 调度用）
 */
function executeToolDetailed(name, args, context = {}) {
  return toolRegistry.executeToolDetailed(name, args, context);
}

function getToolNames() {
  return toolRegistry.getToolNames();
}

module.exports = { toolRegistry, getToolSchemas, executeTool, executeToolDetailed, getToolNames };
