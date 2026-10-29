import { beforeEach, describe, expect, it } from 'vitest';

const { CampusWorkbenchService } = require('../src/services/campus/campus-workbench.service');
const { SourceRadarService, diffSnapshots, SOURCE_KEY } = require('../src/services/campus/source-radar.service');
const { revisionOf, buildEvidenceReport, clipEvidenceSources } = require('../src/services/campus/evidence.service');

function memoryStore() {
  const hashes = new Map();
  return {
    async hget(key, field) { return JSON.parse(hashes.get(key)?.get(field) || 'null'); },
    async hgetall(key) { return Object.fromEntries([...(hashes.get(key) || new Map())].map(([field, value]) => [field, JSON.parse(value)])); },
    async hcompareAndSet(key, field, before, after) {
      if ((hashes.get(key)?.get(field) || 'null') !== JSON.stringify(before)) return false;
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key).set(field, JSON.stringify(after));
      return true;
    },
  };
}

let store;
let entry;
let radar;
let service;
const input = () => ({
  originMessageId: 'message-1',
  context: '演示校区，社团活动',
  card: { summary: '活动场地预约', steps: [{ title: '准备材料', detail: '提交申请表2份。' }, { title: '到现场核验', detail: '在服务大厅核验。' }], materials: ['申请表'], location: '服务大厅' },
  sources: [{ docId: 'doc_demo', revision: entry.currentRevision }],
});
const publish = body => {
  entry = { id: 'doc_demo', title: '场地预约演示说明', visible: true, reviewState: 'published', body, currentRevision: revisionOf(body), sourceLabel: '演示资料', simulated: true };
};
beforeEach(() => {
  store = memoryStore();
  publish('准备材料：提交申请表2份。\n到现场核验：在服务大厅核验。');
  radar = new SourceRadarService({ store, getEntry: async () => entry });
  service = new CampusWorkbenchService({ store, radar });
});

async function activeTask() {
  const created = await service.create('alice', input());
  return service.update('alice', created.task.id, { action: 'confirm', version: created.version });
}

describe('校园办事任务', () => {
  it('草稿、材料和进度存储可跨服务实例恢复，重复创建幂等', async () => {
    const created = await service.create('alice', input());
    expect(created.task.status).toBe('draft');
    expect(created.task.evidence.evidence[0].revision).toBe(entry.currentRevision);
    const again = await service.create('alice', input());
    expect(again.existing).toBe(true);
    expect(again.task.id).toBe(created.task.id);
    let result = await service.update('alice', created.task.id, { action: 'confirm', version: created.version });
    result = await service.update('alice', created.task.id, { action: 'step', stepId: 'step-0', status: 'completed', note: '已准备', dueDate: '2026-11-10', version: result.version });
    result = await service.update('alice', created.task.id, { action: 'material', materialId: 'material-0', ready: true, version: result.version });
    const restored = await new CampusWorkbenchService({ store, radar }).detail('alice', created.task.id);
    expect(restored.task.steps[0]).toMatchObject({ status: 'completed', note: '已准备', dueDate: '2026-11-10' });
    expect(restored.task.materials[0].ready).toBe(true);
    expect((await service.overview('alice')).tasks).toHaveLength(1);
    expect((await service.overview('alice')).tasks[0].evidence).toBeUndefined();
  });

  it('材料清单可人工增删修改，步骤完成但材料未齐仍为进行中', async () => {
    let result = await activeTask();
    for (const step of result.task.steps) result = await service.update('alice', result.task.id, { action: 'step', stepId: step.id, status: 'completed', version: result.version });
    expect(result.task.status).toBe('active');
    result = await service.update('alice', result.task.id, { action: 'material', materialId: 'material-0', ready: true, version: result.version });
    expect(result.task.status).toBe('completed');
    result = await service.update('alice', result.task.id, { action: 'edit_material', materialId: 'material-0', text: '申请表3份', version: result.version });
    expect(result.task.materials[0]).toMatchObject({ text: '申请表3份', ready: false });
    expect(result.task.completedSteps).toBe(2);
    result = await service.update('alice', result.task.id, { action: 'add_material', text: '新增附件', version: result.version });
    expect(result.task.materials).toHaveLength(2);
    result = await service.update('alice', result.task.id, { action: 'remove_material', materialId: result.task.materials[1].id, version: result.version });
    expect(result.task.materials).toHaveLength(1);
  });

  it('用户数据隔离，不能读取、更新或删除别人的任务', async () => {
    const created = await service.create('alice', input());
    expect((await service.overview('bob')).tasks).toEqual([]);
    await expect(service.detail('bob', created.task.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.update('bob', created.task.id, { action: 'archive', version: 0 })).rejects.toMatchObject({ status: 404 });
    await expect(service.remove('bob', created.task.id, 0)).rejects.toMatchObject({ status: 404 });
  });

  it('未确认草稿不能标记办理完成，来源未审核或已变更不能创建', async () => {
    const created = await service.create('alice', input());
    await expect(service.update('alice', created.task.id, { action: 'step', stepId: 'step-0', status: 'completed', version: created.version })).rejects.toMatchObject({ status: 409 });
    const staleInput = { ...input(), originMessageId: 'message-2' };
    publish('申请表改为3份。');
    await expect(service.create('alice', staleInput)).rejects.toMatchObject({ status: 409 });
    entry.stale = true;
    await expect(service.create('bob', input())).rejects.toMatchObject({ status: 409 });
  });

  it('并行更新只允许一个成功，过期版本不会覆盖已保存内容', async () => {
    const created = await activeTask();
    const outcomes = await Promise.allSettled([
      service.update('alice', created.task.id, { action: 'details', title: '标题A', version: created.version }),
      service.update('alice', created.task.id, { action: 'details', title: '标题B', version: created.version }),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected').reason.status).toBe(409);
    await expect(service.update('alice', created.task.id, { action: 'archive', version: 0 })).rejects.toMatchObject({ status: 409 });
  });

  it('严格验证状态、日期、材料类型和来源标识', async () => {
    const created = await activeTask();
    await expect(service.update('alice', created.task.id, { action: 'step', stepId: 'step-0', status: 'invented', version: created.version })).rejects.toMatchObject({ status: 400 });
    await expect(service.update('alice', created.task.id, { action: 'details', dueDate: '2026-02-30', version: created.version })).rejects.toMatchObject({ status: 400 });
    await expect(service.create('bob', { ...input(), card: { ...input().card, materials: [{}] } })).rejects.toMatchObject({ status: 400 });
    await expect(service.subscribe('bob', '../../private')).rejects.toMatchObject({ status: 400 });
  });

  it('归档任务不可修改，删除任务不删独立订阅', async () => {
    let result = await activeTask();
    result = await service.update('alice', result.task.id, { action: 'archive', version: result.version });
    await expect(service.update('alice', result.task.id, { action: 'details', title: 'no', version: result.version })).rejects.toMatchObject({ status: 409 });
    result = await service.update('alice', result.task.id, { action: 'restore', version: result.version });
    await service.remove('alice', result.task.id, result.version);
    const overview = await service.overview('alice');
    expect(overview.tasks).toHaveLength(0);
    expect(overview.subscriptions).toHaveLength(1);
  });
});

describe('审核来源变化与任务影响', () => {
  it('新旧差异可见，只有显式确认才更新任务依据，已完成进度保留', async () => {
    let result = await activeTask();
    result = await service.update('alice', result.task.id, { action: 'step', stepId: 'step-0', status: 'completed', version: result.version });
    const beforeRevision = entry.currentRevision;
    publish('准备材料：提交申请表3份。\n到现场核验：在服务大厅核验。');
    await service.refresh('alice');
    const pending = await service.detail('alice', result.task.id);
    expect(pending.task.needsReview).toBe(true);
    expect(pending.task.sources[0].revision).toBe(beforeRevision);
    expect(pending.task.sourceChanges[0].diff.added).toContain('准备材料：提交申请表3份。');
    expect(pending.task.evidence.evidence.some(item => item.quote.includes('2份'))).toBe(true);
    result = await service.update('alice', result.task.id, { action: 'acknowledge_source', docId: 'doc_demo', revision: entry.currentRevision, version: result.version });
    expect(result.task.needsReview).toBe(false);
    expect(result.task.steps[0].status).toBe('completed');
    expect(result.task.steps[0].detail).toContain('2份');
    expect(result.task.evidence.evidence.some(item => item.needsReview)).toBe(true);
    expect(result.task.history.at(-1).action).toContain('保留办理进度');
  });

  it('订阅已读不代替任务确认，确认过期的目标版本会被拒绝', async () => {
    const result = await activeTask();
    publish('材料：提交申请表3份。');
    await service.refresh('alice');
    const observedRevision = entry.currentRevision;
    await service.updateSubscription('alice', 'doc_demo', { action: 'acknowledge', revision: observedRevision, version: result.version });
    let overview = await service.overview('alice');
    expect(overview.subscriptions[0].changed).toBe(false);
    expect(overview.tasks[0].needsReview).toBe(true);
    publish('材料：提交申请表4份。');
    await expect(service.update('alice', result.task.id, { action: 'acknowledge_source', docId: 'doc_demo', revision: observedRevision, version: overview.version })).rejects.toMatchObject({ status: 409 });
  });

  it('下架和待审核正文不泄漏到变化提醒，引用只标记不可用', async () => {
    await activeTask();
    publish('尚未审核的新内容SECRET');
    entry.stale = true;
    await service.refresh('alice');
    const overview = await service.overview('alice');
    expect(overview.subscriptions[0]).toMatchObject({ available: false, changed: true });
    expect(JSON.stringify(overview)).not.toContain('SECRET');
    expect(JSON.stringify(await radar.state('doc_demo'))).not.toContain('SECRET');
  });

  it('只保留8个观测版本，旧基线缺失会明确提示而非伪造差异', async () => {
    const result = await activeTask();
    for (let index = 3; index < 13; index++) {
      publish(`提交申请表${index}份。`);
      await radar.capture('doc_demo');
    }
    expect((await store.hget(SOURCE_KEY, 'doc_demo')).versions).toHaveLength(8);
    const detail = await service.detail('alice', result.task.id);
    expect(detail.task.sourceChanges[0].diff.unavailableBaseline).toBe(true);
    expect(detail.task.evidence.evidence.some(item => item.quote.includes('2份'))).toBe(true);
  });

  it('后台轮询仍检查取消独立订阅的活跃任务来源', async () => {
    const result = await activeTask();
    await service.updateSubscription('alice', 'doc_demo', { action: 'unsubscribe', version: result.version });
    publish('提交申请表3份。');
    expect(await radar.checkAll()).toEqual({ checked: 1 });
    expect((await service.detail('alice', result.task.id)).task.needsReview).toBe(true);
  });

  it('变化对比忽略空行，不遗漏重复行删除', () => {
    const diff = diffSnapshots({ text: 'A\nA\n\nB' }, { text: 'A\n B \n\n' });
    expect(diff.removed).toEqual(['A']);
    expect(diff.added).toEqual([]);
  });
});

describe('结论级证据', () => {
  it('引用文本是快照内原文，数字不同只标记待核验', () => {
    const source = { docId: 'doc_1', title: '说明', revision: 'rev1', start: 20, text: '需要提交申请表3份。\n周末正常开放。' };
    const report = buildEvidenceReport({ answer: '需要提交申请表2份。\n周末正常开放。\n月球开设了材料窗口。', sources: [source] });
    expect(report.claims[0].status).toBe('candidate');
    expect(report.evidence.find(item => item.claimId === 'claim-0').needsReview).toBe(true);
    expect(report.claims[1].status).toBe('exact');
    expect(report.claims[2].status).toBe('unverified');
    for (const item of report.evidence) expect(source.text.slice(item.start - 20, item.end - 20)).toBe(item.quote);
    expect(report.notice).toContain('不等于事实正确');
  });

  it('裁剪来源范围只保留真正落入最终上下文的文本', () => {
    expect(clipEvidenceSources([{ docId: 'd', start: 10, text: 'abcdefghij' }], 0, 15)).toEqual([{ docId: 'd', start: 10, text: 'abcde' }]);
    expect(clipEvidenceSources([{ docId: 'd', start: 10, text: 'abcdefghij' }], 15, 20, 30)).toEqual([{ docId: 'd', start: 30, text: 'fghij' }]);
  });

  it('历史回答复核明确标注当前来源，不能冒充生成时的引用', async () => {
    const report = await service.reviewEvidence({ answer: '准备材料：提交申请表2份。', sources: [{ docId: 'doc_demo' }] });
    expect(report.origin).toBe('current_published_sources');
    expect(report.sources[0].revision).toBe(entry.currentRevision);
  });
});
