"use strict";

/**
 * Agent 工具注册表（V2.0，移植自存档版裁剪）
 *
 * 内置工具：
 *   - search_knowledge_base：知识库 RAG 检索（复用 rag.service）
 *   - read_tool_artifact：读取当前 Agent 运行产生的受控大型工具结果工件
 * 个人教务工具仅预注册（默认禁用），正式接口与授权接入后再开放。
 */

const { ToolRegistry, TOOL_SOURCES } = require('./tool-registry.service');
const { createAcademicTools } = require('./academic-tools.service');
const { readToolSpill } = require('../conversation/context-compaction.service');
const { RagService } = require('../rag/rag.service');
const { aiService } = require('../llm/ai.service');

const ragService = new RagService(aiService);

// 工具执行超时分级：知识库检索走完整 RAG 链路，给 15s；本地工件读取 3s
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

];

for (const t of [...builtinTools, ...createAcademicTools()]) {
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

/**
 * 工具执行元信息：Agent 调度据此决定并行还是串行（副作用工具同轮内不可并发）。
 * 未知工具按"可并行、无副作用"处理，由执行层给出未知工具错误。
 */
function getToolMeta(name) {
  const tool = toolRegistry.getTool(name);
  if (!tool) return { parallelSafe: true, sideEffect: false };
  return { parallelSafe: tool.parallelSafe !== false, sideEffect: tool.sideEffect === true };
}

module.exports = { toolRegistry, getToolSchemas, executeTool, executeToolDetailed, getToolNames, getToolMeta };
