'use strict';

const crypto = require('crypto');
const { isDedicatedWorker } = require('./execution-boundary');
const { RunCoordinator, approvalDigest } = require('./run-coordinator.service');
const { WorkerTools } = require('./worker-tools.service');
const { validateInput } = require('./tool-catalog');
const { LIMITS, copy, digest, event, resolveInput, safeJson, runtimeError } = require('./runtime-values');
const { logEvent } = require('../observability/observability.service');

const stoppedError = () => Object.assign(new Error('运行已暂停或取消'), { code: 'ABORTED', name: 'AbortError' });

class AgentRunWorker {
  constructor({ coordinator = new RunCoordinator(), tools, isWorker = isDedicatedWorker, clock = () => Date.now(), leaseMs = 30000, heartbeatMs = 5000, parallelism = 2 } = {}) {
    this.coordinator = coordinator;
    this.store = coordinator.store;
    this.tools = tools || new WorkerTools({ store: this.store });
    this.isWorker = isWorker;
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs;
    this.parallelism = Math.max(1, Math.min(parallelism, 3));
    this.timer = null;
    this.active = null;
    this.stopping = false;
    this.controller = null;
  }

  assertWorker() {
    if (!this.isWorker()) throw runtimeError('持久任务只能由独立 worker 入口执行，API 进程禁止执行', 'WORKER_REQUIRED', 403);
  }
  checkLease(run, token) {
    if (run.lease?.token !== token || run.lease.until <= this.clock()) throw runtimeError('运行租约已失效，旧执行器不得提交', 'LEASE_LOST', 409);
  }
  async pulse() {
    const previous = await this.store.getValue('worker', 'agent-runtime');
    await this.store.setValue('worker', 'agent-runtime', previous, { at: this.clock(), protocol: 1 });
  }

  async claim(id) {
    const token = crypto.randomUUID();
    const result = await this.coordinator.mutate(id, run => {
      if (run.lease?.until > this.clock() || run.availableAt > this.clock()) return false;
      if (['completed', 'cancelled', 'expired'].includes(run.status)) return false;
      if (run.expiresAt <= this.clock()) {
        run.status = 'expired'; run.lease = null;
        event(run, 'run.expired', [], {}, this.clock());
        return { expired: true };
      }
      if (!['queued', 'waiting', 'running', 'pause_requested', 'cancel_requested'].includes(run.status)) return false;
      const recovered = [];
      for (const step of run.steps.filter(item => item.status === 'running')) {
        const definition = this.tools.definition(step.tool);
        step.status = definition?.replaySafe && step.attempts < LIMITS.attempts ? 'pending' : 'uncertain';
        step.approval = null;
        step.error = { code: 'WORKER_INTERRUPTED', message: '上次执行器在记录结果前中断' };
        recovered.push(step);
      }
      if (recovered.length) event(run, 'steps.recovered', recovered, { retryRequiresNewApproval: true }, this.clock());
      if (run.steps.some(step => step.status === 'uncertain')) {
        run.status = 'attention'; run.lease = null; run.availableAt = run.expiresAt;
        run.error = { code: 'RECONCILIATION_REQUIRED', message: '存在结果未知或尝试耗尽的步骤，请人工核对，不会自动重复副作用' };
        event(run, 'run.attention', [], {}, this.clock());
        return { expired: true };
      }
      run.lease = { token, until: this.clock() + this.leaseMs };
      if (!['cancel_requested', 'pause_requested'].includes(run.status)) run.status = 'running';
      event(run, 'run.leased', [], {}, this.clock());
      return { token };
    });
    return result?.value?.token || null;
  }

  async heartbeat(id, token, controller) {
    try {
      const result = await this.coordinator.mutate(id, run => {
        this.checkLease(run, token);
        if (['cancel_requested', 'pause_requested', 'cancelled'].includes(run.status) || run.expiresAt <= this.clock()) controller.abort(stoppedError());
        run.lease.until = this.clock() + this.leaseMs;
      });
      if (!result) controller.abort(stoppedError());
      await this.pulse();
    } catch { controller.abort(stoppedError()); }
  }

  ready(run) {
    return run.steps.filter(step => ['pending', 'retrying'].includes(step.status)
      && Math.max(step.notBefore, step.retryAt) <= this.clock()
      && step.dependsOn.every(id => run.steps.find(other => other.id === id)?.status === 'succeeded'));
  }

  async prepare(id, token, stepId) {
    const initial = (await this.store.getRun(id))?.value;
    if (!initial) return null;
    const node = initial.steps.find(step => step.id === stepId);
    const tool = this.tools.definition(node.tool);
    const actor = await this.coordinator.actor(initial.ownerId);
    const policy = await this.coordinator.policy.decide(node.tool, actor, tool);
    const result = await this.coordinator.mutate(id, run => {
      this.checkLease(run, token);
      if (run.status !== 'running') return false;
      const step = run.steps.find(item => item.id === stepId);
      if (!this.ready(run).some(item => item.id === stepId)) return false;
      if (!tool || tool.execution !== 'worker' || tool.version !== step.toolVersion || policy.effect === 'deny') {
        step.status = 'blocked'; step.approval = null;
        step.error = { code: 'POLICY_DENIED', message: policy.reason || '工具不可用或实现版本已变化' };
        event(run, 'step.blocked', [step], {}, this.clock());
        return null;
      }
      if (run.calls >= run.maxCalls || step.attempts >= LIMITS.attempts) {
        step.status = 'failed'; step.error = { code: 'CALL_BUDGET_EXHAUSTED', message: '累计调用预算或尝试次数已耗尽' };
        event(run, 'step.failed', [step], {}, this.clock());
        return null;
      }
      let input;
      try {
        input = resolveInput(step.input, run.steps);
        validateInput(step.tool, input);
      } catch (error) {
        step.status = 'failed'; step.error = { code: error.code || 'INVALID_TOOL_INPUT', message: error.message.slice(0, 300) };
        event(run, 'step.failed', [step], {}, this.clock());
        return null;
      }
      const binding = approvalDigest(run, step, input, policy.version);
      if (policy.effect === 'approval') {
        const approved = step.approval?.decision === 'approve' && step.approval.digest === binding
          && !step.approval.usedAt && step.approval.expiresAt > this.clock();
        if (!approved) {
          step.status = 'awaiting_approval';
          step.approval = { id: crypto.randomUUID(), digest: binding, policyVersion: policy.version,
            expiresAt: Math.min(this.clock() + 15 * 60000, run.expiresAt), decision: 'pending', inputPreview: input };
          event(run, 'step.approval_requested', [step], {}, this.clock());
          return null;
        }
        step.approval.usedAt = this.clock();
      } else step.approval = null;
      step.status = 'running'; step.error = null; step.attempts++; run.calls++;
      step.execution = { binding, policyVersion: policy.version, attempt: step.attempts };
      event(run, 'step.started', [step], { policyVersion: policy.version, inputHash: digest(input) }, this.clock());
      return { input, actor, attempt: step.attempts, policyVersion: policy.version, tool, runId: run.id, ownerId: run.ownerId };
    });
    return result?.value || null;
  }

  async execute(id, token, stepId, prepared, parentSignal) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(stoppedError());
    parentSignal.addEventListener('abort', forwardAbort, { once: true });
    if (parentSignal.aborted) forwardAbort();
    const startedAt = this.clock();
    let timer;
    let abortListener;
    const verifyActive = async () => {
      this.assertWorker();
      if (controller.signal.aborted) throw stoppedError();
      const record = await this.store.getRun(id);
      const run = record?.value;
      if (!run) throw stoppedError();
      this.checkLease(run, token);
      if (run.status !== 'running' || run.expiresAt <= this.clock()) throw stoppedError();
      const actor = await this.coordinator.actor(run.ownerId);
      const definition = this.tools.definition(prepared.tool.name);
      if (!definition || definition.execution !== 'worker' || definition.version !== prepared.tool.version) throw runtimeError('工具版本已变化', 'TOOL_VERSION_CHANGED', 409);
      const decision = await this.coordinator.policy.decide(prepared.tool.name, actor, definition);
      if (decision.effect === 'deny' || decision.version !== prepared.policyVersion) throw runtimeError('权限策略已变化，执行已停止', 'POLICY_CHANGED', 403);
      const step = run.steps.find(item => item.id === stepId);
      if (step.status !== 'running' || step.attempts !== prepared.attempt) throw stoppedError();
      return { runId: id, generation: run.generation, leaseToken: token, ownerId: run.ownerId, revision: record.revision, policyVersion: decision.version };
    };
    let result;
    let failure;
    try {
      await verifyActive();
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(controller.signal.reason || stoppedError());
        controller.signal.addEventListener('abort', abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      timer = setTimeout(() => controller.abort(runtimeError('步骤执行超时', 'TOOL_TIMEOUT', 504)), prepared.tool.timeoutMs);
      result = await Promise.race([
        Promise.resolve().then(() => this.tools.execute(prepared.tool.name, prepared.input, {
          runId: id, stepId, userId: prepared.ownerId, signal: controller.signal, verifyActive,
          idempotencyKey: `${id}:${stepId}`,
        })),
        aborted,
      ]);
      safeJson(result);
      if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.resultBytes) throw runtimeError('工具输出超出有界结果限制', 'RESULT_TOO_LARGE', 413);
    } catch (error) { failure = error; }
    finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      parentSignal.removeEventListener('abort', forwardAbort);
    }
    await this.coordinator.mutate(id, run => {
      this.checkLease(run, token);
      const step = run.steps.find(item => item.id === stepId);
      if (step.status !== 'running' || step.attempts !== prepared.attempt) return false;
      step.durationMs = Math.max(0, this.clock() - startedAt);
      if (!failure) {
        step.status = 'succeeded'; step.result = copy(result); step.resultHash = digest(result); step.error = null;
        event(run, 'step.succeeded', [step], { idempotencyKey: `${id}:${stepId}` }, this.clock());
        return;
      }
      const interrupted = failure.name === 'AbortError' || failure.code === 'ABORTED' || failure.code === 'TOOL_TIMEOUT';
      const uncertain = prepared.tool.sideEffect && !prepared.tool.replaySafe;
      const retryable = !uncertain && (failure.retryable === true || failure.code === 'TOOL_TIMEOUT');
      step.error = { code: failure.code || 'TOOL_FAILED', message: String(failure.message || '执行失败').slice(0, 300) };
      step.approval = null;
      if (uncertain) step.status = 'uncertain';
      else if (interrupted && (this.stopping || parentSignal.aborted) && failure.code !== 'TOOL_TIMEOUT') step.status = 'pending';
      else if (['POLICY_CHANGED', 'FORBIDDEN'].includes(failure.code)) step.status = 'blocked';
      else if (retryable && step.attempts < LIMITS.attempts && run.calls < run.maxCalls) {
        step.status = 'retrying'; step.retryAt = this.clock() + Math.min(30000, 1000 * 2 ** step.attempts);
      } else step.status = 'failed';
      event(run, 'step.failed', [step], { retryable, interrupted }, this.clock());
    });
  }

  async release(id, token) {
    await this.coordinator.mutate(id, run => {
      this.checkLease(run, token);
      run.lease = null;
      const interrupted = run.steps.filter(step => step.status === 'running');
      for (const step of interrupted) {
        step.status = this.tools.definition(step.tool)?.replaySafe ? 'pending' : 'uncertain';
        step.approval = null;
        step.error = { code: 'WORKER_INTERRUPTED', message: '执行状态未收敛，需要恢复或核对' };
      }
      if (interrupted.length) event(run, 'steps.interrupted', interrupted, {}, this.clock());
      const unfinished = run.steps.filter(step => step.status !== 'succeeded');
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        run.status = 'cancelled';
        for (const step of unfinished) { step.status = step.status === 'uncertain' ? 'uncertain' : 'cancelled'; step.approval = null; }
      } else if (this.stopping || run.status === 'pause_requested') run.status = 'paused';
      else if (run.expiresAt <= this.clock()) run.status = 'expired';
      else if (run.steps.some(step => step.status === 'uncertain')) run.status = 'attention';
      else if (run.steps.some(step => step.status === 'failed')) run.status = 'failed';
      else if (run.steps.some(step => step.status === 'blocked')) run.status = 'blocked';
      else if (!unfinished.length) run.status = 'completed';
      else {
        const schedulable = run.steps.filter(step => ['pending', 'retrying'].includes(step.status)
          && step.dependsOn.every(dep => run.steps.find(item => item.id === dep)?.status === 'succeeded'));
        run.status = schedulable.length ? 'waiting' : 'awaiting_approval';
        run.availableAt = schedulable.length ? Math.min(...schedulable.map(step => Math.max(step.notBefore, step.retryAt, this.clock()))) : run.expiresAt;
      }
      if (!['waiting', 'queued'].includes(run.status)) run.availableAt = run.expiresAt;
      const problematic = run.steps.find(step => ['failed', 'blocked', 'uncertain'].includes(step.status));
      run.error = problematic?.error || null;
      event(run, `run.${run.status}`, run.status === 'cancelled' ? unfinished : [], {}, this.clock());
    });
  }

  async processRun(id) {
    this.assertWorker();
    const token = await this.claim(id);
    if (!token) return;
    const controller = new AbortController();
    this.controller = controller;
    let beating = false;
    const timer = setInterval(async () => {
      if (beating) return;
      beating = true;
      try { await this.heartbeat(id, token, controller); } finally { beating = false; }
    }, this.heartbeatMs);
    try {
      const run = (await this.store.getRun(id)).value;
      const ready = run.status === 'running' ? this.ready(run) : [];
      const first = this.tools.definition(ready[0]?.tool);
      const batch = first?.parallelSafe && !first.sideEffect
        ? ready.filter(step => { const tool = this.tools.definition(step.tool); return tool?.parallelSafe && !tool.sideEffect; }).slice(0, this.parallelism)
        : ready.slice(0, 1);
      const prepared = [];
      for (const step of batch) {
        const item = await this.prepare(id, token, step.id);
        if (item) prepared.push([step.id, item]);
      }
      await Promise.allSettled(prepared.map(([stepId, item]) => this.execute(id, token, stepId, item, controller.signal))).then(results => {
        const error = results.find(result => result.status === 'rejected');
        if (error) throw error.reason;
      });
      await this.release(id, token);
    } catch (error) {
      controller.abort(stoppedError());
      if (error.code !== 'LEASE_LOST') {
        try {
          await this.coordinator.mutate(id, run => {
            this.checkLease(run, token);
            run.status = 'pause_requested';
            run.error = { code: error.code || 'WORKER_ERROR', message: '执行器暂停；恢复时将重新检查身份、权限与检查点' };
            event(run, 'run.worker_error', [], { code: run.error.code }, this.clock());
          });
          await this.release(id, token);
        } catch { /* 租约交给下一个执行器恢复 */ }
      }
    } finally {
      clearInterval(timer);
      controller.abort(stoppedError());
      this.controller = null;
    }
  }

  async tick() {
    this.assertWorker();
    if (this.active || this.stopping) return this.active;
    this.active = (async () => {
      await this.pulse();
      const due = await this.store.dueRuns(this.clock(), 4);
      for (const record of due) {
        if (this.stopping) break;
        await this.processRun(record.value.id);
      }
    })();
    try { await this.active; }
    finally { this.active = null; }
  }
  start() {
    this.assertWorker();
    if (this.timer) return;
    this.stopping = false;
    const tick = () => this.tick().catch(error => logEvent('error', 'agent_worker_tick_failed', { code: error.code || 'RUNTIME_ERROR' }));
    this.timer = setInterval(tick, 1000);
    void tick();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer); this.timer = null;
    this.controller?.abort(stoppedError());
    await this.active;
  }
}

let worker;
function startAgentRunWorker() { worker ||= new AgentRunWorker(); worker.start(); return worker; }
async function stopAgentRunWorker() { await worker?.stop(); }
module.exports = { AgentRunWorker, isDedicatedWorker, startAgentRunWorker, stopAgentRunWorker };
