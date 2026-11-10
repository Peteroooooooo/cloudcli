import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * The mobile sidebar is a drawer, so on entry it used to start closed and the
 * phone landed on an empty project page. It now opens on entry unless the URL
 * names a session, and only on entry: closing it or navigating later must not
 * bring it back.
 */

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => Promise.resolve({ ok: true, json: async () => [] }),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

type EntryProps = { sessionId?: string; isMobile: boolean };

const renderProjectsState = async (initialProps: EntryProps) => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(
    ({ sessionId, isMobile }: EntryProps) =>
      useProjectsState({
        sessionId,
        navigate: vi.fn(),
        subscribe: () => () => {},
        isMobile,
        isSessionProcessing: () => false,
      }),
    { initialProps },
  );
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('mobile entry without a session opens the sidebar', async () => {
  const { result } = await renderProjectsState({ isMobile: true });

  assert.equal(result.current.sidebarOpen, true);
});

test('mobile entry at a session keeps the chat uncovered', async () => {
  const { result } = await renderProjectsState({ isMobile: true, sessionId: 'session-1' });

  assert.equal(result.current.sidebarOpen, false);
});

test('desktop entry leaves the drawer state closed', async () => {
  const { result } = await renderProjectsState({ isMobile: false });

  assert.equal(result.current.sidebarOpen, false);
});

test('closing the sidebar and navigating afterwards does not reopen it', async () => {
  const { result, rerender } = await renderProjectsState({ isMobile: true });

  act(() => {
    result.current.setSidebarOpen(false);
  });
  rerender({ isMobile: true, sessionId: 'session-1' });
  rerender({ isMobile: true, sessionId: undefined });

  assert.equal(result.current.sidebarOpen, false);
});
