import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, SessionProviderFilter } from '@/shared/types';

/**
 * The sidebar's agent filter lives in the projects state: it is remembered per
 * browser, every project fetch carries it, a change refetches from the DB
 * without a transcript rescan, and nothing fetched or pushed for another agent
 * ends up in a narrowed list.
 */

const STORAGE_KEY = 'cloudcli-sidebar-provider-filter';

const projectsResponse = vi.fn();
const projectSessionsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: (...args: unknown[]) => projectsResponse(...args),
    projectSessions: (...args: unknown[]) => projectSessionsResponse(...args),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
  },
}));

const claudeSession = (index: number): ProjectSession => ({ id: `claude-${index}`, summary: `Claude ${index}`, __provider: 'claude' });
const codexSession = (index: number): ProjectSession => ({ id: `codex-${index}`, summary: `Codex ${index}`, __provider: 'codex' });

const buildProject = (sessions: ProjectSession[], total = sessions.length): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: sessions.length < total, total },
});

const respondWith = (projects: Project[]) => ({ ok: true, json: async () => projects });

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const buildUpsert = (sessionId: string, provider: string) => ({
  kind: 'session_upserted',
  sessionId,
  provider,
  session: { id: sessionId, summary: `live ${sessionId}`, messageCount: 1, lastActivity: '2026-11-06T10:00:00.000Z' },
  project: { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false },
  timestamp: '2026-11-06T10:00:00.000Z',
});

const renderProjectsState = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');

  return renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

type Rendered = Awaited<ReturnType<typeof renderProjectsState>>['result'];

const sessionIds = (result: Rendered) => (result.current.projects[0]?.sessions ?? []).map((session) => session.id);

const changeFilter = async (result: Rendered, filter: SessionProviderFilter) => {
  await act(async () => {
    result.current.sidebarSharedProps.onProviderFilterChange(filter);
  });
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectSessionsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('the remembered filter is read back on mount and sent with the first fetch', async () => {
  localStorage.setItem(STORAGE_KEY, 'codex');
  projectsResponse.mockResolvedValue(respondWith([buildProject([codexSession(1)])]));

  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });

  assert.equal(result.current.sidebarSharedProps.providerFilter, 'codex');
  assert.deepEqual(projectsResponse.mock.calls, [[{ provider: 'codex', skipSync: false }]]);
});

test('an unknown remembered value falls back to all', async () => {
  localStorage.setItem(STORAGE_KEY, 'gemini');
  projectsResponse.mockResolvedValue(respondWith([]));

  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.isLoadingProjects, false);
  });

  assert.equal(result.current.sidebarSharedProps.providerFilter, 'all');
  assert.deepEqual(projectsResponse.mock.calls, [[{ provider: 'all', skipSync: false }]]);
});

test('a blocked localStorage leaves the filter usable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  projectsResponse.mockResolvedValue(respondWith([]));

  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.isLoadingProjects, false);
  });
  assert.equal(result.current.sidebarSharedProps.providerFilter, 'all');

  await changeFilter(result, 'claude');
  assert.equal(result.current.sidebarSharedProps.providerFilter, 'claude');
});

test('changing the filter remembers it and refetches from the DB without a rescan', async () => {
  projectsResponse.mockResolvedValue(respondWith([buildProject([claudeSession(1), codexSession(1)])]));
  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });

  projectsResponse.mockResolvedValue(respondWith([buildProject([claudeSession(1)])]));
  await changeFilter(result, 'claude');
  await waitFor(() => {
    assert.deepEqual(sessionIds(result), ['claude-1']);
  });

  assert.equal(result.current.sidebarSharedProps.providerFilter, 'claude');
  assert.equal(localStorage.getItem(STORAGE_KEY), 'claude');
  assert.deepEqual(projectsResponse.mock.calls.at(-1), [{ provider: 'claude', skipSync: true }]);

  // Picking the segment that is already selected does nothing.
  const callsBefore = projectsResponse.mock.calls.length;
  await changeFilter(result, 'claude');
  assert.equal(projectsResponse.mock.calls.length, callsBefore);
});

test('pages loaded under one filter are not merged into the list of another', async () => {
  // 25 sessions loaded under "all", more than the narrowed answer carries, so
  // the usual keep-what-was-expanded merge would bring Claude rows back.
  const loaded = [...Array.from({ length: 20 }, (_, index) => claudeSession(index)), ...Array.from({ length: 5 }, (_, index) => codexSession(index))];
  projectsResponse.mockResolvedValue(respondWith([buildProject(loaded, 25)]));
  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(sessionIds(result).length, 25);
  });

  projectsResponse.mockResolvedValue(respondWith([buildProject([codexSession(0), codexSession(1)], 5)]));
  await changeFilter(result, 'codex');
  await waitFor(() => {
    assert.deepEqual(sessionIds(result), ['codex-0', 'codex-1']);
  });
  assert.deepEqual(result.current.projects[0]?.sessionMeta, { hasMore: true, total: 5 });
});

test('load more asks for the next page within the filter', async () => {
  localStorage.setItem(STORAGE_KEY, 'codex');
  projectsResponse.mockResolvedValue(respondWith([buildProject([codexSession(0)], 2)]));
  projectSessionsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({ sessions: [codexSession(1)], sessionMeta: { hasMore: false, total: 2 } }),
  });
  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });

  await act(async () => {
    await result.current.loadMoreProjectSessions('project-1');
  });

  assert.deepEqual(projectSessionsResponse.mock.calls, [['project-1', { limit: 20, offset: 1, provider: 'codex' }]]);
  assert.deepEqual(sessionIds(result), ['codex-0', 'codex-1']);
});

test('a page that lands after the filter changed is dropped', async () => {
  projectsResponse.mockResolvedValue(respondWith([buildProject([claudeSession(0)], 3)]));
  let resolvePage!: (value: unknown) => void;
  projectSessionsResponse.mockReturnValue(new Promise((resolve) => {
    resolvePage = resolve;
  }));
  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });

  let loading: Promise<void> = Promise.resolve();
  act(() => {
    loading = result.current.loadMoreProjectSessions('project-1');
  });

  projectsResponse.mockResolvedValue(respondWith([buildProject([claudeSession(0)], 1)]));
  await changeFilter(result, 'claude');
  await waitFor(() => {
    assert.equal(result.current.projects[0]?.sessionMeta?.total, 1);
  });

  await act(async () => {
    resolvePage({
      ok: true,
      json: async () => ({ sessions: [claudeSession(1), codexSession(1)], sessionMeta: { hasMore: false, total: 3 } }),
    });
    await loading;
  });

  assert.deepEqual(sessionIds(result), ['claude-0']);
});

test('a live update for another agent does not enter a narrowed list', async () => {
  localStorage.setItem(STORAGE_KEY, 'claude');
  projectsResponse.mockResolvedValue(respondWith([buildProject([claudeSession(1)])]));
  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  const projectsBefore = result.current.projects;

  act(() => {
    emit(buildUpsert('codex-live', 'codex'));
  });
  assert.equal(result.current.projects, projectsBefore, 'the Codex session is not stored');

  act(() => {
    emit(buildUpsert('claude-live', 'claude'));
  });
  assert.deepEqual(sessionIds(result).sort(), ['claude-1', 'claude-live']);
});

test('with all selected, live updates of every agent are stored', async () => {
  projectsResponse.mockResolvedValue(respondWith([buildProject([claudeSession(1)])]));
  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });

  act(() => {
    emit(buildUpsert('codex-live', 'codex'));
  });
  assert.deepEqual(sessionIds(result).sort(), ['claude-1', 'codex-live']);
});
