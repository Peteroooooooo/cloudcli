import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem, ServerEvent } from '@/shared/types';

/**
 * The Conversations list is fetched once when its tab opens. A session whose
 * transcript is deleted outside the app is announced with `sessions_removed`;
 * the list has to drop that row itself, or it stays until the tab is reopened.
 */

const recentConversationsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => recentConversationsResponse(),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({
      ok: true,
      json: async () => ({
        data: {
          sessions: [{
            sessionId: 'archived-1',
            provider: 'claude',
            projectId: null,
            projectPath: null,
            projectDisplayName: 'repo',
            sessionTitle: 'Archived',
            createdAt: null,
            updatedAt: null,
            lastActivity: null,
            isProjectArchived: false,
          }],
        },
      }),
    }),
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

test('sessions deleted outside the app leave the open Conversations and archived lists', async () => {
  // Stable across renders: the controller resets state whenever `projects` changes.
  const projects: Project[] = [];
  const noSessions = new Set<string>();
  const subscribe = (listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const { result } = renderHook(() => useSidebarController({
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
    result.current.setSearchMode('conversations');
  });
  await waitFor(() => {
    assert.equal(result.current.recentConversations.length, 3);
    assert.equal(result.current.archivedSessions.length, 1);
  });

  act(() => {
    emit({ kind: 'sessions_removed', sessionIds: ['session-2', 'archived-1', 'not-loaded'], projectIds: [] });
  });

  assert.deepEqual(result.current.recentConversations.map((row) => row.sessionId), ['session-1', 'session-3']);
  // Only the loaded row that went is taken off the total.
  assert.equal(result.current.recentConversationsTotal, 9);
  assert.deepEqual(result.current.archivedSessions, []);
  // The list was patched in place, not refetched.
  assert.equal(recentConversationsResponse.mock.calls.length, 1);
});
