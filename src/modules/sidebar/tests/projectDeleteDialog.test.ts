import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as ApiModuleNamespace from '@/shared/api';
import type { Project } from '@/shared/types';

type ApiModule = typeof ApiModuleNamespace;

/**
 * Deleting a project erases every one of its sessions, of every agent and past
 * the pages the sidebar has loaded, so the dialog has to warn with the server's
 * count of them. There is no archive: confirming is always the real delete.
 */

const projectSessions = vi.fn();
const deleteProject = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projectSessions: (...args: unknown[]) => projectSessions(...args),
    deleteProject: (...args: unknown[]) => deleteProject(...args),
    recentConversations: () => Promise.resolve({ ok: true, json: async () => ({ data: { conversations: [] } }) }),
    migrateLegacyProjectStars: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;
const noop = () => {};
const NO_IDS: ReadonlySet<string> = new Set<string>();

// One session loaded out of the 128 the project holds.
const PROJECT: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: [{ id: 's1', summary: 'one', __provider: 'claude' }],
  sessionMeta: { hasMore: true, total: 1 },
};
const PROJECTS = [PROJECT];

const renderController = (onProjectDelete = vi.fn()) => renderHook(() => useSidebarController({
  projects: PROJECTS,
  selectedProject: null,
  selectedSession: null,
  activeSessions: NO_IDS,
  backgroundSessionIds: NO_IDS,
  isLoading: false,
  isMobile: false,
  t,
  onRefresh: noop,
  onProjectSelect: noop,
  onSessionSelect: noop,
  onProjectDelete,
  setCurrentProject: noop,
  setSidebarVisible: noop,
  sidebarVisible: true,
  providerFilter: 'all',
}));

beforeEach(() => {
  localStorage.clear();
  projectSessions.mockReset();
  projectSessions.mockResolvedValue({ ok: true, json: async () => ({ sessions: [], sessionMeta: { total: 128, hasMore: true } }) });
  deleteProject.mockReset();
  deleteProject.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('with every agent listed, the dialog still counts the sessions the sidebar has not loaded', async () => {
  const onProjectDelete = vi.fn();
  const { result } = renderController(onProjectDelete);

  act(() => {
    result.current.requestProjectDelete(PROJECT);
  });
  await waitFor(() => assert.equal(result.current.pendingDeletion?.kind, 'project'));

  assert.deepEqual(projectSessions.mock.calls, [['project-1', { limit: 1, offset: 0 }]], 'the count is asked for every agent');
  assert.equal(result.current.pendingDeletion?.kind === 'project' && result.current.pendingDeletion.sessionCount, 128);

  await act(async () => {
    await result.current.confirmDeleteProject();
  });
  assert.deepEqual(deleteProject.mock.calls, [['project-1']]);
  assert.deepEqual(onProjectDelete.mock.calls, [['project-1']]);
});

test('when the count cannot be fetched, the dialog falls back to what the sidebar knows', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  projectSessions.mockRejectedValue(new Error('offline'));
  const { result } = renderController();

  act(() => {
    result.current.requestProjectDelete({ ...PROJECT, sessionMeta: { hasMore: true, total: 40 } });
  });
  await waitFor(() => assert.equal(result.current.pendingDeletion?.kind, 'project'));
  assert.equal(result.current.pendingDeletion?.kind === 'project' && result.current.pendingDeletion.sessionCount, 40);
});

test('the delete requests always erase, for a project and for a session', async () => {
  const { api } = await vi.importActual<ApiModule>('@/shared/api');
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await api.deleteProject('project-1');
  await api.deleteSession('session-1');

  assert.deepEqual(
    fetchMock.mock.calls.map(([url, init]) => [url, init?.method]),
    [
      ['/api/projects/project-1?force=true', 'DELETE'],
      ['/api/providers/sessions/session-1?force=true', 'DELETE'],
    ],
  );
});
