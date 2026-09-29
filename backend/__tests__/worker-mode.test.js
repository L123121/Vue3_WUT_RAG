import { afterEach, describe, expect, it, vi } from 'vitest';

const originalRunner = process.env.JOB_RUNNER_ENABLED;
const originalScheduler = process.env.JOB_SCHEDULER_ENABLED;

function loadFreshConfig() {
  delete require.cache[require.resolve('../src/config')];
  return require('../src/config');
}

afterEach(() => {
  if (originalRunner === undefined) delete process.env.JOB_RUNNER_ENABLED;
  else process.env.JOB_RUNNER_ENABLED = originalRunner;
  if (originalScheduler === undefined) delete process.env.JOB_SCHEDULER_ENABLED;
  else process.env.JOB_SCHEDULER_ENABLED = originalScheduler;
  vi.resetModules();
  delete require.cache[require.resolve('../src/config')];
});

describe('API / Worker 配置模式', () => {
  it('API 模式允许关闭本地 runner 和 scheduler', () => {
    process.env.JOB_RUNNER_ENABLED = 'false';
    process.env.JOB_SCHEDULER_ENABLED = 'false';
    const config = loadFreshConfig();
    expect(config.jobs).toMatchObject({ runnerEnabled: false, schedulerEnabled: false });
  });

  it('默认保持第一阶段单机 runner/scheduler 兼容模式', () => {
    delete process.env.JOB_RUNNER_ENABLED;
    delete process.env.JOB_SCHEDULER_ENABLED;
    const config = loadFreshConfig();
    expect(config.jobs).toMatchObject({ runnerEnabled: true, schedulerEnabled: true });
  });
});
