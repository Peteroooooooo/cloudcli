import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * Switching between sessions works like an editor's tabs: a session opened
 * before is shown from what the store already holds, only its newest rows are
 * asked for, and it opens where the reader left it, at the newest message if
 * they were following it or on the same row part-way up if they were not.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const ROW_HEIGHT = 100;
const ROWS = 30;
const PANE_HEIGHT = 500;

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const timestampOf = (sessionId: string, index: number) =>
  new Date(Date.UTC(2026, 10, sessionId === SESSION_A ? 1 : 2, 0, 0, index)).toISOString();

const buildMessages = (sessionId: string): NormalizedMessage[] =>
  Array.from({ length: ROWS }, (_, index) => ({
    id: `${sessionId}-${index}`,
    kind: 'text',
    role: index % 2 === 0 ? 'user' : 'assistant',
    provider: 'claude',
    sessionId,
    content: `message ${index}`,
    timestamp: timestampOf(sessionId, index),
  } as NormalizedMessage));

/** A pane laid out the way the transcript is, with fixed-height rows, since jsdom has no layout. */
function createPane() {
  const element = document.createElement('div');
  const list = document.createElement('div');
  element.appendChild(list);
  let scrollTop = 0;
  let scrollHeight = ROWS * ROW_HEIGHT;

  Object.defineProperty(element, 'scrollHeight', { get: () => scrollHeight });
  Object.defineProperty(element, 'clientHeight', { get: () => PANE_HEIGHT });
  Object.defineProperty(element, 'scrollTop', {
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = Math.max(0, Math.min(next, scrollHeight - PANE_HEIGHT));
    },
  });
  element.getBoundingClientRect = () => ({ top: 0, bottom: PANE_HEIGHT } as DOMRect);

  const showSession = (sessionId: string) => {
    list.replaceChildren();
    for (let index = 0; index < ROWS; index += 1) {
      const row = document.createElement('div');
      row.setAttribute('data-message-timestamp', timestampOf(sessionId, index));
      row.getBoundingClientRect = () => {
        const top = index * ROW_HEIGHT - scrollTop;
        return { top, bottom: top + ROW_HEIGHT } as DOMRect;
      };
      list.appendChild(row);
    }
  };

  // Content below the rows finishing its layout, which only changes the height.
  const addHeight = (extra: number) => {
    scrollHeight += extra;
  };

  return { element: element as HTMLDivElement, showSession, addHeight };
}

function createStore(messagesBySession: Map<string, NormalizedMessage[]>) {
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1,
    status: 'idle' as const,
    total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: false,
    offset: messagesBySession.get(sessionId)?.length ?? 0,
  });

  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({ slot: slotFor(sessionId), prependedCount: 0 })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      applied: true,
      changed: false,
      deferred: false,
    })),
    setActiveSession: vi.fn(),
    adoptPrefetchedHistory: vi.fn(() => false),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn((sessionId: string) => messagesBySession.get(sessionId) ?? []),
    getSessionSlot: vi.fn((sessionId: string) => slotFor(sessionId)),
  };
}

async function renderSessions(store: ReturnType<typeof createStore>) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  return renderHook(
    ({ session }: { session: ProjectSession }) =>
      useChatSessionState({
        isActive: true,
        selectedProject: project,
        selectedSession: session,
        ws: null,
        sendMessage: vi.fn(),
        resetStreamingState: vi.fn(),
        statusCheckSentAtRef: { current: new Map() },
        lastSeqRef: { current: new Map() },
        sessionStore: store as never,
      }),
    { initialProps: { session: { id: SESSION_A } as ProjectSession } },
  );
}

beforeEach(() => {
  // Frames run at once, so each opening placement settles inside the act() that triggers it.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('a session opened before comes back from the store, on the row the reader left it at', async () => {
  const messages = new Map([[SESSION_A, buildMessages(SESSION_A)], [SESSION_B, buildMessages(SESSION_B)]]);
  const store = createStore(messages);
  const { result, rerender } = await renderSessions(store);
  const pane = createPane();
  (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = pane.element;

  pane.showSession(SESSION_B);
  act(() => rerender({ session: { id: SESSION_B } as ProjectSession }));
  assert.equal(pane.element.scrollTop, ROWS * ROW_HEIGHT - PANE_HEIGHT, 'a first visit opens on the newest message');

  // The reader scrolls up to the middle of row 12 and leaves.
  pane.element.scrollTop = 12 * ROW_HEIGHT + 50;
  await act(async () => {
    await result.current.handleScroll();
  });

  pane.showSession(SESSION_A);
  act(() => rerender({ session: { id: SESSION_A } as ProjectSession }));
  assert.equal(pane.element.scrollTop, ROWS * ROW_HEIGHT - PANE_HEIGHT);

  pane.showSession(SESSION_B);
  act(() => rerender({ session: { id: SESSION_B } as ProjectSession }));

  assert.equal(pane.element.scrollTop, 12 * ROW_HEIGHT + 50, 'back on the same row, at the same offset');
  assert.equal(result.current.isUserScrolledUp, true, 'and not pulled down when new rows arrive');
  assert.equal(store.fetchFromServer.mock.calls.length, 0, 'nothing is re-read from the start');
  assert.ok(
    store.refreshLatestFromServer.mock.calls.some(([sessionId]) => sessionId === SESSION_B),
    'only the newest rows are asked for',
  );
});

test('a session left at the newest message opens on the newest message again', async () => {
  const messages = new Map([[SESSION_A, buildMessages(SESSION_A)], [SESSION_B, buildMessages(SESSION_B)]]);
  const store = createStore(messages);
  const { result, rerender } = await renderSessions(store);
  const pane = createPane();
  (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = pane.element;

  pane.showSession(SESSION_B);
  act(() => rerender({ session: { id: SESSION_B } as ProjectSession }));
  await act(async () => {
    await result.current.handleScroll();
  });

  pane.showSession(SESSION_A);
  act(() => rerender({ session: { id: SESSION_A } as ProjectSession }));
  pane.element.scrollTop = 0;

  pane.showSession(SESSION_B);
  act(() => rerender({ session: { id: SESSION_B } as ProjectSession }));

  assert.equal(pane.element.scrollTop, ROWS * ROW_HEIGHT - PANE_HEIGHT);
  assert.equal(result.current.isUserScrolledUp, false);
});

test('a reader following the end stays there while rows below finish rendering', async () => {
  const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
  vi.stubGlobal('ResizeObserver', class {
    private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.push(target); }
    disconnect() { this.entry.targets = []; }
  });
  const grow = (pane: ReturnType<typeof createPane>, extra: number) => {
    pane.addHeight(extra);
    for (const observer of observers) {
      if (observer.targets.length > 0) observer.callback([], observer as never);
    }
  };

  const messages = new Map([[SESSION_A, buildMessages(SESSION_A)], [SESSION_B, buildMessages(SESSION_B)]]);
  const store = createStore(messages);
  const { result, rerender } = await renderSessions(store);
  const pane = createPane();
  (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = pane.element;

  pane.showSession(SESSION_B);
  act(() => rerender({ session: { id: SESSION_B } as ProjectSession }));
  const end = () => pane.element.scrollHeight - PANE_HEIGHT;
  assert.equal(pane.element.scrollTop, end());

  // A row near the end mounts its content and grows; no message was added.
  grow(pane, 400);
  assert.equal(pane.element.scrollTop, end(), 'still at the end after the growth');

  // Once the reader scrolls up, growth below leaves them where they are.
  pane.element.scrollTop = 600;
  await act(async () => {
    await result.current.handleScroll();
  });
  grow(pane, 400);
  assert.equal(pane.element.scrollTop, 600);
});
