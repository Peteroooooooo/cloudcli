import assert from 'node:assert/strict';

import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

/**
 * On a phone the transcript shows one work card per turn instead of its tool
 * rows; the reply stays a normal row and the rows appear when the card opens.
 */
vi.mock('@/shared/hooks/useCompactLayout', () => ({ useCompactLayout: () => true }));

let second = 0;
const at = () => new Date(Date.UTC(2026, 10, 8, 10, 0, second++)).toISOString();

const REPLY = 'Everything is fixed and the build passes.';

const messages: ChatMessage[] = [
  { type: 'user', content: 'Fix the build', timestamp: at() },
  { type: 'assistant', content: 'Reading the config first.', timestamp: at() },
  {
    type: 'assistant', content: '', timestamp: at(), isToolUse: true, toolName: 'Read',
    toolInput: JSON.stringify({ file_path: '/repo/vite.config.ts' }), toolResult: { content: 'ok' },
  },
  {
    type: 'assistant', content: '', timestamp: at(), isToolUse: true, toolName: 'Edit',
    toolInput: JSON.stringify({ file_path: '/repo/vite.config.ts', old_string: 'a', new_string: 'b' }),
    toolResult: { content: 'ok' },
  },
  {
    type: 'assistant', content: '', timestamp: at(), isToolUse: true, toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'npm run build', description: 'Build the client' }),
    toolResult: { content: 'built' },
  },
  { type: 'assistant', content: REPLY, timestamp: at() },
];

const noop = () => undefined;

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderPane(isProcessing: boolean, rows: ChatMessage[]) {
  const props: any = {
    scrollContainerRef: createRef<HTMLDivElement>(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    selectedSession: { id: 'session-1' },
    selectedProject: { projectId: 'project-1', name: 'repo', path: '/repo' },
    providerModels: {},
    providerModelCatalog: {},
    providerModelActions: {},
    createDiff: () => [{ type: 'added', content: 'b', lineNum: 1 }, { type: 'removed', content: 'a', lineNum: 1 }],
    onGrantToolPermission: () => ({ success: true }),
    onWheel: noop,
    onTouchMove: noop,
    isLoadingSessionMessages: false,
    isProcessing,
    chatMessages: rows,
    currentSessionId: 'session-1',
    provider: 'claude',
    setProvider: noop,
    setProviderModel: noop,
    providerModelsLoading: false,
    tasksEnabled: false,
    isTaskMasterInstalled: false,
    onShowAllTasks: null,
    setInput: noop,
    isLoadingMoreMessages: false,
    hasMoreMessages: false,
    totalMessages: rows.length,
    sessionMessagesCount: rows.length,
    visibleMessageCount: 1000,
    visibleMessages: rows,
    loadEarlierMessages: noop,
    revealMessage: noop,
    sendMessage: noop,
    loadAllMessages: noop,
    allMessagesLoaded: true,
    isLoadingAllMessages: false,
    loadAllJustFinished: false,
    showLoadAllOverlay: false,
    showRawParameters: false,
    showThinking: true,
  };
  return render(
    <UiPreferencesProvider>
      <ChatMessagesPane {...props} />
    </UiPreferencesProvider>,
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

test('a finished turn shows one card, its changed file, and the reply', { timeout: 30_000 }, () => {
  const view = renderPane(false, messages);

  assert.equal(view.container.querySelectorAll('.chat-message.work-run').length, 1);
  assert.ok(view.container.textContent?.includes(REPLY));
  assert.ok(!view.container.textContent?.includes('Reading the config first.'), 'progress notes fold into the card');
  assert.ok(view.container.textContent?.includes('vite.config.ts'), 'the changed file is listed on the card');
  assert.ok(!view.container.textContent?.includes('npm run build'), 'tool rows stay hidden until opened');

  const header = view.container.querySelector('.chat-message.work-run button[aria-expanded]') as HTMLButtonElement;
  fireEvent.click(header);
  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.ok(view.container.textContent?.includes('npm run build'));
  assert.ok(view.container.textContent?.includes('Reading the config first.'));
});

test('while the agent works, the card names the step running now', { timeout: 30_000 }, () => {
  const running = messages.slice(0, 5).map((row, index) => (index === 4 ? { ...row, toolResult: null } : row));
  const view = renderPane(true, running);

  const card = view.container.querySelector('.chat-message.work-run');
  assert.ok(card?.textContent?.includes('Build the client'));
  assert.ok(card?.querySelector('.animate-spin'), 'a live card shows the spinner');
});
