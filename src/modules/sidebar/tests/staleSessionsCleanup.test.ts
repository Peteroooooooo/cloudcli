import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SidebarProjectListProps, StaleSessionListItem } from '@/shared/types';

/**
 * The "clean up old sessions" dialog: it lists what the server calls stale,
 * starts with everything ticked, deletes only after a second click, and keeps
 * what could not be deleted on screen with the reason.
 */

const deleteSession = vi.fn();
const staleSessions = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    deleteSession: (sessionId: string) => deleteSession(sessionId),
    staleSessions: (days?: number) => staleSessions(days),
    recentConversations: () => Promise.resolve({ ok: true, json: async () => ({ data: { conversations: [], total: 0, hasMore: false } }) }),
    migrateLegacyProjectStars: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  },
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(),
}));

const { default: StaleSessionsCleanup } = await import('@/modules/sidebar/StaleSessionsCleanup');
const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const NOW = new Date('2026-11-06T12:00:00.000Z');
const noop = () => {};
const t = ((key: string, options?: unknown) =>
  options && typeof options === 'object'
    ? `${key}:${Object.entries(options)
      .filter(([name]) => name !== 'defaultValue')
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(',')}`
    : key) as unknown as SidebarProjectListProps['t'];

const stale = (sessionId: string, projectId: string, extra: Partial<StaleSessionListItem> = {}): StaleSessionListItem => ({
  sessionId,
  provider: 'claude',
  projectId,
  projectPath: `/work/${projectId}`,
  projectDisplayName: projectId,
  sessionTitle: `title ${sessionId}`,
  lastActivity: '2026-10-20T00:00:00.000Z',
  ...extra,
});

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => ({ success: true, data }) });

beforeEach(() => {
  deleteSession.mockReset();
  staleSessions.mockReset();
});

const buttonWithText = (text: string): HTMLButtonElement | null =>
  [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) ?? null;

test('the dialog lists old sessions by project, all ticked, and deletes only after confirming', async () => {
  staleSessions.mockImplementation(() => okJson({
    sessions: [stale('a1', 'alpha'), stale('a2', 'alpha'), stale('b1', 'beta', { provider: 'codex' })],
  }));
  const onDeleteSessions = vi.fn(async () => [{ sessionId: 'b1', message: 'thread is attached to another thread' }]);

  render(React.createElement(StaleSessionsCleanup, { onClose: noop, onDeleteSessions, currentTime: NOW, t }));

  await waitFor(() => assert.ok(document.body.textContent?.includes('title a1')));
  assert.equal(staleSessions.mock.calls[0][0], 7, 'seven days is the default');
  const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.equal(boxes.length, 5, 'two project boxes and three session boxes');
  assert.ok(boxes.every((box) => box.checked), 'everything listed starts ticked');
  assert.equal(document.body.textContent?.includes('rchived'), false, 'nothing is marked archived');

  fireEvent.click(buttonWithText('staleCleanup.delete:count=3')!);
  assert.equal(onDeleteSessions.mock.calls.length, 0, 'the first click only asks');

  await act(async () => {
    fireEvent.click(buttonWithText('staleCleanup.confirm:count=3')!);
  });

  assert.deepEqual((onDeleteSessions.mock.calls[0] as unknown[])[0], ['a1', 'a2', 'b1']);
  await waitFor(() => assert.ok(document.body.textContent?.includes('thread is attached to another thread')));
  assert.equal(document.body.textContent?.includes('title a1'), false, 'deleted rows leave the list');
  assert.ok(document.body.textContent?.includes('title b1'), 'the failed row stays');
  assert.ok(document.body.textContent?.includes('staleCleanup.partialResult:deleted=2,failed=1'));
});

test('unticking a project leaves its sessions out of the delete', async () => {
  staleSessions.mockImplementation(() => okJson({ sessions: [stale('a1', 'alpha'), stale('b1', 'beta')] }));
  const onDeleteSessions = vi.fn(async () => []);

  render(React.createElement(StaleSessionsCleanup, { onClose: noop, onDeleteSessions, currentTime: NOW, t }));
  await waitFor(() => assert.ok(document.body.textContent?.includes('title a1')));

  const projectBox = [...document.body.querySelectorAll('label')]
    .find((label) => label.textContent?.startsWith('alpha'))!
    .querySelector('input')!;
  fireEvent.click(projectBox);

  fireEvent.click(buttonWithText('staleCleanup.delete:count=1')!);
  await act(async () => {
    fireEvent.click(buttonWithText('staleCleanup.confirm:count=1')!);
  });
  assert.deepEqual((onDeleteSessions.mock.calls[0] as unknown[])[0], ['b1']);
});

const PROJECTS: Project[] = [];
const NO_IDS: ReadonlySet<string> = new Set<string>();

test('the controller deletes across projects, skips running sessions and returns each failure with its reason', async () => {
  deleteSession.mockImplementation((sessionId: string) =>
    sessionId === 'bad'
      ? Promise.resolve({
        ok: false,
        status: 502,
        json: async () => ({ success: false, error: { code: 'SESSION_DELETE_FAILED', message: 'The session could not be deleted from codex: boom' } }),
      })
      : Promise.resolve({ ok: true, json: async () => ({}) }),
  );
  const onSessionDelete = vi.fn();
  const { result } = renderHook(() =>
    useSidebarController({
      projects: PROJECTS,
      selectedProject: null,
      selectedSession: null,
      activeSessions: new Set(['busy']),
      backgroundSessionIds: NO_IDS,
      isLoading: false,
      isMobile: false,
      t,
      onRefresh: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onSessionDelete,
      onLoadMoreSessions: noop,
      onProjectDelete: noop,
      setCurrentProject: noop,
      setSidebarVisible: noop,
      sidebarVisible: true,
    }),
  );

  const progress: number[] = [];
  let failures: Awaited<ReturnType<typeof result.current.deleteSessionsPermanently>> = [];
  await act(async () => {
    failures = await result.current.deleteSessionsPermanently(['good', 'bad', 'busy'], (settled) => progress.push(settled));
  });

  assert.deepEqual(deleteSession.mock.calls.map((call) => call[0]).sort(), ['bad', 'good'], 'a running session is not sent');
  assert.deepEqual(onSessionDelete.mock.calls, [['good']]);
  assert.deepEqual(
    failures.map((failure) => [failure.sessionId, failure.message]).sort(),
    [['bad', 'The session could not be deleted from codex: boom'], ['busy', 'staleCleanup.runningNow']],
  );
  assert.deepEqual(progress.sort(), [1, 2, 3]);
});
