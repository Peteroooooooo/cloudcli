import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SessionOpenElsewhere, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * A session open in a VS Code panel or a terminal gets a quiet label on its
 * sidebar row (an icon badge, the tooltip naming where), so the user knows a message sent from here will
 * branch the conversation that process holds.
 */

const openElsewhereById = new Map<string, SessionOpenElsewhere>([
  ['vscode-session', { openIn: 'vscode', busy: false }],
  ['busy-cli-session', { openIn: 'cli', busy: true }],
]);
const openInCloudCli = new Set(['cloudcli-session', 'vscode-session']);

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useSessionOpenElsewhere: (sessionId: string) => openElsewhereById.get(sessionId) ?? null,
  useIsSessionOpenInCloudCli: (sessionId: string) => openInCloudCli.has(sessionId),
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(),
}));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;

type RowProps = React.ComponentProps<typeof SidebarSessionItem>;

const rowProps = (sessionId: string, isProcessing = false): RowProps => ({
  project: PROJECT,
  session: { id: sessionId, summary: sessionId, lastActivity: '2026-08-21T09:00:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider,
  selectedSession: null,
  isProcessing,
  hasBackgroundWork: false,
  needsAttention: false,
  currentTime: new Date('2026-08-21T10:00:00.000Z'),
  isEditing: false,
  renameDraft: '',
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onProjectSelect: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  isSelecting: false,
  isChecked: false,
  onToggleSessionSelected: noop,
  t,
});

const renderRow = (sessionId: string, isProcessing = false, extra: Partial<RowProps> = {}) => render(
  React.createElement(SidebarSessionItem, { ...rowProps(sessionId, isProcessing), ...extra }),
);

test('a session open in VS Code gets a badge saying where it is open', () => {
  const { getByTestId } = renderRow('vscode-session');

  const marker = getByTestId('open-elsewhere-marker');
  assert.equal(marker.getAttribute('data-open-in'), 'vscode');
});

test('a busy session keeps its spinner and still says where it runs', () => {
  const { getByTestId, container } = renderRow('busy-cli-session', true);

  assert.equal(getByTestId('open-elsewhere-marker').getAttribute('data-open-in'), 'cli');
  assert.equal(container.querySelectorAll('.animate-spin').length, 1);
});

test('a session open nowhere else has no badge', () => {
  const { queryByTestId } = renderRow('closed-session');
  assert.equal(queryByTestId('open-elsewhere-marker'), null);
});

test('a session open only in CloudCLI gets the same badge', () => {
  const { getByTestId } = renderRow('cloudcli-session');

  const marker = getByTestId('open-elsewhere-marker');
  assert.equal(marker.getAttribute('data-open-in'), 'cloudcli');
});

test('a session open in VS Code and in CloudCLI is labelled by the other process', () => {
  const { getAllByTestId } = renderRow('vscode-session');

  const markers = getAllByTestId('open-elsewhere-marker');
  assert.equal(markers.length, 1, 'one glyph, never two');
  assert.equal(markers[0].getAttribute('data-open-in'), 'vscode');
});

test('the × closes the session in CloudCLI without opening it', () => {
  const onCloseOpenSession = vi.fn();
  const onSessionSelect = vi.fn();
  const { getByRole } = renderRow('cloudcli-session', false, { onSessionSelect, onCloseOpenSession });

  fireEvent.click(getByRole('button', { name: 'running.close' }));
  assert.deepEqual(onCloseOpenSession.mock.calls, [['cloudcli-session']]);
  assert.equal(onSessionSelect.mock.calls.length, 0);
});

test('a row without the close handler, or one being ticked, has no ×', () => {
  const plain = renderRow('cloudcli-session');
  assert.equal(plain.queryByRole('button', { name: 'running.close' }), null);
  plain.unmount();

  const selecting = renderRow('cloudcli-session', false, { onCloseOpenSession: noop, isSelecting: true });
  assert.equal(selecting.queryByRole('button', { name: 'running.close' }), null);
});
