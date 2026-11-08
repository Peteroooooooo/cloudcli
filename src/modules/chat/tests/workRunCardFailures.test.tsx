import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import WorkRunCard from '@/modules/chat/transcript/WorkRunCard';
import { groupWorkRuns, isWorkRunItem } from '@/modules/chat/utils/workRunGrouping';
import type { ChatMessage } from '@/shared/types';

/**
 * A step that failed inside a turn used to turn the whole card red, with
 * "n failed" in its title. Agents fail and retry as they work (a timeout, a
 * command that exits non-zero, a call the user stopped), so the card now
 * looks the same either way; the failed step is still red once opened.
 */

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 8, 10, 0, clock++)).toISOString();

const tool = (toolName: string, toolResult: ChatMessage['toolResult']): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: at(),
  isToolUse: true,
  toolName,
  toolInput: JSON.stringify({ command: 'npm test' }),
  toolResult,
});

test('a finished turn with a failed step shows the plain check and no failure count', () => {
  const items = groupWorkRuns([
    { type: 'user', content: 'run the tests', timestamp: at() },
    tool('Bash', { content: 'exit 1', isError: true }),
    tool('Bash', { content: 'ok' }),
    { type: 'assistant', content: 'x'.repeat(800), timestamp: at() },
  ]);
  const run = items.find(isWorkRunItem);
  assert.ok(run);

  const { container } = render(
    <WorkRunCard
      run={run}
      prevMessage={null}
      isLive={false}
      createDiff={() => []}
      getMessageKey={(message) => String(message.timestamp)}
      provider="claude"
    />,
  );

  const header = container.querySelector('button');
  assert.match(header?.textContent ?? '', /2 steps/);
  assert.doesNotMatch(header?.textContent ?? '', /failed|出错/);
  assert.equal(container.querySelector('[class*="text-red"]'), null);
});
