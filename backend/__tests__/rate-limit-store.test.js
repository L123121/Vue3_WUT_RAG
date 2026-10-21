import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { RedisRateLimitStore } = require('../src/middleware/rate-limit-store');

function fakeRedis() {
  const counters = new Map();
  return {
    enabled: true,
    counters,
    command: vi.fn(async (cmd, ...args) => {
      if (cmd === 'EVAL') {
        const key = args[2];
        const hits = (counters.get(key) || 0) + 1;
        counters.set(key, hits);
        return [hits, Number(args[3])];
      }
      if (cmd === 'DECR') counters.set(args[0], (counters.get(args[0]) || 0) - 1);
      if (cmd === 'DEL') counters.delete(args[0]);
      return 1;
    }),
  };
}

describe('RedisRateLimitStore', () => {
  it('两个实例的 store 共享同一份 Redis 计数', async () => {
    const redis = fakeRedis();
    const a = new RedisRateLimitStore({ prefix: 'chat', redis });
    const b = new RedisRateLimitStore({ prefix: 'chat', redis });
    a.init({ windowMs: 60000 });
    b.init({ windowMs: 60000 });

    expect((await a.increment('1.2.3.4')).totalHits).toBe(1);
    const second = await b.increment('1.2.3.4');
    expect(second.totalHits).toBe(2);
    expect(second.resetTime.getTime()).toBeGreaterThan(Date.now());
    expect(redis.counters.get('wut:rl:chat:1.2.3.4')).toBe(2);

    await a.decrement('1.2.3.4');
    expect(redis.counters.get('wut:rl:chat:1.2.3.4')).toBe(1);
    await b.resetKey('1.2.3.4');
    expect(redis.counters.has('wut:rl:chat:1.2.3.4')).toBe(false);
    a.shutdown();
    b.shutdown();
  });

  it('Redis 故障时退回本实例内存计数，仍然限流', async () => {
    const redis = { enabled: true, command: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const store = new RedisRateLimitStore({ prefix: 'login', redis });
    store.init({ windowMs: 60000 });
    expect((await store.increment('u')).totalHits).toBe(1);
    expect((await store.increment('u')).totalHits).toBe(2);
    store.shutdown();
  });
});
