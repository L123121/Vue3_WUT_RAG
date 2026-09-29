import { describe, expect, it, vi } from 'vitest';

const { RedisRuntime, parseRedisUrl, encodeCommand, parseResp } = require('../src/services/runtime/redis-runtime.service');

describe('redis-runtime.service', () => {
  it('解析 redis/rediss URL，并拒绝其他协议', () => {
    expect(parseRedisUrl('redis://user:pass@127.0.0.1:6380/2')).toMatchObject({
      host: '127.0.0.1', port: 6380, username: 'user', password: 'pass', database: 2, tls: false,
    });
    expect(parseRedisUrl('rediss://cache.example.com')).toMatchObject({ host: 'cache.example.com', port: 6379, tls: true });
    expect(() => parseRedisUrl('http://localhost:6379')).toThrow(/REDIS_URL/);
  });

  it('RESP 编码和基础响应解析可往返', () => {
    expect(encodeCommand(['PING']).toString()).toBe('*1\r\n$4\r\nPING\r\n');
    expect(parseResp(Buffer.from('+PONG\r\n'))).toEqual({ value: 'PONG', next: 7 });
    expect(parseResp(Buffer.from('$3\r\nfoo\r\n'))).toEqual({ value: 'foo', next: 9 });
  });

  it('未配置 Redis 时 lease 仍以单机方式执行任务', async () => {
    const runtime = new RedisRuntime({ url: '' });
    const callback = vi.fn(async () => 42);
    await expect(runtime.withLease('job:lock', callback)).resolves.toEqual({ acquired: true, distributed: false, value: 42 });
    expect(callback).toHaveBeenCalledOnce();
    expect(runtime.getHealth()).toMatchObject({ status: 'disabled', enabled: false });
  });

  it('未配置 Redis 时通知是无副作用的 false', async () => {
    await expect(new RedisRuntime({ url: '' }).notifyJobsAvailable({ jobId: 'job_1' })).resolves.toBe(false);
  });

  it('通过 RESP 命令层完成 probe、通知和 lease', async () => {
    const runtime = new RedisRuntime({ url: 'redis://127.0.0.1:6379/0', timeoutMs: 500 });
    runtime.command = vi.fn(async (...parts) => {
      if (parts[0] === 'PING') return 'PONG';
      if (parts[0] === 'SET') return 'OK';
      return 1;
    });

    await expect(runtime.probe()).resolves.toMatchObject({ status: 'ready', enabled: true });
    await expect(runtime.notifyJobsAvailable({ jobId: 'job_redis' })).resolves.toBe(true);
    await expect(runtime.withLease('jobs:prune', async () => 'done')).resolves.toEqual({
      acquired: true, distributed: true, value: 'done',
    });

    expect(runtime.command).toHaveBeenCalledWith('PING');
    expect(runtime.command).toHaveBeenCalledWith('PUBLISH', 'wut:jobs:available', expect.stringContaining('job_redis'));
    expect(runtime.command).toHaveBeenCalledWith('SET', 'jobs:prune', expect.any(String), 'NX', 'PX', 30000);
    expect(runtime.command).toHaveBeenCalledWith('EVAL', expect.stringContaining('redis.call'), 1, 'jobs:prune', expect.any(String));
  });
});
