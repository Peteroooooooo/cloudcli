import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { SESSION_OPEN_PAGE_SIZE } from '@/shared/constants';
import type { NormalizedMessage } from '@/shared/types';

/**
 * A history page the sidebar prefetched is used by the store instead of a
 * second request: taken in during the render that opens the session when it
 * has arrived, or awaited by the opening fetch while it is still in flight.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
      sessionActiveModel: async () => ({ ok: true, json: async () => ({ success: true, data: {} }) }),
      sessionTokenUsage: async () => ({ ok: true, json: async () => ({ used: 1 }) }),
    },
  },
}));

const row = (id: string, second: number): NormalizedMessage => ({
  id,
  kind: 'text',
  role: 'user',
  content: id,
  provider: 'claude',
  sessionId: 's1',
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString(),
} as NormalizedMessage);

const history = [row('m1', 1), row('m2', 2)];

beforeEach(() => {
  sessionMessages.mockReset().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ data: { messages: history, total: history.length, hasMore: false } }),
  }));
});

afterEach(() => {
  vi.resetModules();
});

async function setup() {
  const { prefetchSessionOpen } = await import('@/shared/sessionOpenPrefetch');
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  return { prefetchSessionOpen, store: () => view.result.current };
}

describe('prefetched opening page', () => {
  it('is taken in synchronously once it has arrived', async () => {
    const { prefetchSessionOpen, store } = await setup();
    prefetchSessionOpen('s1', 'claude');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(store().adoptPrefetchedHistory('s1'), true);
    assert.deepEqual(store().getMessages('s1').map((message) => message.id), ['m1', 'm2']);
    assert.equal(store().getSessionSlot('s1')?.total, 2);
    assert.equal(sessionMessages.mock.calls.length, 1);
  });

  it('is awaited by the opening fetch while still in flight', async () => {
    const { prefetchSessionOpen, store } = await setup();
    prefetchSessionOpen('s1', 'claude');

    assert.equal(store().adoptPrefetchedHistory('s1'), false, 'not arrived yet');
    await act(async () => {
      await store().fetchFromServer('s1', { limit: SESSION_OPEN_PAGE_SIZE, offset: 0 });
    });

    assert.deepEqual(store().getMessages('s1').map((message) => message.id), ['m1', 'm2']);
    assert.equal(sessionMessages.mock.calls.length, 1, 'no second request for the same page');
  });

  it('is not used for a page of another size', async () => {
    const { prefetchSessionOpen, store } = await setup();
    prefetchSessionOpen('s1', 'claude');
    await act(async () => {
      await store().fetchFromServer('s1', { limit: null, offset: 0 });
    });

    assert.equal(sessionMessages.mock.calls.length, 2);
  });

  it('does not replace history the store already has', async () => {
    const { prefetchSessionOpen, store } = await setup();
    await act(async () => {
      await store().fetchFromServer('s1', { limit: 20, offset: 0 });
    });
    prefetchSessionOpen('s1', 'claude');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(store().adoptPrefetchedHistory('s1'), false);
  });
});
