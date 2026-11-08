import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

/**
 * A session row starts loading its session after a short hover, or at once
 * when pressed or focused, but not for a pointer passing over on its way
 * elsewhere, nor for rows a click will not open.
 */

const prefetchSessionOpen = vi.fn();

vi.mock('@/shared/sessionOpenPrefetch', () => ({
  prefetchSessionOpen: (...args: unknown[]) => prefetchSessionOpen(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  prefetchSessionOpen.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function rowHandlers(disabled = false) {
  const { useSessionRowPrefetch } = await import('@/modules/sidebar/hooks/useSessionRowPrefetch');
  const { result } = renderHook(() => useSessionRowPrefetch());
  return result.current('s1', 'claude', disabled);
}

describe('session row prefetch', () => {
  it('waits for the pointer to settle on the row', async () => {
    const handlers = await rowHandlers();
    handlers.onPointerEnter();
    vi.advanceTimersByTime(40);
    handlers.onPointerLeave();
    vi.advanceTimersByTime(200);
    assert.equal(prefetchSessionOpen.mock.calls.length, 0);

    handlers.onPointerEnter();
    vi.advanceTimersByTime(80);
    assert.deepEqual(prefetchSessionOpen.mock.calls, [['s1', 'claude']]);
  });

  it('starts at once on press or focus', async () => {
    const handlers = await rowHandlers();
    handlers.onPointerDown();
    handlers.onFocus();
    assert.equal(prefetchSessionOpen.mock.calls.length, 2);
  });

  it('does nothing for a row a click will not open', async () => {
    const handlers = await rowHandlers(true);
    handlers.onPointerEnter();
    vi.advanceTimersByTime(200);
    handlers.onPointerDown();
    handlers.onFocus();
    assert.equal(prefetchSessionOpen.mock.calls.length, 0);
  });
});
