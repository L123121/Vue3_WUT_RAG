import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const registry = require('../src/utils/stream-registry');

function makeRes() {
  const res = {
    writableEnded: false,
    chunks: [],
    write: vi.fn((chunk) => res.chunks.push(chunk)),
    end: vi.fn(() => { res.writableEnded = true; }),
  };
  return res;
}

describe('stream-registry', () => {
  afterEach(() => registry.resetStreamRegistry());

  it('排空期间等待自然结束的流，不发送终止事件', async () => {
    const res = makeRes();
    const untrack = registry.trackStream({ res, abortController: new AbortController(), streamContext: null });
    setTimeout(untrack, 30);
    const result = await registry.drainStreams({ timeoutMs: 1000, pollMs: 10 });
    expect(result).toEqual({ completed: 1, terminated: 0 });
    expect(res.write).not.toHaveBeenCalled();
    expect(registry.isDraining()).toBe(true);
  });

  it('超时后中止上游并写出明确的 SERVER_SHUTTING_DOWN 事件', async () => {
    const legacyRes = makeRes();
    const legacyAbort = new AbortController();
    registry.trackStream({ res: legacyRes, abortController: legacyAbort, streamContext: { streamVersion: 0 } });

    const v1Res = makeRes();
    registry.trackStream({
      res: v1Res,
      abortController: new AbortController(),
      streamContext: { streamVersion: 1, runId: 'run_1', attempt: 0, seq: 0, traceId: 't1' },
    });

    const result = await registry.drainStreams({ timeoutMs: 20, pollMs: 5 });
    expect(result).toEqual({ completed: 0, terminated: 2 });
    expect(legacyAbort.signal.aborted).toBe(true);
    expect(JSON.parse(legacyRes.chunks[0].slice(6))).toMatchObject({ code: registry.SHUTDOWN_CODE });
    expect(legacyRes.end).toHaveBeenCalledOnce();
    expect(v1Res.chunks.join('')).toContain('run.failed');
    expect(v1Res.chunks.join('')).toContain(registry.SHUTDOWN_CODE);
    expect(registry.activeStreamCount()).toBe(0);
  });
});
