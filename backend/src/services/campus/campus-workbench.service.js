'use strict';

const crypto = require('crypto');
const { buildEvidenceReport } = require('./evidence.service');
const { SourceRadarService, USER_KEY, campusError, parseRecord, validateId } = require('./source-radar.service');

const STEP_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'completed']);
const MAX_TASKS = 60;
const MAX_SUBSCRIPTIONS = 40;

function text(value, max, label, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw campusError(`${label}不能为空或超过 ${max} 字`);
  return value.trim();
}

function dueDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw campusError('截止日期无效');
  return value;
}

function sourceRefs(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) throw campusError('请选择 1–8 个已上架来源');
  return input.map(item => ({ docId: validateId(item?.docId, '来源'), revision: text(item.revision, 128, '来源版本') }))
    .filter((item, index, all) => all.findIndex(other => other.docId === item.docId) === index);
}

const refOf = source => ({ docId: source.docId, title: source.title, revision: source.revision, reviewedAt: source.reviewedAt, simulated: source.simulated });

class CampusWorkbenchService {
  constructor({ store, radar, clock = () => Date.now() } = {}) {
    this.store = store || require('../memory/memory-store.service').redis;
    this.radar = radar || new SourceRadarService({ store: this.store, clock });
    this.clock = clock;
  }

  async read(userId) {
    if (!userId || String(userId).length > 200) throw campusError('请先登录', 401);
    const stored = parseRecord(await this.store.hget(USER_KEY, String(userId)));
    return { stored, state: stored ? JSON.parse(JSON.stringify(stored)) : { version: 0, tasks: [], subscriptions: [] } };
  }

  async save(userId, stored, state) {
    state.version = (stored?.version || 0) + 1;
    if (!await this.store.hcompareAndSet(USER_KEY, String(userId), stored, state)) throw campusError('工作台已在其他页面更新，请刷新后重试', 409);
    return state.version;
  }

  assertVersion(state, version) {
    if (!Number.isInteger(version) || state.version !== version) throw campusError('工作台版本已变化，请刷新后重试', 409);
  }

  task(state, id) {
    validateId(id, '任务');
    const task = state.tasks.find(item => item.id === id);
    if (!task) throw campusError('任务不存在', 404);
    return task;
  }

  record(task, action) {
    task.updatedAt = new Date(this.clock()).toISOString();
    task.history = [...(task.history || []), { action, at: task.updatedAt }].slice(-30);
  }

  async snapshots(refs, { refresh = false } = {}) {
    const snapshots = [];
    for (const ref of refs) {
      const state = refresh ? await this.radar.capture(ref.docId) : await this.radar.state(ref.docId);
      const version = state?.versions.find(item => item.revision === ref.revision);
      if (version) snapshots.push(version);
    }
    return snapshots;
  }

  async decorate(task, detailed = false) {
    const changes = await Promise.all(task.sources.map(source => this.radar.change(source.docId, source.revision)));
    const completed = task.steps.filter(step => step.status === 'completed').length;
    const result = {
      ...task, evidence: undefined,
      completedSteps: completed,
      status: task.archived ? 'archived' : !task.confirmedAt ? 'draft' : completed === task.steps.length && task.materials.every(item => item.ready) ? 'completed' : 'active',
      needsReview: changes.some(change => change.changed),
      changedSourceCount: changes.filter(change => change.changed).length,
      nextStep: task.steps.find(step => step.status !== 'completed')?.id || null,
    };
    if (detailed) {
      result.evidence = task.evidence;
      result.sourceChanges = changes.map(change => ({
        ...change,
        relatedStepIds: [...new Set((task.evidence?.evidence || []).filter(item => item.docId === change.docId).map(item => item.claimId))]
          .filter(id => task.steps.some(step => step.id === id)),
      }));
    }
    return result;
  }

  async overview(userId) {
    const { state } = await this.read(userId);
    const tasks = await Promise.all(state.tasks.map(task => this.decorate(task)));
    const subscriptions = await Promise.all(state.subscriptions.map(async subscription => ({
      ...subscription, ...await this.radar.change(subscription.docId, subscription.revision),
      baselineRevision: subscription.revision,
      taskIds: state.tasks.filter(task => !task.archived && task.sources.some(source => source.docId === subscription.docId)).map(task => task.id),
    })));
    return { version: state.version, tasks: tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), subscriptions };
  }

  async detail(userId, taskId) {
    const { state } = await this.read(userId);
    return { version: state.version, task: await this.decorate(this.task(state, taskId), true) };
  }

  async create(userId, input = {}) {
    const originMessageId = text(input.originMessageId, 160, '消息标识', true);
    const { stored, state } = await this.read(userId);
    const existing = state.tasks.find(task => task.originMessageId === originMessageId);
    if (existing) return { version: state.version, task: await this.decorate(existing, true), existing: true };
    if (state.tasks.length >= MAX_TASKS) throw campusError('任务已达 60 个，请先删除不再需要的任务', 409);
    const card = input.card;
    if (!card || !Array.isArray(card.steps) || !card.steps.length || card.steps.length > 30 || card.steps.some(step => !step || typeof step !== 'object' || Array.isArray(step))) throw campusError('流程需包含 1–30 个有效步骤');
    const refs = sourceRefs(input.sources);
    const sources = await Promise.all(refs.map(ref => this.radar.published(ref.docId, ref.revision)));
    const now = new Date(this.clock()).toISOString();
    const task = {
      id: `task_${crypto.randomUUID()}`, originMessageId,
      title: text(input.title || card.summary || '我的办事计划', 180, '任务标题', true),
      context: text(input.context, 500, '办理条件'),
      location: text(card.location, 500, '办理地点'), duration: text(card.duration, 300, '预计耗时'), notes: text(card.notes, 1200, '提示'),
      dueDate: dueDate(input.dueDate),
      sources: sources.map(refOf),
      steps: card.steps.map((step, index) => ({ id: `step-${index}`, title: text(step.title, 200, '步骤标题', true), detail: text(step.detail, 1200, '步骤说明'), status: 'pending', note: '', dueDate: null })),
      materials: [], confirmedAt: null, archived: false, createdAt: now, updatedAt: now, history: [],
    };
    if (card.materials != null && (!Array.isArray(card.materials) || card.materials.length > 40)) throw campusError('材料清单最多 40 项');
    task.materials = (card.materials || []).map((item, index) => ({ id: `material-${index}`, text: text(item, 500, '材料名称', true), ready: false }));
    task.evidence = buildEvidenceReport({ card: task, sources, origin: 'plan_creation_snapshot' });
    this.record(task, '从流程卡创建个人草稿，尚未确认');
    state.tasks.push(task);
    for (const source of sources) {
      if (!state.subscriptions.some(item => item.docId === source.docId)) {
        if (state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw campusError('订阅已达 40 项，请先取消不需要的订阅', 409);
        state.subscriptions.push({ docId: source.docId, title: source.title, revision: source.revision, createdAt: now });
      }
    }
    const version = await this.save(userId, stored, state);
    return { version, task: await this.decorate(task, true), existing: false };
  }

  async update(userId, taskId, input = {}) {
    const { stored, state } = await this.read(userId);
    const task = this.task(state, taskId);
    this.assertVersion(state, input.version);
    if (task.archived && input.action !== 'restore') throw campusError('请先恢复已归档任务', 409);
    if (input.action === 'confirm') {
      for (const source of task.sources) await this.radar.published(source.docId, source.revision);
      task.confirmedAt = new Date(this.clock()).toISOString();
      this.record(task, '用户核对来源与适用条件后确认计划（非发布方审核）');
    } else if (input.action === 'step') {
      if (!task.confirmedAt) throw campusError('请先核对并确认计划', 409);
      const step = task.steps.find(item => item.id === input.stepId);
      if (!step) throw campusError('步骤不存在', 404);
      if (!STEP_STATUSES.has(input.status)) throw campusError('步骤状态无效');
      step.status = input.status;
      if (input.note !== undefined) step.note = text(input.note, 1000, '步骤备注');
      if (input.dueDate !== undefined) step.dueDate = dueDate(input.dueDate);
      this.record(task, `更新步骤：${step.title}`);
    } else if (input.action === 'material') {
      const material = task.materials.find(item => item.id === input.materialId);
      if (!material || typeof input.ready !== 'boolean') throw campusError('材料或准备状态无效');
      material.ready = input.ready;
      this.record(task, `更新材料：${material.text}`);
    } else if (['add_material', 'edit_material', 'remove_material'].includes(input.action)) {
      let material = task.materials.find(item => item.id === input.materialId);
      if (input.action === 'add_material') {
        if (task.materials.length >= 40) throw campusError('材料清单最多 40 项');
        material = { id: `material-${crypto.randomUUID()}`, ready: false };
        task.materials.push(material);
      }
      if (!material) throw campusError('材料不存在', 404);
      if (input.action === 'remove_material') task.materials = task.materials.filter(item => item.id !== material.id);
      else { material.text = text(input.text, 500, '材料名称', true); material.ready = false; }
      task.evidence = buildEvidenceReport({ card: task, sources: await this.snapshots(task.sources), origin: 'plan_review_snapshot' });
      this.record(task, `手动调整材料清单：${material.text}`);
    } else if (input.action === 'details') {
      task.title = text(input.title ?? task.title, 180, '任务标题', true);
      task.context = text(input.context ?? task.context, 500, '办理条件');
      task.dueDate = dueDate(input.dueDate === undefined ? task.dueDate : input.dueDate);
      this.record(task, '更新个人办理条件与截止日期');
    } else if (input.action === 'edit_step' || input.action === 'add_step') {
      let step = task.steps.find(item => item.id === input.stepId);
      if (input.action === 'add_step') {
        if (task.steps.length >= 30) throw campusError('最多 30 个步骤');
        step = { id: `step-${crypto.randomUUID()}`, status: 'pending', note: '', dueDate: null };
        task.steps.push(step);
      }
      if (!step) throw campusError('步骤不存在', 404);
      step.title = text(input.title, 200, '步骤标题', true);
      step.detail = text(input.detail, 1200, '步骤说明');
      step.status = 'pending';
      task.evidence = buildEvidenceReport({ card: task, sources: await this.snapshots(task.sources), origin: 'plan_review_snapshot' });
      this.record(task, '手动调整步骤内容，该步骤重新设为待办');
    } else if (input.action === 'acknowledge_source') {
      const source = task.sources.find(item => item.docId === input.docId);
      if (!source) throw campusError('任务未引用该来源', 404);
      const snapshot = await this.radar.published(source.docId, text(input.revision, 128, '确认版本', true));
      const oldRevision = source.revision;
      Object.assign(source, refOf(snapshot));
      task.evidence = buildEvidenceReport({ card: task, sources: await this.snapshots(task.sources), origin: 'plan_review_snapshot' });
      this.record(task, `确认来源变更：${source.title}（${oldRevision.slice(0, 8)} → ${source.revision.slice(0, 8)}）；保留办理进度`);
    } else if (input.action === 'archive' || input.action === 'restore') {
      task.archived = input.action === 'archive';
      this.record(task, task.archived ? '归档任务' : '恢复任务');
    } else {
      throw campusError('不支持的任务操作');
    }
    const version = await this.save(userId, stored, state);
    return { version, task: await this.decorate(task, true) };
  }

  async remove(userId, taskId, version) {
    const { stored, state } = await this.read(userId);
    this.task(state, taskId);
    this.assertVersion(state, version);
    state.tasks = state.tasks.filter(task => task.id !== taskId);
    return { version: await this.save(userId, stored, state) };
  }

  async subscribe(userId, docId) {
    const { stored, state } = await this.read(userId);
    if (state.subscriptions.some(item => item.docId === docId)) return { version: state.version };
    if (state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw campusError('订阅已达 40 项', 409);
    const snapshot = await this.radar.published(validateId(docId, '来源'));
    state.subscriptions.push({ docId, title: snapshot.title, revision: snapshot.revision, createdAt: new Date(this.clock()).toISOString() });
    return { version: await this.save(userId, stored, state) };
  }

  async updateSubscription(userId, docId, input = {}) {
    const { stored, state } = await this.read(userId);
    this.assertVersion(state, input.version);
    const subscription = state.subscriptions.find(item => item.docId === docId);
    if (!subscription) throw campusError('订阅不存在', 404);
    if (input.action === 'unsubscribe') {
      state.subscriptions = state.subscriptions.filter(item => item.docId !== docId);
    } else if (input.action === 'acknowledge') {
      const snapshot = await this.radar.published(docId, text(input.revision, 128, '确认版本', true));
      subscription.revision = snapshot.revision;
      subscription.title = snapshot.title;
    } else throw campusError('不支持的订阅操作');
    return { version: await this.save(userId, stored, state) };
  }

  async refresh(userId) {
    const { state } = await this.read(userId);
    const ids = new Set([...state.subscriptions.map(item => item.docId), ...state.tasks.filter(task => !task.archived).flatMap(task => task.sources.map(source => source.docId))]);
    for (const docId of ids) await this.radar.capture(docId);
    return this.overview(userId);
  }

  async reviewEvidence(input = {}) {
    const answer = text(input.answer, 24000, '待核验回答', true);
    const refs = sourceRefs(input.sources);
    const snapshots = await Promise.all(refs.map(ref => this.radar.published(ref.docId)));
    return buildEvidenceReport({ answer, sources: snapshots, origin: 'current_published_sources' });
  }
}

module.exports = { CampusWorkbenchService, STEP_STATUSES };
