import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('a replacement echo survives a kept turn that repeats its text', () => {
  // The exact shape a rewind that branches produces: the turn that survived
  // the cut is re-stamped to the moment of the copy, one second before the
  // replacement was typed, and happens to say the same thing the user just
  // corrected their message to.
  const userRow = (id: string, content: string, timestamp: string) => ({
    id,
    kind: 'text',
    role: 'user',
    provider: 'codex',
    sessionId: 's1',
    content,
    timestamp,
  }) as NormalizedMessage;

  const kept = [userRow('kept', 'continue', '2026-01-01T00:00:21.000Z')];
  const echo = {
    ...userRow('local_1', 'continue', '2026-01-01T00:00:20.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: kept.length,
  } as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes(kept, [echo]), [echo]);

  // Once the provider has written the replacement, it is a row the cut did not
  // keep, so it retires the echo.
  const persisted = [...kept, userRow('persisted', 'continue', '2026-01-01T00:00:25.000Z')];
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]), []);
});

const pageRow = (id: string, role: 'user' | 'assistant', content: string, timestamp: string) => ({
  id,
  kind: 'text',
  role,
  provider: 'claude',
  sessionId: 's1',
  content,
  timestamp,
}) as NormalizedMessage;

test('an edit echo is retired after the history is re-read as a page shorter than the cut', () => {
  // The cut kept 200 rows; the latest page holds 61, the last surviving row
  // among them, then the persisted replacement.
  const echo = {
    ...pageRow('local_1', 'user', 'edited text', '2026-11-07T11:03:29.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: 200,
    replacesAfterRowId: 'kept-199',
  } as NormalizedMessage;
  const page = [
    pageRow('kept-199', 'assistant', 'before the cut', '2026-11-07T11:02:37.000Z'),
    pageRow('persisted', 'user', 'edited text', '2026-11-07T11:04:01.000Z'),
    ...Array.from({ length: 59 }, (_, index) => pageRow(`reply-${index}`, 'assistant', `x${index}`, '2026-11-07T11:05:00.000Z')),
  ];

  assert.deepEqual(removeOptimisticUserEchoes(page, [echo]), []);
});

test('an echo whose persisted copy is older than the page is dropped once the transcript has moved on', () => {
  const echo = {
    ...pageRow('local_1', 'user', 'edited text', '2026-11-07T11:03:29.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: 200,
    replacesAfterRowId: 'kept-199',
  } as NormalizedMessage;
  const laterPage = Array.from({ length: 61 }, (_, index) => (
    pageRow(`reply-${index}`, 'assistant', `x${index}`, '2026-11-07T11:13:36.000Z')
  ));

  assert.deepEqual(removeOptimisticUserEchoes(laterPage, [echo]), []);
});

test('an unmatched echo stays while the transcript has nothing from well after it', () => {
  const echo = pageRow('local_1', 'user', 'just sent', '2026-11-07T11:03:29.000Z');
  const page = [pageRow('reply', 'assistant', 'earlier', '2026-11-07T11:02:00.000Z')];

  assert.deepEqual(removeOptimisticUserEchoes(page, [echo]), [echo]);
});
