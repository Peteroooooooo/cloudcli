import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
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

vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useSessionOpenElsewhere: (sessionId: string) => openElsewhereById.get(sessionId) ?? null,
}));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(),
}));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;

const renderRow = (sessionId: string, isProcessing = false) => render(
  React.createElement(SidebarSessionItem, {
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
  }),
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
