"use strict";

const { redis: store } = require("./memory-store.service");
const { parseRedisList } = require("./helpers");
const { logEvent } = require('../observability/observability.service');

const MAX_SHORT_TERM = 8;
const COMPRESS_THRESHOLD = 6;
const COMPRESS_COUNT = 3;

class ShortTermMemory {
  constructor(aiService = null) {
    this.aiService = aiService;
  }

  async save(userId, summary) {
    const key = `memory:${userId}:short_term`;
    const raw = await store.lrange(key, 0, -1);
    const list = parseRedisList(raw);

    list.push({
      content: summary,
      timestamp: new Date().toISOString(),
    });

    if (list.length > COMPRESS_THRESHOLD && this.aiService && !process.env.VITEST) {
      await this._compressAndReplace(list);
    } else {
      while (list.length > MAX_SHORT_TERM) {
        list.shift();
      }
    }

    await store.del(key);
    await store.rpush(key, JSON.stringify(list));
  }

  async _compressAndReplace(list) {
    const toCompress = list.splice(0, COMPRESS_COUNT);
    while (list.length > MAX_SHORT_TERM) {
      list.shift();
    }
    const compressed = await this._compress(toCompress);
    list.unshift({
      content: compressed,
      timestamp: new Date().toISOString(),
      compressed: true,
    });
    while (list.length > MAX_SHORT_TERM) {
      list.shift();
    }
  }

  async _compress(items) {
    const texts = items.map((i, idx) => `[${idx + 1}] ${i.content}`).join("\n");
    const prompt = `将以下 ${items.length} 条对话记忆压缩为一句连贯的话，保留关键信息（人物、事件、时间、地点、结论、偏好）。不要添加原文没有的信息。\n\n${texts}\n\n压缩摘要：`;
    try {
      const result = await this.aiService.getCompletion(prompt, [], { timeout: 5000, retries: 1 });
      const compressed = (result.content || "").trim().replace(/^["「『]|["」』]$/g, "");
      if (compressed && compressed.length > 5) return compressed;
    } catch (err) {
      logEvent('warn', 'memory_compaction_failed', { error: err.message });
    }
    return items.map((i) => i.content).join("；");
  }

  async get(userId) {
    const key = `memory:${userId}:short_term`;
    const raw = await store.lrange(key, 0, -1);
    const list = parseRedisList(raw);

    if (list.length === 0) return "";
    return list
      .map((m, i) => (m.compressed ? `[摘要 ${i + 1}] ${m.content}` : `[${i + 1}] ${m.content}`))
      .join("\n");
  }

  async clear(userId) {
    await store.del(`memory:${userId}:short_term`);
  }
}

module.exports = { ShortTermMemory };



