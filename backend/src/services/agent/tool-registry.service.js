"use strict";

/**
 * ToolRegistry — 动态工具注册表（V2.0 移植自存档版，裁剪去教务/Redis 依赖）
 *
 * 管理 Agent 可用的所有工具，支持运行时注册/移除/开关。
 * 工具来源 (source): builtin | custom
 */

const { logEvent } = require('../observability/observability.service');

const TOOL_SOURCES = {
  BUILTIN: 'builtin',
  CUSTOM: 'custom',
};

// 默认单工具执行超时（毫秒）。慢工具不应拖死整轮调度——
// 超时后返回"工具执行超时"字符串（而非 reject），让 LLM 基于已有信息继续。
const DEFAULT_TOOL_TIMEOUT_MS = 8000;

/**
 * 工具超时专用错误。用 instanceof 判定，避免靠魔法字符串 message 比较。
 */
class ToolTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`__TOOL_TIMEOUT__:${timeoutMs}`);
    this.name = 'ToolTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

class ToolArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

function createAbortError() {
  const err = new Error('工具执行已取消');
  err.name = 'AbortError';
  return err;
}

function validateToolArgs(schema = {}, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolArgumentError('参数必须是对象');
  }

  for (const name of schema.required || []) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      throw new ToolArgumentError(`缺少必填参数: ${name}`);
    }
  }

  for (const [name, value] of Object.entries(args)) {
    const rule = schema.properties?.[name];
    if (!rule) {
      if (schema.additionalProperties === false) {
        throw new ToolArgumentError(`不支持的参数: ${name}`);
      }
      continue;
    }
    if (rule.type === 'string' && typeof value !== 'string') {
      throw new ToolArgumentError(`参数 ${name} 必须是字符串`);
    }
    if (rule.type === 'number' && typeof value !== 'number') {
      throw new ToolArgumentError(`参数 ${name} 必须是数字`);
    }
    if (rule.type === 'integer' && !Number.isInteger(value)) {
      throw new ToolArgumentError(`参数 ${name} 必须是整数`);
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') {
      throw new ToolArgumentError(`参数 ${name} 必须是布尔值`);
    }
    if (typeof value === 'string' && rule.maxLength && value.length > rule.maxLength) {
      throw new ToolArgumentError(`参数 ${name} 超过最大长度 ${rule.maxLength}`);
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      throw new ToolArgumentError(`参数 ${name} 不在允许范围内`);
    }
  }
}

/**
 * 给一个 Promise 套上超时：到点 reject(ToolTimeoutError)。
 * 超时后原 promise 仍在后台运行：附加 .catch 兜底，防止 unhandledRejection。
 */
function withTimeout(promise, timeoutMs, signal = null, onTimeout = null) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  let onAbort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new ToolTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const aborted = signal
    ? new Promise((_, reject) => {
      onAbort = () => reject(createAbortError());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    })
    : null;
  const raced = Promise.race([promise, timeout, ...(aborted ? [aborted] : [])]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
  promise
    .then(
      () => { /* 超时后成功完成，结果被丢弃 */ },
      (e) => { logEvent('warn', 'tool_registry_timeout_handler_failed', { error: e?.message || e }); }
    )
    .catch(() => { /* then 内已处理，这里仅防 then 抛错 */ });
  return raced;
}

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  /**
   * 注册一个工具
   * @param {Object} tool
   * @param {string} tool.name - 工具名（唯一标识）
   * @param {string} tool.description - 工具描述（给 LLM 看）
   * @param {Object} tool.parameters - JSON Schema 格式参数定义
   * @param {Function} tool.handler - async (args, context) => string
   * @param {string} [tool.category='general'] - 分类标签
   * @param {string} [tool.source='custom'] - 来源
   * @param {boolean} [tool.enabled=true] - 是否启用
   */
  register(tool) {
    if (!tool.name || !tool.handler) {
      throw new Error('工具必须包含 name 和 handler');
    }
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      handler: tool.handler,
      category: tool.category || 'general',
      source: tool.source || TOOL_SOURCES.CUSTOM,
      enabled: tool.enabled !== false,
      timeoutMs: tool.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS,
      parallelSafe: tool.parallelSafe !== false,
      sideEffect: tool.sideEffect === true,
      requiresConfirmation: tool.requiresConfirmation === true,
      registeredAt: new Date(),
    });
  }

  /**
   * 移除一个工具
   * @param {string} name
   * @returns {boolean} 是否成功移除
   */
  unregister(name) {
    return this.tools.delete(name);
  }

  /**
   * 切换工具启用/禁用
   * @param {string} name
   * @param {boolean} enabled
   */
  setEnabled(name, enabled) {
    const tool = this.tools.get(name);
    if (tool) tool.enabled = enabled;
  }

  /**
   * 获取单个工具
   * @param {string} name
   * @returns {Object|null}
   */
  getTool(name) {
    return this.tools.get(name) || null;
  }

  /**
   * 获取所有工具（含禁用的）
   * @returns {Array}
   */
  getAllTools() {
    return Array.from(this.tools.values());
  }

  /**
   * 获取所有启用的工具
   * @returns {Array}
   */
  getEnabledTools() {
    return this.getAllTools().filter(t => t.enabled);
  }

  /**
   * 生成 LLM tools 参数格式（仅启用的工具）
   * @returns {Array}
   */
  getToolSchemas() {
    return this.getEnabledTools().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * 获取工具名称列表（仅启用的）
   * @returns {string[]}
   */
  getToolNames() {
    return this.getEnabledTools().map(t => t.name);
  }

  /**
   * 执行工具并返回结构化结果（Agent 调度用，替代靠中文正则猜成败）
   * handler 可返回字符串，或 { content, data, ok? }（data 用于 sources 等结构化数据透传）
   * @param {string} name - 工具名称
   * @param {Object} args - 工具参数
   * @param {Object} context - 用户上下文
   * @returns {Promise<{ok: boolean, content: string, data: any}>}
   */
  async executeToolDetailed(name, args, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, content: `未知工具: ${name}`, data: null };
    if (!tool.enabled) return { ok: false, content: `工具 ${name} 已禁用`, data: null };
    if (context.signal?.aborted) throw createAbortError();
    const timeoutMs = tool.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS;
    let timedOut = false;
    try {
      validateToolArgs(tool.parameters, args);
      const controller = new AbortController();
      const abortHandler = () => controller.abort(context.signal?.reason);
      if (context.signal) context.signal.addEventListener('abort', abortHandler, { once: true });
      const executionContext = {
        ...context,
        signal: controller.signal,
        deadline: Date.now() + timeoutMs,
        tool: {
          name: tool.name,
          parallelSafe: tool.parallelSafe,
          sideEffect: tool.sideEffect,
          requiresConfirmation: tool.requiresConfirmation,
        },
      };
      let raw;
      try {
        const execution = Promise.resolve().then(() => tool.handler(args, executionContext));
        raw = await withTimeout(execution, timeoutMs, context.signal, () => {
          timedOut = true;
          controller.abort(new ToolTimeoutError(timeoutMs));
        });
      } finally {
        if (context.signal) context.signal.removeEventListener('abort', abortHandler);
      }
      if (raw && typeof raw === 'object' && typeof raw.content === 'string') {
        return {
          ok: raw.ok !== false,
          content: raw.content,
          uiSummary: raw.uiSummary || null,
          data: raw.data ?? null,
          errorCode: raw.errorCode || null,
        };
      }
      return { ok: true, content: String(raw), uiSummary: null, data: null, errorCode: null };
    } catch (err) {
      if (timedOut || err instanceof ToolTimeoutError) {
        logEvent('warn', 'tool_registry_timeout', { tool: name, timeoutMs });
        return { ok: false, content: `工具 ${name} 执行超时（${timeoutMs}ms）。请基于已有信息继续回答，或换一种方式获取数据。`, data: null };
      }
      if (err.name === 'AbortError' || context.signal?.aborted) throw err;
      if (err instanceof ToolArgumentError) {
        return { ok: false, content: `工具 ${name} 参数无效: ${err.message}`, data: null, errorCode: 'invalid_arguments' };
      }
      return { ok: false, content: `工具 ${name} 执行失败: ${err.message}`, data: null };
    }
  }

  /**
   * 执行指定工具（兼容旧契约：只返回 content 字符串）
   * @param {string} name - 工具名称
   * @param {Object} args - 工具参数
   * @param {Object} context - 用户上下文
   * @returns {Promise<string>}
   */
  async executeTool(name, args, context = {}) {
    const r = await this.executeToolDetailed(name, args, context);
    return r.content;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const all = this.getAllTools();
    return {
      total: all.length,
      enabled: all.filter(t => t.enabled).length,
      bySource: {
        builtin: all.filter(t => t.source === TOOL_SOURCES.BUILTIN).length,
        custom: all.filter(t => t.source === TOOL_SOURCES.CUSTOM).length,
      },
      names: this.getToolNames(),
    };
  }
}

module.exports = {
  ToolRegistry,
  TOOL_SOURCES,
};
