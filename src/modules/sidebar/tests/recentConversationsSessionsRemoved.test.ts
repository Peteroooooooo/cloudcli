import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem, ServerEvent } from '@/shared/types';

/**
 * The Conversations list is fetched once when its tab opens. A deleted session
 * is announced with `sessions_removed`, whether it went outside the app or from
 * this sidebar; the list has to drop that row itself, or it stays until the tab
 * is reopened, and must not take it off the total twice.
 */

const recentConversationsResponse = vi.fn();
const deleteSession = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => recentConversationsResponse(),
    deleteSession: (sessionId: string) => deleteSession(sessionId),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

const conversation = (sessionId: string): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'repo',
  sessionTitle: sessionId,
  lastActivity: '2026-11-05T09:30:00.000Z',
});

const listeners = new Set<(event: ServerEvent) => void>();
const emit = (event: ServerEvent) => {
  for (const listener of listeners) {
    listener(event);
  }
};

beforeEach(() => {
  localStorage.clear();
  listeners.clear();
  deleteSession.mockReset();
  recentConversationsResponse.mockReset();
  recentConversationsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        conversations: [conversation('session-1'), conversation('session-2'), conversation('session-3')],
        total: 10,
        hasMore: true,
      },
    }),
  });
});

// Stable across renders: the controller resets state whenever `projects` changes.
const projects: Project[] = [];
const noSessions = new Set<string>();

async function renderWithOpenConversations() {
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const rendered = renderHook(() => useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: noSessions,
    backgroundSessionIds: noSessions,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: vi.fn(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
    subscribe,
  }));

  act(() => {
    rendered.result.current.setSearchMode('conversations');
  });
  await waitFor(() => {
    assert.equal(rendered.result.current.recentConversations.length, 3);
  });
  return rendered;
}

test('sessions deleted outside the app leave the open Conversations list', async () => {
  const { result } = await renderWithOpenConversations();

  act(() => {
    emit({ kind: 'sessions_removed', sessionIds: ['session-2', 'not-loaded'], projectIds: [] });
  });

  assert.deepEqual(result.current.recentConversations.map((row) => row.sessionId), ['session-1', 'session-3']);
  // Only the loaded row that went is taken off the total.
  assert.equal(result.current.recentConversationsTotal, 9);
  // The list was patched in place, not refetched.
  assert.equal(recentConversationsResponse.mock.calls.length, 1);
});

test('a delete from the sidebar takes its rows off the total once, though the server announces it too', async () => {
  // The server tells every client before it answers the request that deleted.
  deleteSession.mockImplementation(async (sessionId: string) => {
    emit({ kind: 'sessions_removed', sessionIds: [sessionId], projectIds: [] });
    return { ok: true, text: async () => '' };
  });
  const { result } = await renderWithOpenConversations();

  act(() => {
    result.current.showDeleteSelectedSessionsConfirmation(['session-1', 'session-2']);
  });
  await act(async () => {
    await result.current.confirmDeleteSessions();
  });

  assert.deepEqual(result.current.recentConversations.map((row) => row.sessionId), ['session-3']);
  assert.equal(result.current.recentConversationsTotal, 8);

  act(() => {
    result.current.showDeleteSessionConfirmation('session-3', 'session-3');
  });
  await act(async () => {
    await result.current.confirmDeleteSession();
  });

  assert.deepEqual(result.current.recentConversations, []);
  assert.equal(result.current.recentConversationsTotal, 7);
});
