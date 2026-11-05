import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * `sessions_removed` is how the sidebar learns that transcripts were deleted
 * outside the app. Without it a deleted session stays listed until a reload.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const buildProject = (projectId: string, sessionIds: string[]): Project => ({
  projectId,
  path: `/${projectId}`,
  fullPath: `/${projectId}`,
  displayName: projectId,
  isStarred: false,
  sessions: sessionIds.map((id) => ({ id, summary: id }) as ProjectSession),
  sessionMeta: { hasMore: false, total: sessionIds.length },
});

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const renderProjectsState = async (navigate: ReturnType<typeof vi.fn>, urlSessionId?: string) => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: urlSessionId,
      navigate: navigate as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('removed sessions and emptied projects leave the sidebar', async () => {
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject('kept', ['a', 'b']), buildProject('emptied', ['c'])],
  });
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate);

  await waitFor(() => {
    assert.equal(result.current.projects.length, 2);
  });

  await act(async () => {
    emit({ kind: 'sessions_removed', sessionIds: ['b', 'c'], projectIds: ['emptied'], timestamp: '' });
  });

  assert.deepEqual(result.current.projects.map((project) => project.projectId), ['kept']);
  assert.deepEqual((result.current.projects[0].sessions ?? []).map((session) => session.id), ['a']);
  assert.equal(result.current.projects[0].sessionMeta?.total, 1);
  assert.deepEqual(navigate.mock.calls, []);
});

test('the open session is closed when its transcript is deleted elsewhere', async () => {
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject('repo', ['open', 'other'])],
  });
  const navigate = vi.fn();
  const { result } = await renderProjectsState(navigate, 'open');

  await waitFor(() => {
    assert.equal(result.current.projects[0]?.sessions?.length, 2);
  });

  act(() => {
    result.current.handleSessionSelect({ id: 'open' } as ProjectSession);
  });
  navigate.mockClear();

  await act(async () => {
    emit({ kind: 'sessions_removed', sessionIds: ['open'], projectIds: [], timestamp: '' });
  });

  assert.equal(result.current.selectedSession, null);
  assert.deepEqual(navigate.mock.calls, [['/']]);
  assert.deepEqual((result.current.projects[0].sessions ?? []).map((session) => session.id), ['other']);
});
