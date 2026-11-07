import assert from 'node:assert/strict';

import { test } from 'vitest';

import { groupWorkRuns, isWorkRunItem } from '@/modules/chat/utils/workRunGrouping';
import type { TranscriptItem } from '@/modules/chat/utils/workRunGrouping';
import type { ChatMessage, WorkRunItem } from '@/shared/types';

/**
 * On a phone each turn's tool calls, reasoning and short progress notes fold
 * into one card, while the reply and anything the user must answer stay rows.
 */

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 8, 10, 0, clock++)).toISOString();

const user = (content: string): ChatMessage => ({ type: 'user', content, timestamp: at() });
const note = (content: string): ChatMessage => ({ type: 'assistant', content, timestamp: at() });
const thinking = (): ChatMessage => ({ type: 'assistant', content: 'hmm', isThinking: true, timestamp: at() });
const tool = (toolName: string, toolInput: Record<string, unknown>, toolResult: ChatMessage['toolResult'] = { content: 'ok' }): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: at(),
  isToolUse: true,
  toolName,
  toolInput: JSON.stringify(toolInput),
  toolResult,
});

const runs = (items: TranscriptItem[]): WorkRunItem[] => items.filter(isWorkRunItem);

test('a turn folds its notes and tool calls into one card and keeps the reply outside', () => {
  const reply = note('x'.repeat(800));
  const messages = [
    user('fix it'),
    note('Let me read the config first.'),
    tool('Read', { file_path: '/repo/a.ts' }),
    tool('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }),
    note('Now the build.'),
    tool('Bash', { command: 'npm run build', description: 'Build the client' }),
    reply,
  ];

  const items = groupWorkRuns(messages);

  assert.equal(items.length, 3);
  assert.equal(items[0], messages[0]);
  assert.ok(isWorkRunItem(items[1]));
  assert.equal(items[1].messages.length, 5);
  assert.equal(items[1].stepCount, 3);
  assert.equal(items[2], reply);
});

test('the newest short note after the last tool call stays readable', () => {
  const latestNote = note('Checking the logs now.');
  const items = groupWorkRuns([
    user('go'),
    tool('Read', { file_path: '/a' }),
    tool('Grep', { pattern: 'x' }),
    latestNote,
  ]);

  assert.equal(items[items.length - 1], latestNote);
  assert.equal(runs(items).length, 1);
});

test('a lone tool call is left as its own row', () => {
  const only = tool('Read', { file_path: '/a' });
  const items = groupWorkRuns([user('go'), only, note('done')]);

  assert.equal(runs(items).length, 0);
  assert.ok(items.includes(only));
});

test('a question to the user is never folded and splits the work around it', () => {
  const question = tool('AskUserQuestion', { questions: [] }, null);
  const items = groupWorkRuns([
    user('go'),
    tool('Read', { file_path: '/a' }),
    tool('Read', { file_path: '/b' }),
    question,
    tool('Bash', { command: 'ls' }),
    tool('Bash', { command: 'pwd' }),
  ]);

  assert.equal(runs(items).length, 2);
  assert.ok(items.includes(question));
});

test('a long mid-turn note stays visible', () => {
  const analysis = note('y'.repeat(301));
  const items = groupWorkRuns([
    user('go'),
    tool('Read', { file_path: '/a' }),
    tool('Read', { file_path: '/b' }),
    analysis,
    tool('Bash', { command: 'ls' }),
    tool('Bash', { command: 'pwd' }),
  ]);

  assert.ok(items.includes(analysis));
  assert.equal(runs(items).length, 2);
});

test('the card counts failures and lists changed files without the failed edits', () => {
  const items = groupWorkRuns([
    user('go'),
    tool('Edit', { file_path: 'C:\\repo\\a.ts', old_string: '1', new_string: '2' }),
    tool('Edit', { file_path: 'C:\\repo\\a.ts', old_string: '2', new_string: '3' }),
    tool('Write', { file_path: '/repo/new.ts', content: 'hello' }),
    tool('Edit', { file_path: '/repo/broken.ts', old_string: 'q', new_string: 'r' }, { content: 'no match', isError: true }),
    tool('Bash', { command: 'false' }, { content: 'exit 1', isError: true }),
  ]);

  const [run] = runs(items);
  assert.equal(run.stepCount, 5);
  assert.equal(run.errorCount, 2);
  assert.deepEqual(run.files.map((file) => [file.path, file.edits.length]), [
    ['C:\\repo\\a.ts', 2],
    ['/repo/new.ts', 1],
  ]);
  assert.deepEqual(run.files[1].edits[0], { oldContent: '', newContent: 'hello' });
});

test('the live status names the newest step, preferring a command description', () => {
  const [run] = runs(groupWorkRuns([
    user('go'),
    tool('Read', { file_path: '/repo/src/a.ts' }),
    tool('Bash', { command: 'npm run build', description: 'Build the client' }, null),
  ]));

  assert.deepEqual(run.latestStep, { kind: 'tool', toolName: 'Bash', detail: 'Build the client' });
});

test('hidden reasoning does not count as a visible row', () => {
  const items = groupWorkRuns([user('go'), thinking(), tool('Read', { file_path: '/a' })], false);
  assert.equal(runs(items).length, 0);
});

test('an unchanged run keeps its identity across grouping passes', () => {
  const messages = [user('go'), tool('Read', { file_path: '/a' }), tool('Bash', { command: 'ls' })];
  const [first] = runs(groupWorkRuns(messages));
  const [second] = runs(groupWorkRuns([...messages]));
  assert.equal(first, second);

  const [grown] = runs(groupWorkRuns([...messages, tool('Bash', { command: 'pwd' })]));
  assert.notEqual(grown, first);
  assert.equal(grown.stepCount, 3);
});
