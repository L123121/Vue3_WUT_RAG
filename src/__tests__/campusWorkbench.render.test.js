import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import CampusWorkbench from '../views/CampusWorkbench.vue';
import EvidencePanel from '../components/campus/EvidencePanel.vue';
import CreateTaskAction from '../components/campus/CreateTaskAction.vue';
import MessageEvidenceFragment from '../components/campus/MessageEvidenceFragment.vue';
import * as api from '../api/campus.js';
import { getWikiEntries } from '../api/wiki.js';
import { dispatchRunEvent } from '../utils/runEvents.js';
import { createMessagePatchHandlers } from '../composables/streaming/messagePatches.js';
import { clearMessageAttemptState } from '../utils/messageFragments.js';

vi.mock('../api/campus.js', () => ({
  getWorkbench: vi.fn(), getCampusTask: vi.fn(), createCampusTask: vi.fn(), updateCampusTask: vi.fn(),
  deleteCampusTask: vi.fn(), subscribeSource: vi.fn(), updateSourceSubscription: vi.fn(), refreshWorkbench: vi.fn(), reviewAnswerEvidence: vi.fn(),
}));
vi.mock('../api/wiki.js', () => ({ getWikiEntries: vi.fn() }));

const clone = value => JSON.parse(JSON.stringify(value));
const report = () => ({
  version: 1, origin: 'retrieval_snapshot', notice: '词面相关不等于事实正确',
  sources: [{ docId: 'doc_demo', title: '已发布说明', revision: 'rev1' }, { docId: 'doc_other', title: '补充说明', revision: 'rev2' }],
  claims: [{ id: 'step-0', kind: 'step', text: '准备申请表' }, { id: 'step-1', kind: 'step', text: '服务大厅办理' }],
  evidence: [{ id: 'e1', claimId: 'step-0', docId: 'doc_demo', revision: 'rev1', title: '已发布说明', quote: '准备申请表。', match: 'exact' }, { id: 'e2', claimId: 'step-1', docId: 'doc_other', title: '补充说明', quote: '<img src=x onerror=alert(1)>服务大厅办理。', match: 'candidate' }],
});
const makeTask = () => ({
  id: 'task_demo', title: '场地预约计划', context: '演示校区', dueDate: '2026-11-10', status: 'draft',
  sources: [{ docId: 'doc_demo', title: '已发布说明', revision: 'rev1' }],
  sourceChanges: [], evidence: report(), needsReview: false, confirmedAt: null, archived: false,
  steps: [{ id: 'step-0', title: '准备申请表', detail: '核对后提交', status: 'pending', note: '', dueDate: null }, { id: 'step-1', title: '现场办理', detail: '', status: 'pending', note: '', dueDate: null }],
  materials: [{ id: 'material-0', text: '申请表', ready: false }],
  completedSteps: 0, nextStep: 'step-0', createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', history: [],
});
let task;
let stateVersion;
const wrappers = [];
const overview = () => ({ version: stateVersion, tasks: task ? [clone(task)] : [], subscriptions: [] });

beforeEach(() => {
  vi.clearAllMocks();
  stateVersion = 1;
  task = makeTask();
  api.getWorkbench.mockImplementation(async () => overview());
  api.refreshWorkbench.mockImplementation(async () => overview());
  api.getCampusTask.mockImplementation(async () => ({ version: stateVersion, task: clone(task) }));
  api.updateCampusTask.mockImplementation(async (_id, input) => {
    stateVersion++;
    if (input.action === 'confirm') { task.confirmedAt = '2026-10-29T01:00:00Z'; task.status = 'active'; }
    if (input.action === 'step') { Object.assign(task.steps.find(step => step.id === input.stepId), { status: input.status, note: input.note, dueDate: input.dueDate }); }
    if (input.action === 'material') task.materials[0].ready = input.ready;
    if (input.action === 'acknowledge_source') { task.sources[0].revision = input.revision; task.needsReview = false; task.sourceChanges = []; }
    task.completedSteps = task.steps.filter(step => step.status === 'completed').length;
    return { version: stateVersion, task: clone(task) };
  });
  getWikiEntries.mockResolvedValue({ success: true, data: { entries: [{ id: 'doc_demo', title: '已发布说明' }] } });
});
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

async function render(component, props = {}, location = '/workbench?task=task_demo') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/workbench', component: { template: '<div />' } }, { path: '/chat', component: { template: '<div />' } },
    { path: '/wiki/:id', component: { template: '<div />' } },
  ] });
  await router.push(location);
  const wrapper = mount(component, { props, global: { plugins: [createPinia(), router], stubs: { MobileMenuButton: true, Teleport: true } } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, router };
}
const button = (wrapper, text) => wrapper.findAll('button').find(item => item.text() === text);

describe('校园工作台交互', () => {
  it('没有任务时提供可操作的空状态', async () => {
    task = null;
    const { wrapper } = await render(CampusWorkbench);
    expect(wrapper.text()).toContain('把一次提问，变成一份可继续的计划');
    expect(wrapper.find('a[href="/chat"]').exists()).toBe(true);
    expect(api.refreshWorkbench).toHaveBeenCalledOnce();
  });

  it('确认后才可改变步骤状态，保存后的材料和进度在重挂载时恢复', async () => {
    const { wrapper } = await render(CampusWorkbench);
    expect(wrapper.find('select[aria-label="准备申请表状态"]').attributes('disabled')).toBeDefined();
    const accept = wrapper.findAll('input[type="checkbox"]').find(input => input.element.parentElement.textContent.includes('我已查看依据'));
    await accept.setValue(true);
    await button(wrapper, '确认并开始办理').trigger('click');
    await flushPromises();
    expect(api.updateCampusTask).toHaveBeenCalledWith('task_demo', { action: 'confirm', version: 1 });
    await wrapper.find('select[aria-label="准备申请表状态"]').setValue('completed');
    await flushPromises();
    const material = wrapper.findAll('input[type="checkbox"]').find(input => input.element.parentElement.textContent.trim() === '申请表');
    await material.setValue(true);
    await flushPromises();
    wrapper.unmount();
    const restored = (await render(CampusWorkbench)).wrapper;
    expect(restored.find('select[aria-label="准备申请表状态"]').element.value).toBe('completed');
    expect(restored.text()).toContain('1 / 2 个步骤完成');
    expect(restored.text()).toContain('1 / 1 项材料就绪');
  });

  it('来源影响必须经过确认对话框，确认不会清除已完成步骤', async () => {
    task.confirmedAt = '2026-10-29T01:00:00Z';
    task.status = 'active';
    task.steps[0].status = 'completed';
    task.completedSteps = 1;
    task.needsReview = true;
    task.sourceChanges = [{ docId: 'doc_demo', title: '已发布说明', available: true, changed: true, previousRevision: 'rev1', revision: 'rev2', relatedStepIds: ['step-0'], diff: { added: ['新增材料'], removed: ['原材料'], fields: ['材料'] } }];
    const { wrapper } = await render(CampusWorkbench);
    await button(wrapper, '我已核对，确认此版本').trigger('click');
    expect(api.updateCampusTask).not.toHaveBeenCalled();
    await button(wrapper, '确认').trigger('click');
    await flushPromises();
    expect(api.updateCampusTask).toHaveBeenCalledWith('task_demo', { action: 'acknowledge_source', docId: 'doc_demo', revision: 'rev2', version: 1 });
    expect(wrapper.find('select[aria-label="准备申请表状态"]').element.value).toBe('completed');
  });

  it('检查失败明确展示已保存状态，不把空列表误作成功', async () => {
    api.refreshWorkbench.mockRejectedValueOnce(new Error('暂时不可用'));
    const { wrapper } = await render(CampusWorkbench);
    expect(wrapper.find('[role="alert"]').text()).toContain('检查更新失败，以下为已保存状态');
    expect(wrapper.text()).toContain('场地预约计划');
  });

  it('版本冲突不假装保存成功，重新读取服务器状态', async () => {
    api.updateCampusTask.mockRejectedValueOnce(Object.assign(new Error('版本冲突'), { status: 409 }));
    const { wrapper } = await render(CampusWorkbench);
    await button(wrapper, '保存条件与日期').trigger('submit');
    await flushPromises();
    expect(api.getWorkbench).toHaveBeenCalled();
    expect(task.title).toBe('场地预约计划');
  });
});

describe('证据查看与创建入口', () => {
  it('排除来源保持结论总数不变，原文以文本渲染', async () => {
    const { wrapper } = await render(EvidencePanel, { report: report() });
    expect(wrapper.text()).toContain('2 / 2 条有可查看片段');
    expect(wrapper.find('img').exists()).toBe(false);
    for (const checkbox of wrapper.findAll('input[type="checkbox"]')) await checkbox.setValue(false);
    expect(wrapper.text()).toContain('0 / 2 条有可查看片段');
    expect(wrapper.findAll('details')).toHaveLength(2);
    expect(wrapper.text()).toContain('未找到对应片段');
  });

  it('缺少生成快照的回答仅在用户请求时复核，明确当前来源口径', async () => {
    api.reviewAnswerEvidence.mockResolvedValue({ ...report(), origin: 'current_published_sources' });
    const { wrapper } = await render(MessageEvidenceFragment, { answer: '准备申请表后办理。', sources: [{ docId: 'doc_demo', title: '说明' }] });
    expect(api.reviewAnswerEvidence).not.toHaveBeenCalled();
    await button(wrapper, '按当前来源核验').trigger('click');
    await flushPromises();
    expect(api.reviewAnswerEvidence).toHaveBeenCalledWith({ answer: '准备申请表后办理。', sources: [{ docId: 'doc_demo' }] });
    await wrapper.find('[data-testid="evidence-panel"] > button').trigger('click');
    expect(wrapper.text()).toContain('不是生成时的上下文');
    await wrapper.setProps({ disabled: true });
    expect(wrapper.find('[data-testid="evidence-panel"]').exists()).toBe(false);
  });

  it('复核中的旧回答被替换后，不接受迟到的证据附件', async () => {
    let finish;
    api.reviewAnswerEvidence.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { wrapper } = await render(MessageEvidenceFragment, { answer: '原来的回答', sources: [{ docId: 'doc_demo' }] });
    await button(wrapper, '按当前来源核验').trigger('click');
    await wrapper.setProps({ answer: '重新生成的回答' });
    finish(report());
    await flushPromises();
    expect(wrapper.find('[data-testid="evidence-panel"]').exists()).toBe(false);
  });

  it('流程卡创建会发送来源版本、去重引用并打开任务', async () => {
    api.createCampusTask.mockResolvedValue({ task: { id: 'task_demo' }, existing: false });
    const { wrapper, router } = await render(CreateTaskAction, { card: { summary: '办理', steps: [{ title: '核对' }] }, messageId: 'm1', sources: [{ id: 'doc_demo', sourceRevision: 'rev1' }, { docId: 'doc_demo', revision: 'rev1' }] }, '/chat');
    await button(wrapper, '保存为办事任务').trigger('click');
    await wrapper.find('textarea').setValue('演示校区');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.createCampusTask).toHaveBeenCalledWith(expect.objectContaining({ originMessageId: 'm1', context: '演示校区', sources: [{ docId: 'doc_demo', revision: 'rev1' }] }));
    expect(router.currentRoute.value.query.task).toBe('task_demo');
  });

  it('标准证据事件进入消息补丁并在重试时清空', () => {
    let message = { id: 'm1', role: 'model', content: '答案' };
    const handlers = createMessagePatchHandlers({ writeMessage: (_conversation, _id, update) => { message = update(message); }, conversationId: 'c1', aiMsgId: 'm1' });
    dispatchRunEvent({ v: 1, runId: 'run_evidence', attempt: 0, seq: 1, type: 'evidence', data: { evidence: report() } }, handlers);
    expect(message.evidence.claims).toHaveLength(2);
    expect(clearMessageAttemptState(message).evidence).toBeNull();
  });
});
