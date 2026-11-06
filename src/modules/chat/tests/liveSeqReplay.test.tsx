import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { LiveSeqCursor } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ServerEvent, ProjectSession, NormalizedMessage } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * Replay positions are per run: each run numbers its events from 1. A replay
 * of events already applied is dropped, and a new run starts the count over
 * instead of having its first events dropped as old.
 */

const SESSION = 'viewed-session';

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const appended: NormalizedMessage[] = [];
  const lastSeqRef = { current: new Map<string, LiveSeqCursor>() };

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: SESSION } as ProjectSession,
    currentSessionId: SESSION,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef,
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: (_sessionId: string, message: NormalizedMessage) => { appended.push(message); },
    } as unknown as SessionStore,
  }));

  const dispatch = (event: Record<string, unknown>) => listener?.(event as unknown as ServerEvent);
  return { dispatch, appended, lastSeqRef };
};

const text = (runId: string, seq: number, content: string) => ({
  kind: 'text',
  id: `${runId}_${seq}`,
  sessionId: SESSION,
  provider: 'claude',
  runId,
  seq,
  content,
});

test('events replayed a second time are applied once', () => {
  const { dispatch, appended, lastSeqRef } = renderHandlers();

  dispatch(text('run-a', 1, 'one'));
  dispatch(text('run-a', 2, 'two'));
  // A reconnect replays from the position the client sent.
  dispatch(text('run-a', 2, 'two'));
  dispatch(text('run-a', 3, 'three'));

  assert.deepEqual(appended.map((message) => message.content), ['one', 'two', 'three']);
  assert.deepEqual(lastSeqRef.current.get(SESSION), { runId: 'run-a', seq: 3 });
});

test('a new run is not mistaken for a replay of the last one', () => {
  const { dispatch, appended, lastSeqRef } = renderHandlers();

  dispatch(text('run-a', 1, 'a1'));
  dispatch(text('run-a', 2, 'a2'));
  dispatch(text('run-b', 1, 'b1'));

  assert.deepEqual(appended.map((message) => message.content), ['a1', 'a2', 'b1']);
  assert.deepEqual(lastSeqRef.current.get(SESSION), { runId: 'run-b', seq: 1 });
});

test('a subscribe ack for a run this client has not heard from starts its count over', () => {
  const { dispatch, appended, lastSeqRef } = renderHandlers();

  dispatch(text('run-a', 1, 'a1'));
  dispatch(text('run-a', 2, 'a2'));
  dispatch({ kind: 'chat_subscribed', sessionId: SESSION, isProcessing: true, runId: 'run-b', pendingPermissions: [] });
  assert.deepEqual(lastSeqRef.current.get(SESSION), { runId: 'run-b', seq: 0 });

  // The server replays run B from its start.
  dispatch(text('run-b', 1, 'b1'));
  dispatch(text('run-b', 2, 'b2'));
  assert.deepEqual(appended.map((message) => message.content), ['a1', 'a2', 'b1', 'b2']);
});

test('an ack for the run already being followed keeps the position', () => {
  const { dispatch, lastSeqRef } = renderHandlers();

  dispatch(text('run-a', 1, 'a1'));
  dispatch(text('run-a', 2, 'a2'));
  dispatch({ kind: 'chat_subscribed', sessionId: SESSION, isProcessing: true, runId: 'run-a', pendingPermissions: [] });

  assert.deepEqual(lastSeqRef.current.get(SESSION), { runId: 'run-a', seq: 2 });
});
