import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useSessionProtection } from '@/shared/hooks/useSessionProtection';

/**
 * A turn running in a VS Code panel or a terminal is known only from the
 * running-sessions poll. The subscribe acknowledgement sent when a session is
 * opened describes CloudCLI's own run, which such a session never has, so it
 * must not end that turn.
 */

const elsewhereTurn = () => ({
  sessionId: 'session-1',
  startedAt: Date.now() - 60 * 60_000,
  canInterrupt: false,
  statusText: 'Running in VS Code',
  elsewhere: true,
});

test('opening a session that works in VS Code keeps it processing', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([elsewhereTurn()]);
  });
  act(() => {
    result.current.markSessionIdle('session-1', { ifStartedBefore: Date.now() + 1, onlyOwnRuns: true });
  });

  assert.equal(result.current.isSessionProcessing('session-1'), true);
  assert.equal(result.current.getSessionActivity('session-1')?.elsewhere, true);
});

test('the poll still ends a VS Code turn once it stops listing it', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([elsewhereTurn()]);
  });
  act(() => {
    result.current.syncProcessingSessions([]);
  });

  assert.equal(result.current.getSessionActivity('session-1'), undefined);
});

test('the acknowledgement still ends a CloudCLI run it reports idle', () => {
  const { result } = renderHook(() => useSessionProtection());

  act(() => {
    result.current.syncProcessingSessions([{ sessionId: 'session-1', startedAt: Date.now() - 60_000 }]);
  });
  act(() => {
    result.current.markSessionIdle('session-1', { ifStartedBefore: Date.now() + 1, onlyOwnRuns: true });
  });

  assert.equal(result.current.getSessionActivity('session-1'), undefined);
});
