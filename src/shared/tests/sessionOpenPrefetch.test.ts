import assert from 'node:assert/strict';

import { afterEach, beforeEach, describe, it, vi } from 'vitest';

/**
 * The sidebar asks for a session's history, model and token usage when the
 * pointer reaches its row, so the click finds the answers already here. Each
 * answer is used once and only while it is fresh.
 */

const sessionMessages = vi.fn();
const sessionActiveModel = vi.fn();
const sessionTokenUsage = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
      sessionActiveModel: (...args: unknown[]) => sessionActiveModel(...args),
      sessionTokenUsage: (...args: unknown[]) => sessionTokenUsage(...args),
    },
  },
}));

const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body } as Response);

beforeEach(() => {
  sessionMessages.mockReset().mockImplementation(() => ok({ data: { messages: [], total: 0, hasMore: false } }));
  sessionActiveModel.mockReset().mockImplementation(() => ok({ success: true, data: { model: 'opus', source: 'session' } }));
  sessionTokenUsage.mockReset().mockImplementation(() => ok({ used: 10 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

const load = () => import('@/shared/sessionOpenPrefetch');

describe('session open prefetch', () => {
  it('asks once per session while the first answer is fresh', async () => {
    const { prefetchSessionOpen } = await load();
    prefetchSessionOpen('s1', 'claude');
    prefetchSessionOpen('s1', 'claude');

    assert.equal(sessionMessages.mock.calls.length, 1);
    assert.equal(sessionActiveModel.mock.calls.length, 1);
    assert.equal(sessionTokenUsage.mock.calls.length, 1);
  });

  it('hands each answer over once', async () => {
    const { prefetchSessionOpen, takePrefetchedSessionResponse } = await load();
    prefetchSessionOpen('s1', 'claude');

    const history = takePrefetchedSessionResponse('s1', 'history');
    assert.ok(history);
    assert.deepEqual(await history.promise, { data: { messages: [], total: 0, hasMore: false } });
    assert.equal(takePrefetchedSessionResponse('s1', 'history'), null);
  });

  it('leaves an answer still in flight to a caller that can wait for it', async () => {
    const { prefetchSessionOpen, takePrefetchedSessionResponse } = await load();
    prefetchSessionOpen('s1', 'claude');

    assert.equal(takePrefetchedSessionResponse('s1', 'tokenUsage', { settledOnly: true }), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settled = takePrefetchedSessionResponse('s1', 'tokenUsage', { settledOnly: true });
    assert.ok(settled?.settled);
    assert.deepEqual(settled.body, { used: 10 });
  });

  it('gives a model only to a caller asking for the provider it was fetched for', async () => {
    const { prefetchSessionOpen, takePrefetchedSessionResponse } = await load();
    prefetchSessionOpen('s1', 'claude');

    assert.equal(takePrefetchedSessionResponse('s1', 'selection', { provider: 'codex' }), null);
    assert.ok(takePrefetchedSessionResponse('s1', 'selection', { provider: 'claude' }));
  });

  it('turns a failed response into no answer', async () => {
    sessionTokenUsage.mockImplementation(() => Promise.resolve({ ok: false, json: async () => ({}) } as Response));
    const { prefetchSessionOpen, takePrefetchedSessionResponse } = await load();
    prefetchSessionOpen('s1', 'claude');

    assert.equal(await takePrefetchedSessionResponse('s1', 'tokenUsage')?.promise, null);
  });

  it('does not download the history of a session already in memory', async () => {
    const { prefetchSessionOpen, registerHeldHistoryCheck, takePrefetchedSessionResponse } = await load();
    const unregister = registerHeldHistoryCheck((sessionId) => sessionId === 's1');
    prefetchSessionOpen('s1', 'claude');

    assert.equal(sessionMessages.mock.calls.length, 0);
    assert.equal(takePrefetchedSessionResponse('s1', 'history'), null);
    assert.ok(takePrefetchedSessionResponse('s1', 'tokenUsage'), 'the model and usage are still asked for');

    unregister();
    prefetchSessionOpen('s2', 'claude');
    assert.equal(sessionMessages.mock.calls.length, 1);
  });

  it('drops answers older than ten seconds', async () => {
    vi.useFakeTimers();
    const { prefetchSessionOpen, takePrefetchedSessionResponse } = await load();
    prefetchSessionOpen('s1', 'claude');

    vi.advanceTimersByTime(10_001);
    assert.equal(takePrefetchedSessionResponse('s1', 'history'), null);
    prefetchSessionOpen('s1', 'claude');
    assert.equal(sessionMessages.mock.calls.length, 2);
  });
});
