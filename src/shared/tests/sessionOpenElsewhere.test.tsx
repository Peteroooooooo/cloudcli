import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * A session sent to from CloudCLI resumes in a Claude process of its own, so a
 * VS Code panel or terminal that also has it open never sees that turn and its
 * next message branches the transcript. The running-sessions poll lists those
 * sessions as `openElsewhere`; the sidebar marker and the composer warning
 * read them through useSessionOpenElsewhere.
 */

const runningSessions = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { runningSessions: () => runningSessions() },
}));

const pollResponse = (openElsewhere: unknown) => ({
  ok: true,
  json: async () => ({ data: { sessions: [], openElsewhere } }),
});

beforeEach(() => {
  vi.resetModules();
  runningSessions.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('the poll reports where a session is open, and nothing for the rest', async () => {
  runningSessions.mockResolvedValue(pollResponse([
    { sessionId: 'vscode-session', openIn: 'vscode', busy: false },
    { sessionId: 'cli-session', openIn: 'cli', busy: true },
    // A host this client does not know is dropped rather than mislabelled.
    { sessionId: 'future-session', openIn: 'jetbrains', busy: false },
  ]));

  const { SessionProtectionProvider, useSessionOpenElsewhere } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => ({
    vscode: useSessionOpenElsewhere('vscode-session'),
    cli: useSessionOpenElsewhere('cli-session'),
    future: useSessionOpenElsewhere('future-session'),
    none: useSessionOpenElsewhere('closed-session'),
  }), { wrapper });

  await waitFor(() => assert.ok(result.current.vscode));
  assert.deepEqual(result.current.vscode, { openIn: 'vscode', busy: false });
  assert.deepEqual(result.current.cli, { openIn: 'cli', busy: true });
  assert.equal(result.current.future, null);
  assert.equal(result.current.none, null);
});

test('a poll that changes nothing keeps the same value, and a closed panel clears it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runningSessions.mockResolvedValue(pollResponse([{ sessionId: 'vscode-session', openIn: 'vscode', busy: false }]));

  const { SessionProtectionProvider, useSessionOpenElsewhere } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useSessionOpenElsewhere('vscode-session'), { wrapper });

  await waitFor(() => assert.ok(result.current));
  const first = result.current;

  const pollsBefore = runningSessions.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  assert.ok(runningSessions.mock.calls.length > pollsBefore, 'the interval polled again');
  assert.equal(result.current, first, 'an unchanged poll does not hand the rows a new value');

  runningSessions.mockResolvedValue(pollResponse([]));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  await waitFor(() => assert.equal(result.current, null));
});

test('outside the provider the hook reports nothing instead of throwing', async () => {
  const { useSessionOpenElsewhere } = await import('@/shared/context/SessionProtectionContext');
  const { result } = renderHook(() => useSessionOpenElsewhere('vscode-session'));
  assert.equal(result.current, null);
});
