import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { i18n } from '@/modules/i18n';
import type { SessionOpenElsewhere } from '@/shared/types';

/**
 * Session 75910518 was open in a VS Code panel while messages were sent to it
 * from CloudCLI. CloudCLI resumes the session in a process of its own, the
 * panel never saw those turns, and continuing in VS Code later forked the
 * transcript. The composer now says so whenever the session is open in
 * another Claude process, without stopping the send.
 */

vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({ state: 'idle', toggle: () => {}, stop: () => {} }),
}));
vi.mock('@/modules/chat/composer/CommandMenu', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ComposerModelMenu', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ComposerPermissionMenu', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/TokenUsageSummary', () => ({ default: () => null }));

const { default: ChatComposer } = await import('@/modules/chat/composer/ChatComposer');

const noop = () => {};
const renderComposer = (openElsewhere: SessionOpenElsewhere | null) => {
  const props = {
    pendingPermissionRequests: [],
    handlePermissionDecision: noop,
    handleGrantToolPermission: () => ({ success: true }),
    activity: null,
    isLoading: false,
    onAbortSession: noop,
    permissionMode: 'default',
    availablePermissionModes: ['default'],
    onSelectPermissionMode: noop,
    providerLabel: 'Claude',
    effort: '',
    availableEffortOptions: [],
    onSelectEffort: noop,
    model: '',
    availableModelOptions: [],
    onSelectModel: noop,
    modelsLoading: false,
    tokenBudget: null,
    onShowTokenUsage: noop,
    slashCommandsCount: 0,
    onToggleCommandMenu: noop,
    hasInput: false,
    onClearInput: noop,
    onSubmit: noop,
    isDragActive: false,
    queuedDraft: null,
    backgroundSendPrompt: null,
    onResolveBackgroundSendPrompt: noop,
    isEditingSentMessage: false,
    openElsewhere,
    onCancelEditMessage: noop,
    scheduledMessages: [],
    onScheduleMessage: noop,
    onCancelScheduledMessage: noop,
    onEditQueuedDraft: noop,
    onDeleteQueuedDraft: noop,
    attachedFiles: [],
    onRemoveAttachment: noop,
    fileErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: -1,
    onSelectFile: noop,
    filteredCommands: [],
    selectedCommandIndex: -1,
    onCommandSelect: noop,
    onCloseCommandMenu: noop,
    isCommandMenuOpen: false,
    frequentCommands: [],
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    openAttachmentPicker: noop,
    inputHighlightRef: { current: null },
    renderInputWithMentions: (text: string) => text,
    textareaRef: { current: null },
    input: '',
    onInputChange: noop,
    onTextareaClick: noop,
    onTextareaKeyDown: noop,
    onTextareaPaste: noop,
    onTextareaScrollSync: noop,
    onTextareaInput: noop,
    placeholder: 'Message',
    isTextareaExpanded: false,
  } as unknown as React.ComponentProps<typeof ChatComposer>;
  return render(React.createElement(ChatComposer, props));
};

test('a session open in VS Code warns that sending from here branches it', () => {
  const { getByTestId } = renderComposer({ openIn: 'vscode', busy: false });

  assert.equal(
    getByTestId('open-elsewhere-notice').textContent,
    i18n.t('chat:composer.openElsewhere.vscode'),
  );
  assert.match(getByTestId('open-elsewhere-notice').textContent ?? '', /VS Code/);
});

test('the warning does not stop the send', () => {
  const { container } = renderComposer({ openIn: 'cli', busy: false });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea);
  assert.equal(textarea.disabled, false);
});

test('a session open nowhere else shows no warning', () => {
  const { queryByTestId } = renderComposer(null);
  assert.equal(queryByTestId('open-elsewhere-notice'), null);
});

test('the warning is translated for the Chinese locales', async () => {
  const previous = i18n.language;
  try {
    for (const locale of ['zh-CN', 'zh-TW']) {
      await i18n.changeLanguage(locale);
      for (const openIn of ['vscode', 'cli', 'other'] as const) {
        const text = i18n.t(`chat:composer.openElsewhere.${openIn}`);
        assert.notEqual(text, i18n.t(`chat:composer.openElsewhere.${openIn}`, { lng: 'en' }));
        assert.match(text, /[一-鿿]/);
      }
    }
  } finally {
    await i18n.changeLanguage(previous);
  }
});
