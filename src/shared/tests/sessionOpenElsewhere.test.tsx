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
const closeSessionInCloudCli = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: () => runningSessions(),
    closeSessionInCloudCli: (sessionId: string) => closeSessionInCloudCli(sessionId),
  },
}));

const pollResponse = (openElsewhere: unknown, openInCloudCli: unknown = []) => ({
  ok: true,
  json: async () => ({ data: { sessions: [], openElsewhere, openInCloudCli } }),
});

beforeEach(() => {
  vi.resetModules();
  runningSessions.mockReset();
  closeSessionInCloudCli.mockReset();
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
  const { useSessionOpenElsewhere, useIsSessionOpenInCloudCli } = await import('@/shared/context/SessionProtectionContext');
  const { result } = renderHook(() => ({
    elsewhere: useSessionOpenElsewhere('vscode-session'),
    cloudCli: useIsSessionOpenInCloudCli('cloudcli-session'),
  }));
  assert.equal(result.current.elsewhere, null);
  assert.equal(result.current.cloudCli, false);
});

/**
 * Sessions the user sent to from CloudCLI stay in its open list until closed,
 * idle for a day or deleted. The poll carries them as `openInCloudCli`.
 */

test('the poll lists the sessions open in CloudCLI, keeping one set while nothing changes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runningSessions.mockResolvedValue(pollResponse([], [
    { sessionId: 'cloudcli-session' },
    // Malformed entries are dropped, not shown as a blank row.
    { sessionId: '' },
    null,
  ]));

  const { SessionProtectionProvider, useIsSessionOpenInCloudCli, useOpenInCloudCliSessionIds } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => ({
    open: useIsSessionOpenInCloudCli('cloudcli-session'),
    other: useIsSessionOpenInCloudCli('other-session'),
    ids: useOpenInCloudCliSessionIds(),
  }), { wrapper });

  await waitFor(() => assert.equal(result.current.open, true));
  assert.equal(result.current.other, false);
  assert.deepEqual([...result.current.ids], ['cloudcli-session']);
  const first = result.current.ids;

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  assert.equal(result.current.ids, first, 'an unchanged poll keeps the same set');
});

test('a frame saying the open list changed refreshes it without waiting for the poll', async () => {
  runningSessions.mockResolvedValue(pollResponse([], []));
  let listener: ((event: { kind?: unknown }) => void) | null = null;
  const subscribe = vi.fn((next: (event: { kind?: unknown }) => void) => {
    listener = next;
    return () => { listener = null; };
  });

  const { SessionProtectionProvider, useIsSessionOpenInCloudCli } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, { subscribe } as never, children);
  const { result } = renderHook(() => useIsSessionOpenInCloudCli('cloudcli-session'), { wrapper });

  await waitFor(() => assert.equal(runningSessions.mock.calls.length, 1));
  assert.equal(result.current, false);

  // An unrelated frame does not poll.
  act(() => listener?.({ kind: 'session_upserted' }));
  assert.equal(runningSessions.mock.calls.length, 1);

  runningSessions.mockResolvedValue(pollResponse([], [{ sessionId: 'cloudcli-session' }]));
  act(() => listener?.({ kind: 'open_sessions_changed' }));
  await waitFor(() => assert.equal(result.current, true));
  assert.equal(runningSessions.mock.calls.length, 2);
});

test('closing asks the server and re-reads the list, so the row goes at once', async () => {
  runningSessions.mockResolvedValue(pollResponse([], [{ sessionId: 'cloudcli-session' }]));
  closeSessionInCloudCli.mockResolvedValue({ ok: true });

  const { SessionProtectionProvider, useIsSessionOpenInCloudCli, useSessionProtectionActions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => ({
    open: useIsSessionOpenInCloudCli('cloudcli-session'),
    actions: useSessionProtectionActions(),
  }), { wrapper });

  await waitFor(() => assert.equal(result.current.open, true));

  runningSessions.mockResolvedValue(pollResponse([], []));
  await act(async () => {
    await result.current.actions.closeSessionInCloudCli('cloudcli-session');
  });
  assert.deepEqual(closeSessionInCloudCli.mock.calls, [['cloudcli-session']]);
  assert.equal(result.current.open, false);
});

test('a poll answer that arrives after a newer one is dropped', async () => {
  // First poll: held back until the second one has been applied.
  let releaseStale: (() => void) | null = null;
  runningSessions.mockImplementationOnce(() => new Promise((resolve) => {
    releaseStale = () => resolve(pollResponse([], [{ sessionId: 'cloudcli-session' }]));
  }));
  closeSessionInCloudCli.mockResolvedValue({ ok: true });
  runningSessions.mockResolvedValue(pollResponse([], []));

  const { SessionProtectionProvider, useIsSessionOpenInCloudCli, useSessionProtectionActions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => ({
    open: useIsSessionOpenInCloudCli('cloudcli-session'),
    actions: useSessionProtectionActions(),
  }), { wrapper });

  await waitFor(() => assert.equal(runningSessions.mock.calls.length, 1));
  await act(async () => {
    await result.current.actions.closeSessionInCloudCli('cloudcli-session');
  });
  await act(async () => {
    releaseStale?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(result.current.open, false, 'the older answer does not put the closed row back');
});
