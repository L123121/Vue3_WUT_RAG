import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AgentTasks from '../views/AgentTasks.vue';
import AgentRunDetail from '../components/agent/AgentRunDetail.vue';
import ToolPolicyPanel from '../components/agent/ToolPolicyPanel.vue';
import * as api from '../api/agentRuns.js';

vi.mock('../api/agentRuns.js', () => ({
  listAgentRuns: vi.fn(), getAgentRun: vi.fn(), createAgentRun: vi.fn(), editAgentPlan: vi.fn(), startAgentRun: vi.fn(),
  pauseAgentRun: vi.fn(), cancelAgentRun: vi.fn(), resumeAgentRun: vi.fn(), approveAgentStep: vi.fn(),
  getAgentEvents: vi.fn(), replayAgentRun: vi.fn(), removeAgentRun: vi.fn(), getAgentToolPolicies: vi.fn(), updateAgentToolPolicy: vi.fn(),
}));
const now = Date.now();
const copy = value => JSON.parse(JSON.stringify(value));
const step = (id, status = 'pending') => ({ id, label: id === 'save' ? '保存个人摘录' : '检索资料', tool: id === 'save' ? 'save_research_brief' : 'search_published_sources', toolVersion: 1, input: id === 'save' ? { brief: { $from: 'search', path: [] } } : { query: '图书馆' }, dependsOn: id === 'save' ? ['search'] : [], notBefore: 0, status, attempts: status === 'succeeded' ? 1 : 0, result: null, resultHash: null, approval: null, error: null });
const makeRun = (status = 'draft') => ({ id: 'ar_demo', title: '图书馆资料研究', goal: '整理图书馆开放与借阅资料', status, version: 2, planVersion: 1, planHash: 'abc', createdAt: now, updatedAt: now, expiresAt: now + 86400000, availableAt: now, calls: 0, maxCalls: 36, resumes: 0, checkpointSeq: 0, steps: [step('search'), step('save')] });
const makeCatalog = () => ({ version: 0, history: [], runtimeEnabled: true, tools: [
  { name: 'search_published_sources', label: '检索资料', execution: 'worker', parallelSafe: true, sideEffect: false, rule: { effect: 'allow', roles: ['user', 'admin'] } },
  { name: 'save_research_brief', label: '保存摘录', execution: 'worker', sideEffect: true, requiresApproval: true, rule: { effect: 'approval', roles: ['user'] } },
  { name: 'shell_execute', label: 'Shell 执行', execution: 'sandbox_required', sideEffect: true, requiresApproval: true, rule: { effect: 'deny', roles: ['admin'] } },
] });
const wrappers = [];
let run;
beforeEach(() => {
  vi.clearAllMocks();
  run = makeRun();
  api.listAgentRuns.mockImplementation(async () => ({ runs: run ? [copy(run)] : [], workerOnline: false }));
  api.getAgentRun.mockImplementation(async () => copy(run));
  api.getAgentToolPolicies.mockResolvedValue(makeCatalog());
  api.createAgentRun.mockImplementation(async () => ({ run: copy(run), existing: false }));
  api.startAgentRun.mockImplementation(async () => { run.status = 'queued'; run.version++; return copy(run); });
  api.resumeAgentRun.mockImplementation(async () => { run.status = 'queued'; run.version++; return copy(run); });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
async function render(component, props = {}, location = '/agent-tasks?run=ar_demo') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/agent-tasks', component: { template: '<div />' } }, { path: '/wiki/:id', component: { template: '<div />' } }] });
  await router.push(location);
  const wrapper = mount(component, { props, global: { plugins: [createPinia(), router], stubs: { MobileMenuButton: true, MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' }, Teleport: true } } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}
const button = (wrapper, name) => wrapper.findAll('button').find(item => item.text() === name);
function awaiting() {
  const value = makeRun('awaiting_approval');
  value.steps[0].status = 'succeeded'; value.calls = 1;
  value.steps[1].status = 'awaiting_approval';
  value.steps[1].approval = { id: 'approval_1', digest: 'digest_exact_args', expiresAt: now + 60000, decision: 'pending', policyVersion: 2, inputPreview: { brief: { content: '<img src=x onerror=alert(1)>待保存的摘录', title: '摘录' } } };
  return value;
}

describe('Agent运行界面', () => {
  it('执行器离线时展示持久排队提示，不自动执行草稿', async () => {
    const { wrapper } = await render(AgentTasks);
    expect(wrapper.text()).toContain('API不会代执行');
    expect(api.startAgentRun).not.toHaveBeenCalled();
    await button(wrapper, '确认计划并开始').trigger('click');
    await flushPromises();
    expect(api.startAgentRun).toHaveBeenCalledWith('ar_demo', 2);
    expect(wrapper.text()).toContain('等待执行器');
  });

  it('新计划保存与开始执行分离，首次提交包含幂等请求标识', async () => {
    const { wrapper } = await render(AgentTasks);
    await button(wrapper, '新建计划').trigger('click');
    const form = wrapper.find('form');
    await form.find('input:not([type])').setValue('整理活动资料');
    await form.find('textarea').setValue('场地开放\n办理材料');
    await form.trigger('submit');
    await flushPromises();
    expect(api.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.any(String), goal: '整理活动资料', queries: ['场地开放', '办理材料'], persist: true }));
    expect(api.startAgentRun).not.toHaveBeenCalled();
  });

  it('审批必须查看完整参数并明确勾选，发送绑定请求而不是简单true', async () => {
    const { wrapper } = await render(AgentRunDetail, { run: awaiting(), now });
    await button(wrapper, '审阅操作参数').trigger('click');
    expect(wrapper.find('[data-testid="agent-approval-review"]').text()).toContain('digest_exact_args');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(button(wrapper, '批准一次执行').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-testid="agent-approval-review"] input[type="checkbox"]').setValue(true);
    await button(wrapper, '批准一次执行').trigger('click');
    expect(wrapper.emitted('approval')[0]).toEqual(['save', { requestId: 'approval_1', digest: 'digest_exact_args', decision: 'approve' }]);
  });

  it('审批过期或请求被替换后不能点击批准', async () => {
    const value = awaiting();
    const { wrapper } = await render(AgentRunDetail, { run: value, now });
    await button(wrapper, '审阅操作参数').trigger('click');
    await wrapper.find('[data-testid="agent-approval-review"] input[type="checkbox"]').setValue(true);
    await wrapper.setProps({ now: now + 120000 });
    expect(button(wrapper, '批准一次执行').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('审批已过期或运行已变化');
    expect(wrapper.emitted('approval')).toBeUndefined();
  });

  it('回放模式不提供开始、审批、恢复、取消等执行入口', async () => {
    const { wrapper } = await render(AgentRunDetail, { run: awaiting(), readOnly: true, now });
    for (const label of ['批准一次执行', '审阅操作参数', '取消任务', '从检查点恢复', '确认计划并开始']) expect(button(wrapper, label)).toBeUndefined();
    expect(wrapper.text()).toContain('历史状态只读');
  });

  it('回放仅调用GET接口，恢复必须回到当前状态后显式触发', async () => {
    run = makeRun('failed');
    api.getAgentEvents.mockResolvedValue({ events: [{ seq: 1, type: 'run.created', at: now }], lastSeq: 1, nextSeq: 1, readOnly: true });
    api.replayAgentRun.mockResolvedValue({ state: makeRun(), through: 1, readOnly: true });
    const { wrapper } = await render(AgentTasks);
    await button(wrapper, '只读回放').trigger('click');
    await flushPromises();
    expect(api.replayAgentRun).toHaveBeenCalledWith('ar_demo', 1);
    expect(api.resumeAgentRun).not.toHaveBeenCalled();
    expect(button(wrapper, '确认计划并开始')).toBeUndefined();
    await button(wrapper, '当前状态').trigger('click');
    await flushPromises();
    await button(wrapper, '从检查点恢复').trigger('click');
    await flushPromises();
    expect(api.resumeAgentRun).toHaveBeenCalledWith('ar_demo', 2);
  });

  it('返回当前状态后忽略迟到的时间线响应', async () => {
    let finish;
    api.getAgentEvents.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { wrapper } = await render(AgentTasks);
    await button(wrapper, '只读回放').trigger('click');
    await button(wrapper, '当前状态').trigger('click');
    await flushPromises();
    finish({ events: [{ seq: 1, type: 'run.created', at: now }], lastSeq: 1 });
    await flushPromises();
    expect(api.replayAgentRun).not.toHaveBeenCalled();
    expect(button(wrapper, '确认计划并开始')).toBeDefined();
  });

  it('删除最后一个终态运行后回到空状态', async () => {
    run.status = 'completed';
    api.removeAgentRun.mockImplementation(async () => { run = null; return { removed: true }; });
    const { wrapper } = await render(AgentTasks);
    await button(wrapper, '删除运行记录').trigger('click');
    await button(wrapper, '确认').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="agent-run-detail"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('还没有Agent运行记录');
  });

  it('读取失败保留错误提示，不冒充空任务成功', async () => {
    api.listAgentRuns.mockRejectedValueOnce(new Error('数据库暂不可用'));
    const { wrapper } = await render(AgentTasks);
    expect(wrapper.find('[role="alert"]').text()).toContain('数据库暂不可用');
  });
});

describe('工具策略界面', () => {
  it('普通用户只读，管理员也不能打开未接入沙箱工具', async () => {
    const { wrapper } = await render(ToolPolicyPanel, { catalog: makeCatalog(), admin: false });
    expect(wrapper.findAll('select').every(item => item.attributes('disabled') !== undefined)).toBe(true);
    expect(button(wrapper, '保存策略')).toBeUndefined();
    await wrapper.setProps({ admin: true });
    const sandbox = wrapper.find('select[aria-label="Shell 执行策略"]');
    expect(sandbox.attributes('disabled')).toBeDefined();
    expect(sandbox.findAll('option').map(item => item.element.value)).toEqual(['deny']);
    expect(wrapper.find('select[aria-label="保存摘录策略"]').findAll('option').map(item => item.element.value)).not.toContain('allow');
  });

  it('修改规则携带当前策略版本，防止覆盖其他管理员更新', async () => {
    const { wrapper } = await render(ToolPolicyPanel, { catalog: makeCatalog(), admin: true });
    await wrapper.find('select[aria-label="检索资料策略"]').setValue('deny');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('save')[0][0]).toEqual({ tool: 'search_published_sources', effect: 'deny', roles: ['user', 'admin'], version: 0 });
  });
});
