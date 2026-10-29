'use strict';

const { randomUUID } = require('crypto');
const { getAgentRuntimeStore } = require('./runtime-store.service');
const { ToolPolicyService } = require('./tool-policy.service');
const { getTool, validatePlan, researchPlan, planDigest } = require('./tool-catalog');
const { LIMITS, TERMINAL, copy, digest, event, identifier, shortText, runtimeError, resolveInput, publicRun, replay } = require('./runtime-values');

const getPrincipal = userId => require('../auth/auth.service').getUserById(userId);
const approvalDigest = (run, step, input, policyVersion) => digest({
  runId: run.id, planVersion: run.planVersion, planHash: run.planHash, stepId: step.id,
  tool: step.tool, toolVersion: step.toolVersion, attempt: step.attempts + 1, input, policyVersion,
  dependencies: step.dependsOn.map(id => run.steps.find(item => item.id === id)?.resultHash),
});

class RunCoordinator {
  constructor({ store = getAgentRuntimeStore(), policy, principal = getPrincipal, clock = () => Date.now(), getDefinition = getTool } = {}) {
    this.store = store;
    this.policy = policy || new ToolPolicyService({ store, clock });
    this.principal = principal;
    this.clock = clock;
    this.getDefinition = getDefinition;
  }

  async actor(userId) {
    const user = await this.principal(userId);
    if (!user?.id || user.approved === false || !['user', 'admin'].includes(user.role)) throw runtimeError('用户不存在或无运行权限', 'FORBIDDEN', 403);
    return { id: String(user.id), role: user.role, approved: true };
  }

  async owned(userId, id) {
    identifier(id, '运行标识');
    const record = await this.store.getRun(id);
    if (!record || record.value.ownerId !== String(userId)) throw runtimeError('运行不存在', 'NOT_FOUND', 404);
    return record;
  }

  async mutate(id, change) {
    let generation;
    for (let attempt = 0; attempt < 12; attempt++) {
      const record = await this.store.getRun(id);
      if (!record) throw runtimeError('运行不存在', 'NOT_FOUND', 404);
      if (generation && generation !== record.value.generation) throw runtimeError('运行已被删除并重建，请重新加载', 'GENERATION_CHANGED', 409);
      generation = record.value.generation;
      const run = copy(record.value);
      const value = change(run);
      if (value === false) return null;
      if (await this.store.saveRun(record, run)) return { run, value };
    }
    throw runtimeError('运行状态正在被更新，请重试', 'VERSION_CONFLICT', 409);
  }

  async ownedChange(userId, id, version, change) {
    await this.actor(userId);
    return this.mutate(id, run => {
      if (run.ownerId !== String(userId)) throw runtimeError('运行不存在', 'NOT_FOUND', 404);
      if (!Number.isInteger(version) || version !== run.version) throw runtimeError('运行已变化，请刷新后重试', 'VERSION_CONFLICT', 409);
      return change(run);
    });
  }

  async create(userId, input = {}) {
    const actor = await this.actor(userId);
    const requestId = identifier(input.requestId, '幂等请求标识');
    const id = `ar_${digest([actor.id, requestId]).slice(0, 40)}`;
    const existing = await this.store.getRun(id);
    if (existing) return { run: publicRun(existing.value), existing: true };
    const now = this.clock();
    const goal = shortText(input.goal, 1000, '任务目标');
    const title = shortText(input.title || goal.slice(0, 160), 160, '计划标题');
    const rawPlan = input.steps || researchPlan(goal, input.queries, input.persist !== false, input.startAt || 0);
    const steps = validatePlan(rawPlan, { now, getDefinition: this.getDefinition });
    const maxCalls = input.maxCalls === undefined ? LIMITS.calls : input.maxCalls;
    if (!Number.isInteger(maxCalls) || maxCalls < steps.length || maxCalls > LIMITS.calls) throw runtimeError(`调用预算需介于步骤数和 ${LIMITS.calls} 之间`);
    if ((await this.store.listRuns(actor.id)).length >= 50) throw runtimeError('最多保存50个运行，请删除不再需要的终态运行', 'RUN_LIMIT', 409);
    const run = {
      id, generation: randomUUID(), ownerId: actor.id, title, goal, version: 0, planVersion: 1, planHash: planDigest(steps),
      status: 'draft', steps, events: [], createdAt: now, updatedAt: now,
      expiresAt: now + LIMITS.lifetimeMs, availableAt: now + LIMITS.lifetimeMs,
      lease: null, calls: 0, maxCalls, resumes: 0, checkpointSeq: 0, error: null,
    };
    event(run, 'run.created', steps, { planning: 'explicit_dag', execution: 'dedicated_worker', modelCalls: 0 }, now);
    const created = await this.store.createRun(run);
    const saved = created ? run : (await this.store.getRun(id))?.value;
    if (!saved) throw runtimeError('运行数量已达上限', 'RUN_LIMIT', 409);
    return { run: publicRun(saved), existing: !created };
  }

  async list(userId) {
    await this.actor(userId);
    const records = await this.store.listRuns(String(userId));
    const heartbeat = await this.store.getValue('worker', 'agent-runtime');
    return {
      runs: records.map(({ value }) => ({ ...publicRun(value), steps: value.steps.map(({ id, label, status, tool, attempts }) => ({ id, label, status, tool, attempts })) })),
      workerOnline: Boolean(heartbeat && this.clock() - heartbeat.value.at < 15000),
      storage: this.store.backend || 'injected',
    };
  }

  async get(userId, id) {
    await this.actor(userId);
    return publicRun((await this.owned(userId, id)).value);
  }

  async edit(userId, id, input) {
    const steps = validatePlan(input.steps, { now: this.clock(), getDefinition: this.getDefinition });
    const result = await this.ownedChange(userId, id, input.version, run => {
      if (run.status !== 'draft') throw runtimeError('开始执行后计划不可原地修改，请新建计划', 'PLAN_IMMUTABLE', 409);
      if (run.maxCalls < steps.length) throw runtimeError('新计划超出调用预算');
      if (run.planVersion >= 20) throw runtimeError('草稿修订已达20版，请新建计划', 'PLAN_REVISION_LIMIT', 409);
      run.steps = steps;
      run.planVersion++;
      run.planHash = planDigest(steps);
      event(run, 'plan.updated', steps, {}, this.clock());
    });
    return publicRun(result.run);
  }

  async start(userId, id, input) {
    const result = await this.ownedChange(userId, id, input.version, run => {
      if (run.status !== 'draft' || run.expiresAt <= this.clock()) throw runtimeError('仅未过期草稿可以开始', 'INVALID_STATE', 409);
      run.status = 'queued';
      run.availableAt = this.clock();
      event(run, 'run.queued', [], {}, this.clock());
    });
    return publicRun(result.run);
  }

  async stop(userId, id, input, pause = false) {
    const result = await this.ownedChange(userId, id, input.version, run => {
      if (TERMINAL.has(run.status) || run.status === 'cancel_requested') throw runtimeError('运行已结束或正在取消', 'INVALID_STATE', 409);
      if (pause && !['queued', 'running', 'waiting', 'awaiting_approval'].includes(run.status)) throw runtimeError('当前状态不可暂停', 'INVALID_STATE', 409);
      const leased = run.lease?.until > this.clock();
      run.status = leased ? (pause ? 'pause_requested' : 'cancel_requested') : (pause ? 'paused' : 'cancelled');
      run.availableAt = leased ? this.clock() : run.expiresAt;
      if (!leased && !pause) {
        for (const step of run.steps) if (step.status !== 'succeeded') { step.status = 'cancelled'; step.approval = null; }
      }
      event(run, pause ? 'run.pause_requested' : 'run.cancel_requested', run.steps.filter(step => step.status === 'cancelled'), { completedEffectsAreNotRolledBack: true }, this.clock());
    });
    return publicRun(result.run);
  }

  async resume(userId, id, input) {
    const result = await this.ownedChange(userId, id, input.version, run => {
      if (!['failed', 'paused', 'blocked', 'awaiting_approval', 'attention'].includes(run.status)) throw runtimeError('当前状态不可恢复', 'INVALID_STATE', 409);
      if (run.lease?.until > this.clock()) throw runtimeError('执行器仍在停止，请稍后重试', 'LEASE_ACTIVE', 409);
      if (run.expiresAt <= this.clock() || run.calls >= run.maxCalls || run.resumes >= LIMITS.resumes) throw runtimeError('运行期限或累计预算已耗尽，请新建计划', 'RUN_BUDGET_EXHAUSTED', 409);
      const changed = [];
      for (const step of run.steps) {
        if (step.status === 'succeeded') continue;
        const tool = this.getDefinition(step.tool);
        if (!tool || tool.version !== step.toolVersion) throw runtimeError('工具版本已变化，请新建计划', 'TOOL_VERSION_CHANGED', 409);
        if (step.status === 'uncertain' && !tool.replaySafe) throw runtimeError('存在结果未知的副作用，必须先人工核对外部系统；不可盲目恢复', 'RECONCILIATION_REQUIRED', 409);
        if (step.attempts >= LIMITS.attempts) throw runtimeError('步骤尝试次数已耗尽', 'STEP_ATTEMPTS_EXHAUSTED', 409);
        step.status = 'pending'; step.error = null; step.approval = null; step.retryAt = 0;
        changed.push(step);
      }
      run.lease = null; run.status = 'queued'; run.availableAt = this.clock(); run.error = null; run.resumes++;
      event(run, 'run.resumed', changed, { completedStepsSkipped: run.steps.filter(step => step.status === 'succeeded').map(step => step.id) }, this.clock());
    });
    return publicRun(result.run);
  }

  async approval(userId, id, stepId, input) {
    const actor = await this.actor(userId);
    const record = await this.owned(userId, id);
    const target = record.value.steps.find(step => step.id === stepId);
    if (!target) throw runtimeError('步骤不存在', 'NOT_FOUND', 404);
    const policy = await this.policy.decide(target.tool, actor, this.getDefinition(target.tool));
    if (policy.effect === 'deny') throw runtimeError(policy.reason, 'POLICY_DENIED', 403);
    if (!['approve', 'deny'].includes(input.decision)) throw runtimeError('审批决定无效');
    const result = await this.mutate(id, run => {
      if (run.ownerId !== actor.id || !['awaiting_approval', 'running', 'waiting', 'queued'].includes(run.status) || run.expiresAt <= this.clock()) throw runtimeError('当前运行不可审批', 'INVALID_STATE', 409);
      const step = run.steps.find(item => item.id === stepId);
      const approval = step?.approval;
      if (step?.status !== 'awaiting_approval' || !approval || approval.id !== input.requestId || approval.digest !== input.digest || approval.decision !== 'pending' || approval.expiresAt <= this.clock()) throw runtimeError('审批已失效或已消费，请刷新或重新请求审批', 'APPROVAL_STALE', 409);
      const current = approvalDigest(run, step, resolveInput(step.input, run.steps), policy.version);
      if (current !== approval.digest) throw runtimeError('参数、依赖或策略已变化，请重新请求审批', 'APPROVAL_STALE', 409);
      approval.decision = input.decision;
      approval.decidedAt = this.clock();
      if (input.decision === 'deny') {
        step.status = 'denied'; run.status = 'cancelled'; run.availableAt = run.expiresAt;
      } else {
        step.status = 'pending'; run.status = run.lease?.until > this.clock() ? 'running' : 'queued'; run.availableAt = this.clock();
      }
      event(run, input.decision === 'deny' ? 'step.denied' : 'step.approved', [step], { policyVersion: policy.version }, this.clock());
    });
    return publicRun(result.run);
  }

  async events(userId, id, { after = 0, limit = 100 } = {}) {
    await this.actor(userId);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw runtimeError('回放游标无效');
    const run = (await this.owned(userId, id)).value;
    const items = run.events.filter(item => item.seq > after).slice(0, limit);
    return { events: items, nextSeq: items.at(-1)?.seq || after, lastSeq: run.events.at(-1)?.seq || 0, readOnly: true };
  }

  async replay(userId, id, through) {
    await this.actor(userId);
    if (!Number.isInteger(through) || through < 1) throw runtimeError('回放序号无效');
    const run = (await this.owned(userId, id)).value;
    return { state: replay(run.events, through), readOnly: true, through: Math.min(through, run.events.at(-1).seq) };
  }

  async remove(userId, id, version) {
    await this.actor(userId);
    const record = await this.owned(userId, id);
    if (!TERMINAL.has(record.value.status) || record.value.lease?.until > this.clock()) throw runtimeError('请先取消运行并等待执行器停止', 'INVALID_STATE', 409);
    if (version !== record.value.version || !await this.store.removeRun(record)) throw runtimeError('运行已变化', 'VERSION_CONFLICT', 409);
    return { removed: true };
  }
}

let coordinator;
const getRunCoordinator = () => (coordinator ||= new RunCoordinator());
module.exports = { RunCoordinator, getRunCoordinator, approvalDigest };
