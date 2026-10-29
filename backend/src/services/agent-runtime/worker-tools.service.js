'use strict';

const { runtimeError, digest } = require('./runtime-values');
const { getTool, validateInput } = require('./tool-catalog');
const { getAgentRuntimeStore } = require('./runtime-store.service');
const { isDedicatedWorker } = require('./execution-boundary');

function assertSignal(context) {
  if (context.signal?.aborted) throw Object.assign(new Error('任务已停止'), { name: 'AbortError', code: 'ABORTED' });
}

class WorkerTools {
  constructor({ store = getAgentRuntimeStore(), wiki, isWorker = isDedicatedWorker, clock = () => Date.now() } = {}) {
    this.store = store;
    this._wiki = wiki;
    this.isWorker = isWorker;
    this.clock = clock;
  }
  get wiki() {
    return this._wiki ||= new (require('../wiki/wiki.service').WikiService)();
  }
  definition(name) { return getTool(name); }

  async source(entry, maxChars) {
    return {
      docId: entry.id, title: String(entry.title || '').slice(0, 180), revision: entry.currentRevision || entry.sourceRevision,
      text: String(entry.body || '').slice(0, maxChars), truncated: String(entry.body || '').length > maxChars,
      sourceLabel: String(entry.sourceLabel || '').slice(0, 200), simulated: entry.simulated === true,
    };
  }

  async execute(name, input, context) {
    if (!this.isWorker()) throw runtimeError('工具禁止在API进程执行', 'WORKER_REQUIRED', 403);
    const tool = this.definition(name);
    if (!tool || tool.execution !== 'worker') throw runtimeError('必须通过独立沙箱执行，此能力尚未开放', 'SANDBOX_REQUIRED', 403);
    validateInput(name, input);
    assertSignal(context);
    const initialGuard = await context.verifyActive();
    if (name === 'search_published_sources') {
      const entries = await this.wiki.searchPublished(input.query, { limit: input.limit || 3 });
      assertSignal(context);
      const sources = await Promise.all(entries.map(entry => this.source(entry, 1800)));
      return { query: input.query, sources, empty: !sources.length };
    }
    if (name === 'read_published_source') {
      const entry = await this.wiki.getEntry(input.docId);
      assertSignal(context);
      if (!entry || !entry.visible || entry.stale) throw runtimeError('来源未发布或需要重新审核', 'SOURCE_UNAVAILABLE', 409);
      if (input.revision && input.revision !== (entry.currentRevision || entry.sourceRevision)) throw runtimeError('来源版本已变化', 'SOURCE_VERSION_CHANGED', 409);
      return { sources: [await this.source(entry, 6000)] };
    }
    if (name === 'compile_research_brief') {
      const all = input.results.flatMap(result => result.sources);
      const sources = all.filter((source, index) => all.findIndex(other => other.docId === source.docId && other.revision === source.revision) === index).slice(0, 8);
      const content = [
        `# ${input.goal}`,
        '以下是已发布资料的摘录，不是新的事实判断。请核对来源版本、有效期及适用范围。',
        ...sources.map((source, index) => `## ${index + 1}. ${source.title}\n来源版本：${source.revision || '未知'}${source.simulated ? '（演示资料）' : ''}\n\n${source.text.slice(0, 650)}${source.text.length > 650 || source.truncated ? '\n（节选，请查看完整原文）' : ''}`),
        ...(!sources.length ? ['没有检索到已发布资料，无法形成有依据的摘录。'] : []),
      ].join('\n\n');
      return { title: input.goal, content, sources: sources.map(({ docId, title, revision, simulated }) => ({ docId, title, revision, simulated })), truncated: all.length > 8, empty: !sources.length };
    }
    if (name === 'save_research_brief') {
      if (!input.brief.sources?.length) throw runtimeError('没有来源，不能保存研究摘录', 'NO_SOURCES', 409);
      const key = `${context.runId}:${context.stepId}`;
      const payload = { ownerId: context.userId, runId: context.runId, generation: initialGuard.generation, stepId: context.stepId, content: input.brief.content, title: input.brief.title, sources: input.brief.sources };
      const fingerprint = digest(payload);
      const existing = await this.store.getValue('artifact', key);
      if (existing) {
        if (existing.value.fingerprint !== fingerprint || existing.value.ownerId !== context.userId) throw runtimeError('已有产物与本次输入不一致，需要人工核对', 'IDEMPOTENCY_CONFLICT', 409);
        return { artifactId: key, title: payload.title, saved: true, deduplicated: true, content: payload.content, sources: payload.sources };
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        assertSignal(context);
        const guard = await context.verifyActive();
        const created = await this.store.saveArtifactIfActive(key, { ...payload, fingerprint, savedAt: this.clock() }, guard, this.clock());
        if (created) return { artifactId: key, title: payload.title, saved: true, deduplicated: false, content: payload.content, sources: payload.sources };
        const concurrent = await this.store.getValue('artifact', key);
        if (concurrent) {
          if (concurrent.value.fingerprint !== fingerprint) throw runtimeError('产物并发写入冲突', 'IDEMPOTENCY_CONFLICT', 409);
          return { artifactId: key, title: payload.title, saved: true, deduplicated: true, content: payload.content, sources: payload.sources };
        }
      }
      throw runtimeError('运行或策略正在变化，产物未写入', 'STATE_CHANGED', 409);
    }
    throw runtimeError('未注册工具', 'TOOL_UNAVAILABLE', 403);
  }
}

module.exports = { WorkerTools };
