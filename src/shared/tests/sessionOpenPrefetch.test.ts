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

const jwt = (expiresInSeconds: number) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256' })}.${encode({ userId: 1, iat: now - 60, exp: now + expiresInSeconds })}.sig`;
};

describe('prefetch from the page address', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('starts the session history and usage at startup, and leaves the model to chat', async () => {
    localStorage.setItem('auth-token', jwt(3600));
    const { prefetchSessionFromAddress, takePrefetchedSessionResponse } = await load();
    prefetchSessionFromAddress('/session/774302d9-da14-4705-945e-63298eae5cd5');

    assert.deepEqual(sessionMessages.mock.calls.map(([id]) => id), ['774302d9-da14-4705-945e-63298eae5cd5']);
    assert.equal(sessionTokenUsage.mock.calls.length, 1);
    assert.equal(sessionActiveModel.mock.calls.length, 0, 'the provider is not known before the session details load');
    assert.equal(takePrefetchedSessionResponse('774302d9-da14-4705-945e-63298eae5cd5', 'selection', { provider: 'claude' }), null);
    assert.ok(takePrefetchedSessionResponse('774302d9-da14-4705-945e-63298eae5cd5', 'history'));
  });

  it('works under a router basename', async () => {
    localStorage.setItem('auth-token', jwt(3600));
    const { prefetchSessionFromAddress } = await load();
    prefetchSessionFromAddress('/cloudcli/session/abc-123/');
    assert.deepEqual(sessionMessages.mock.calls.map(([id]) => id), ['abc-123']);
  });

  it('asks for nothing without a usable token or off a session page', async () => {
    const { prefetchSessionFromAddress } = await load();
    prefetchSessionFromAddress('/session/abc');
    const expired = jwt(-3600);
    localStorage.setItem('auth-token', expired);
    prefetchSessionFromAddress('/session/abc');
    assert.equal(localStorage.getItem('auth-token'), expired, 'sign-in, not the prefetch, decides what an expired token means');
    localStorage.setItem('auth-token', jwt(3600));
    prefetchSessionFromAddress('/');
    prefetchSessionFromAddress('/session/abc/files');

    assert.equal(sessionMessages.mock.calls.length, 0);
    assert.equal(sessionTokenUsage.mock.calls.length, 0);
  });
});
