'use strict';

const { getAgentRuntimeStore } = require('./runtime-store.service');
const { getCatalog, getTool } = require('./tool-catalog');
const { runtimeError } = require('./runtime-values');

const LEGACY_TOOLS = [
  { name: 'search_knowledge_base', label: '聊天知识检索', execution: 'legacy_read', sideEffect: false, requiresApproval: false },
  { name: 'read_tool_artifact', label: '聊天受控工件读取', execution: 'legacy_read', sideEffect: false, requiresApproval: false },
];
const EFFECTS = new Set(['allow', 'approval', 'deny']);

class ToolPolicyService {
  constructor({ store = getAgentRuntimeStore(), clock = () => Date.now() } = {}) {
    this.store = store;
    this.clock = clock;
  }
  async state() {
    const record = await this.store.getValue('policy', 'tools');
    return { record, version: record?.revision || 0, rules: record?.value.rules || {}, history: record?.value.history || [] };
  }
  async catalog() {
    const state = await this.state();
    return {
      version: state.version,
      tools: [...getCatalog(), ...LEGACY_TOOLS].map(tool => ({
        ...tool,
        rule: state.rules[tool.name] || { effect: tool.execution === 'sandbox_required' ? 'deny' : tool.requiresApproval ? 'approval' : 'allow', roles: ['user', 'admin'] },
      })),
      history: state.history,
    };
  }
  async decide(name, principal, definition = getTool(name)) {
    const state = await this.state();
    const tool = definition || LEGACY_TOOLS.find(item => item.name === name);
    const rule = state.rules[name] || { effect: tool?.requiresApproval ? 'approval' : 'allow', roles: ['user', 'admin'] };
    if (!tool || tool.execution === 'sandbox_required') return { effect: 'deny', reason: '工具尚未接入独立沙箱，拒绝执行', version: state.version };
    if (!principal?.id || principal.approved === false || !rule.roles.includes(principal.role)) return { effect: 'deny', reason: '当前用户不具备此工具权限', version: state.version };
    if (rule.effect === 'deny') return { effect: 'deny', reason: '工具已被权限策略禁用', version: state.version };
    return { effect: tool.requiresApproval || tool.sideEffect || rule.effect === 'approval' ? 'approval' : 'allow', reason: '', version: state.version };
  }
  async update(principal, input = {}) {
    if (principal?.role !== 'admin') throw runtimeError('仅管理员可以修改工具策略', 'FORBIDDEN', 403);
    const tool = [...getCatalog(), ...LEGACY_TOOLS].find(item => item.name === input.tool);
    if (!tool || !EFFECTS.has(input.effect) || !Array.isArray(input.roles) || input.roles.length > 2 || input.roles.some(role => !['user', 'admin'].includes(role))) throw runtimeError('工具策略参数无效');
    if (tool.execution === 'sandbox_required' && input.effect !== 'deny') throw runtimeError('未实现沙箱能力，不能通过配置放行', 'SANDBOX_REQUIRED', 403);
    if ((tool.requiresApproval || tool.sideEffect) && input.effect === 'allow') throw runtimeError('副作用工具不能跳过人工确认', 'APPROVAL_REQUIRED', 403);
    const state = await this.state();
    if (input.version !== state.version) throw runtimeError('策略已更新，请刷新后重试', 'VERSION_CONFLICT', 409);
    const rule = { effect: input.effect, roles: [...new Set(input.roles)] };
    const value = {
      rules: { ...state.rules, [tool.name]: rule },
      history: [...state.history, { at: this.clock(), by: principal.id, tool: tool.name, rule }].slice(-50),
    };
    if (!await this.store.setValue('policy', 'tools', state.record, value)) throw runtimeError('策略已更新，请刷新后重试', 'VERSION_CONFLICT', 409);
    return this.catalog();
  }
}

let service;
const getToolPolicyService = () => (service ||= new ToolPolicyService());
module.exports = { ToolPolicyService, getToolPolicyService };
