import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import type { SessionActivity } from '@/shared/types';

/**
 * Opening a session that is already working used to slide the activity tab
 * in, and the session left behind slid its tab out, so every switch onto a
 * running session moved the bottom of the screen twice. The tab is keyed by
 * session: it now mounts in place and only slides in when work starts while
 * the session is on screen.
 */

const running = (startedAt = Date.now()): SessionActivity => ({
  statusText: 'Thinking',
  canInterrupt: true,
  startedAt,
});

test('a session opened while it is working shows the tab in place, with its elapsed time', () => {
  const { container } = render(<ActivityIndicator activity={running(Date.now() - 65_000)} onAbort={() => {}} />);

  assert.equal(container.querySelector('.chat-activity-enter'), null);
  assert.equal(container.querySelector('.chat-activity-exit'), null);
  assert.match(container.textContent ?? '', /1m 5s/);
});

test('work that starts while the session is on screen slides the tab in', () => {
  const view = render(<ActivityIndicator activity={null} />);
  assert.equal(view.container.firstChild, null);

  view.rerender(<ActivityIndicator activity={running()} />);
  assert.ok(view.container.querySelector('.chat-activity-enter'));
});

test('a new status within the same run does not replay the slide', () => {
  const startedAt = Date.now();
  const view = render(<ActivityIndicator activity={running(startedAt)} />);
  view.rerender(<ActivityIndicator activity={{ ...running(startedAt), statusText: 'Reading files' }} />);

  assert.equal(view.container.querySelector('.chat-activity-enter'), null);
  assert.match(view.container.textContent ?? '', /Reading files/);
});

test('switching to another session remounts the tab instead of animating it out', () => {
  const view = render(<ActivityIndicator key="session-a" activity={running()} />);
  view.rerender(<ActivityIndicator key="session-b" activity={null} />);

  assert.equal(view.container.firstChild, null, 'the idle session has no tab, not a fading one');
});
