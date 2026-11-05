import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { LLMProvider, ServerEvent, SessionProviderFilter } from '@/shared/types';

/**
 * The agent filter at the top of the sidebar: a radio group of "All" and each
 * agent that has sessions. It is not drawn when there is nothing to choose,
 * the arrow keys move the selection, and a choice whose agent has no sessions
 * left falls back to All.
 */

const sessionProviderCounts = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    sessionProviderCounts: () => sessionProviderCounts(),
  },
}));

const { default: SidebarProviderFilter } = await import('@/modules/sidebar/SidebarProviderFilter');
const { useProviderFilterOptions } = await import('@/modules/sidebar/hooks/useProviderFilterOptions');

const t = ((key: string, fallback?: string) => fallback ?? key) as unknown as TFunction;

const renderFilter = (value: SessionProviderFilter, providers: LLMProvider[]) => {
  const onChange = vi.fn<(filter: SessionProviderFilter) => void>();
  const rendered = render(<SidebarProviderFilter value={value} providers={providers} onChange={onChange} t={t} />);
  return { ...rendered, onChange };
};

const segmentNames = () => screen.getAllByRole('radio').map((segment) => segment.textContent);

const countsAnswer = (counts: Partial<Record<LLMProvider, number>>) => ({
  ok: true,
  json: async () => ({ success: true, data: { counts } }),
});

type ServerEventListener = (event: ServerEvent) => void;

const listeners = new Set<ServerEventListener>();
const subscribe = (listener: ServerEventListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = (event: ServerEvent) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const renderOptions = (providerFilter: SessionProviderFilter) => {
  const onProviderFilterChange = vi.fn<(filter: SessionProviderFilter) => void>();
  const rendered = renderHook(
    ({ filter }) => useProviderFilterOptions({ providerFilter: filter, onProviderFilterChange, subscribe }),
    { initialProps: { filter: providerFilter } },
  );
  return { ...rendered, onProviderFilterChange };
};

/** Lets the mount fetch answer and the effects after it run. */
const settle = () => act(async () => {});

beforeEach(() => {
  sessionProviderCounts.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

test('the control offers All and then each agent it is given, in that order', () => {
  renderFilter('all', ['claude', 'codex', 'opencode']);

  assert.ok(screen.getByRole('radiogroup', { name: 'Filter sessions by agent' }));
  assert.deepEqual(segmentNames(), ['All', 'Claude', 'Codex', 'OpenCode']);
  const checked = screen.getAllByRole('radio').filter((segment) => segment.getAttribute('aria-checked') === 'true');
  assert.deepEqual(checked.map((segment) => segment.textContent), ['All']);
});

test('nothing is drawn while only one agent has sessions and All is selected', () => {
  const { container } = renderFilter('all', ['claude']);
  assert.equal(container.childElementCount, 0);

  const empty = renderFilter('all', []);
  assert.equal(empty.container.childElementCount, 0);
});

test('a narrowed choice stays visible so it can be switched back to All', () => {
  renderFilter('codex', ['codex']);
  assert.deepEqual(segmentNames(), ['All', 'Codex']);
});

test('only the selected segment is in the tab order, and the thumb sits under it', () => {
  const { container } = renderFilter('codex', ['claude', 'codex']);

  const tabStops = screen.getAllByRole('radio').map((segment) => segment.getAttribute('tabindex'));
  assert.deepEqual(tabStops, ['-1', '-1', '0']);
  const thumb = container.querySelector<HTMLElement>('[aria-hidden]');
  assert.equal(thumb?.style.transform, 'translateX(200%)');
  assert.ok(thumb?.style.width.startsWith('33.3'));
});

test('clicking a segment selects it; clicking the selected one does nothing', () => {
  const { onChange } = renderFilter('all', ['claude', 'codex']);

  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  fireEvent.click(screen.getByRole('radio', { name: 'All' }));

  assert.deepEqual(onChange.mock.calls, [['codex']]);
});

test('arrow keys move the selection and wrap; Home and End jump to the ends', () => {
  const { onChange, rerender } = renderFilter('all', ['claude', 'codex']);
  const group = screen.getByRole('radiogroup');
  const rerenderWith = (value: SessionProviderFilter) => rerender(
    <SidebarProviderFilter value={value} providers={['claude', 'codex']} onChange={onChange} t={t} />,
  );

  fireEvent.keyDown(group, { key: 'ArrowRight' });
  assert.deepEqual(onChange.mock.calls.at(-1), ['claude']);
  assert.equal(document.activeElement, screen.getByRole('radio', { name: 'Claude' }), 'focus follows the selection');

  rerenderWith('claude');
  fireEvent.keyDown(group, { key: 'ArrowDown' });
  assert.deepEqual(onChange.mock.calls.at(-1), ['codex']);

  rerenderWith('codex');
  fireEvent.keyDown(group, { key: 'ArrowRight' });
  assert.deepEqual(onChange.mock.calls.at(-1), ['all'], 'past the last segment wraps to the first');

  rerenderWith('all');
  fireEvent.keyDown(group, { key: 'ArrowLeft' });
  assert.deepEqual(onChange.mock.calls.at(-1), ['codex'], 'before the first segment wraps to the last');

  rerenderWith('codex');
  fireEvent.keyDown(group, { key: 'Home' });
  assert.deepEqual(onChange.mock.calls.at(-1), ['all']);

  rerenderWith('all');
  fireEvent.keyDown(group, { key: 'End' });
  assert.deepEqual(onChange.mock.calls.at(-1), ['codex']);

  const callsBefore = onChange.mock.calls.length;
  fireEvent.keyDown(group, { key: 'a' });
  assert.equal(onChange.mock.calls.length, callsBefore, 'other keys are left alone');
});

test('the options are the agents with sessions, archived ones counted, in display order', async () => {
  sessionProviderCounts.mockResolvedValue(countsAnswer({ opencode: 1, codex: 4, claude: 9 }));
  const { result } = renderOptions('all');

  assert.deepEqual(result.current.providerFilterOptions, [], 'nothing is offered before the counts arrive');
  await settle();

  assert.deepEqual(result.current.providerFilterOptions, ['claude', 'codex', 'opencode']);
});

test('while the counts are unknown the chosen agent stays on offer', async () => {
  sessionProviderCounts.mockReturnValue(new Promise(() => {}));
  const { result, onProviderFilterChange } = renderOptions('codex');
  await settle();

  assert.deepEqual(result.current.providerFilterOptions, ['codex']);
  assert.equal(onProviderFilterChange.mock.calls.length, 0);
});

test('a remembered agent without sessions falls back to All', async () => {
  sessionProviderCounts.mockResolvedValue(countsAnswer({ claude: 3, opencode: 2 }));
  const { onProviderFilterChange } = renderOptions('codex');
  await settle();

  assert.deepEqual(onProviderFilterChange.mock.calls, [['all']]);
});

test('a single agent with sessions leaves nothing to choose and falls back to All', async () => {
  sessionProviderCounts.mockResolvedValue(countsAnswer({ claude: 3 }));
  const { onProviderFilterChange } = renderOptions('claude');
  await settle();

  assert.deepEqual(onProviderFilterChange.mock.calls, [['all']]);
});

test('a kept choice whose agent still has sessions is left alone', async () => {
  sessionProviderCounts.mockResolvedValue(countsAnswer({ claude: 3, codex: 1 }));
  const { onProviderFilterChange } = renderOptions('codex');
  await settle();

  assert.equal(onProviderFilterChange.mock.calls.length, 0);
});

test('the counts are asked for again when an agent may gain its first session or lose its last', async () => {
  sessionProviderCounts.mockResolvedValue(countsAnswer({ claude: 3, codex: 1 }));
  const { result } = renderOptions('all');
  await settle();
  assert.equal(sessionProviderCounts.mock.calls.length, 1);

  vi.useFakeTimers();
  const flush = () => act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });

  act(() => {
    emit({ kind: 'session_upserted', provider: 'codex' } as ServerEvent);
  });
  await flush();
  assert.equal(sessionProviderCounts.mock.calls.length, 1, 'more sessions of a counted agent change nothing');

  sessionProviderCounts.mockResolvedValue(countsAnswer({ claude: 3, codex: 1, cursor: 1 }));
  act(() => {
    emit({ kind: 'session_upserted', provider: 'cursor' } as ServerEvent);
  });
  await flush();
  assert.equal(sessionProviderCounts.mock.calls.length, 2, 'a first Cursor session is counted');
  assert.deepEqual(result.current.providerFilterOptions, ['claude', 'codex', 'cursor']);

  act(() => {
    emit({ kind: 'sessions_removed' } as ServerEvent);
    emit({ kind: 'websocket_reconnected' } as ServerEvent);
    result.current.refreshCountsSoon();
  });
  await flush();
  assert.equal(sessionProviderCounts.mock.calls.length, 3, 'a burst is gathered into one request');
});

test('a failed refetch keeps the last counts', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sessionProviderCounts.mockResolvedValue(countsAnswer({ claude: 3, codex: 1 }));
  const { result } = renderOptions('all');
  await settle();

  vi.useFakeTimers();
  sessionProviderCounts.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  act(() => {
    result.current.refreshCountsSoon();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });

  assert.deepEqual(result.current.providerFilterOptions, ['claude', 'codex']);
});
