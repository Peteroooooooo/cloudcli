import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerSendMenu from '@/modules/chat/composer/ComposerSendMenu';

/**
 * While something runs, the send button stops being a one-tap Stop and opens
 * a menu with the choices that make sense in that state. The destructive one
 * is last and red, as in the background-send dialog, so a tap on the first
 * row can never stop anything.
 *
 * The props are the narrowest guess at the component's interface: which
 * state it is drawn for, whether the composer holds input, and one callback
 * that names the choice — the same shape as the dialog's `onResolve`.
 */

type SendMenuState = 'responding' | 'background';
type SendMenuChoice = 'queue' | 'steer' | 'stop' | 'send';

const renderMenu = (
  state: SendMenuState,
  hasInput: boolean,
  canAbortSession = true,
) => {
  const onSelect = vi.fn<(choice: SendMenuChoice) => void>();
  const view = render(
    <ComposerSendMenu
      state={state}
      hasInput={hasInput}
      canAbortSession={canAbortSession}
      onSelect={onSelect}
    />,
  );
  return { ...view, onSelect };
};

const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  return screen.getByRole('menu');
};

// Menu rows may be drawn as `menuitem` or `menuitemradio`; their name leads
// with the label, followed by the description.
const items = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
const labelOf = (item: HTMLElement) => {
  const text = item.textContent ?? '';
  for (const label of ['Queue', 'Stop', 'Send anyway']) {
    if (text.startsWith(label)) return label;
  }
  return text;
};
const item = (menu: HTMLElement, label: string) => {
  const found = items(menu).find((row) => labelOf(row) === label);
  assert.ok(found, `the menu has a "${label}" row`);
  return found;
};
const isDisabled = (row: HTMLElement) =>
  (row as HTMLButtonElement).disabled || row.getAttribute('aria-disabled') === 'true';
const looksDestructive = (row: HTMLElement) =>
  [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))]
    .some((element) => /destructive|red-/.test(element.getAttribute('class') ?? ''));

// The separator is the menu's only aria-hidden element outside a row (icons
// inside rows are aria-hidden too and do not count).
const separatorsBetween = (menu: HTMLElement, before: HTMLElement, after: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('[aria-hidden="true"], [aria-hidden=""]'))
    .filter((element) => !element.closest('[role^="menuitem"]') && element.tagName.toLowerCase() !== 'svg')
    .filter((element) =>
      Boolean(before.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(after.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING));

afterEach(() => {
  vi.restoreAllMocks();
});

test('the trigger is the send-options button, and the menu is closed until it is pressed', () => {
  renderMenu('responding', true);

  assert.ok(screen.getByRole('button', { name: 'Send options' }));
  assert.ok(screen.queryByRole('menu') === null, 'the menu is closed');
});

test('while a turn is written the menu offers Queue and then Stop, Stop last and red', () => {
  renderMenu('responding', true);
  const menu = open();

  assert.deepEqual(items(menu).map(labelOf), ['Queue', 'Stop']);
  const stop = item(menu, 'Stop');
  assert.ok(looksDestructive(stop), 'Stop is drawn as the destructive choice');
  assert.ok(!looksDestructive(item(menu, 'Queue')), 'Queue is not');
  assert.equal(separatorsBetween(menu, item(menu, 'Queue'), stop).length, 1, 'a separator sets Stop apart');
  assert.match(item(menu, 'Queue').textContent ?? '', /Send when this turn ends/);
  assert.match(stop.textContent ?? '', /End the response being written/);
});

test('while only background work runs the menu offers Queue and then Send anyway, Send anyway last and red', () => {
  renderMenu('background', true);
  const menu = open();

  assert.deepEqual(items(menu).map(labelOf), ['Queue', 'Send anyway']);
  const sendAnyway = item(menu, 'Send anyway');
  assert.ok(looksDestructive(sendAnyway), 'Send anyway is drawn as the destructive choice');
  assert.ok(!looksDestructive(item(menu, 'Queue')));
  assert.equal(separatorsBetween(menu, item(menu, 'Queue'), sendAnyway).length, 1, 'a separator sets Send anyway apart');
  assert.match(item(menu, 'Queue').textContent ?? '', /Send when the background work ends/);
  assert.match(sendAnyway.textContent ?? '', /Send now; this stops the background work/);
});

test('without input, Queue is disabled while a turn is written, and Stop stays enabled', () => {
  const { onSelect } = renderMenu('responding', false);
  const menu = open();

  assert.ok(isDisabled(item(menu, 'Queue')));
  assert.ok(!isDisabled(item(menu, 'Stop')), 'stopping needs no input');

  fireEvent.click(item(menu, 'Queue'));
  assert.equal(onSelect.mock.calls.length, 0, 'a disabled row does nothing');

  fireEvent.click(item(menu, 'Stop'));
  assert.deepEqual(onSelect.mock.calls.map((args) => args.map((arg) => (typeof arg === 'string' ? arg : typeof arg))), [['stop']], 'Stop works with an empty composer');
});

// CodeRabbit comment 4478109479: `handleAbortSession` already no-ops when the
// session cannot be interrupted, so an enabled Stop row here looked
// actionable but did nothing — the same non-interruptible state the
// activity indicator's own Stop button already hides for.
test('while the session cannot be interrupted, Stop is disabled and a click does nothing', () => {
  const { onSelect } = renderMenu('responding', true, false);
  const menu = open();

  const stop = item(menu, 'Stop');
  assert.ok(isDisabled(stop), 'Stop is disabled when the session cannot be interrupted');

  fireEvent.click(stop);
  assert.equal(onSelect.mock.calls.length, 0, 'a disabled Stop row does nothing');
});

// The background-state rule is about input, not interruptibility: "Send
// anyway" does not stop anything, so a session that cannot be interrupted
// must not disable it.
test('while only background work runs, a non-interruptible session leaves Send anyway enabled', () => {
  renderMenu('background', true, false);
  const menu = open();

  assert.ok(!isDisabled(item(menu, 'Send anyway')), 'Send anyway does not depend on interruptibility');
});

test('without input, Queue and Send anyway are both disabled while background work runs', () => {
  const { onSelect } = renderMenu('background', false);
  const menu = open();

  assert.ok(isDisabled(item(menu, 'Queue')));
  assert.ok(isDisabled(item(menu, 'Send anyway')));

  fireEvent.click(item(menu, 'Send anyway'));
  assert.equal(onSelect.mock.calls.length, 0);
});

test('with input, every row is enabled', () => {
  renderMenu('background', true);
  const menu = open();

  for (const row of items(menu)) {
    assert.ok(!isDisabled(row), `${labelOf(row)} is enabled`);
  }
});

const choicesFor: Array<[SendMenuState, string, SendMenuChoice]> = [
  ['responding', 'Queue', 'queue'],
  ['responding', 'Stop', 'stop'],
  ['background', 'Queue', 'queue'],
  ['background', 'Send anyway', 'send'],
];

for (const [state, label, choice] of choicesFor) {
  test(`${label} while ${state} calls back once with "${choice}"`, () => {
    const { onSelect, unmount } = renderMenu(state, true);
    const menu = open();

    fireEvent.click(item(menu, label));

    // Mapped to strings first: an event passed along must not be deep-printed.
    assert.deepEqual(onSelect.mock.calls.map((args) => args.map((arg) => (typeof arg === 'string' ? arg : typeof arg))), [[choice]]);
    unmount();
  });
}

// The hint names the key that actually performs the row's action in that
// state: Enter queues or stops while a turn runs, but during background
// work Enter only opens a confirm dialog, so Queue and Send anyway get none.
const hintOf = (row: HTMLElement) => row.querySelector('kbd')?.textContent ?? null;
const hintClass = (row: HTMLElement) => row.querySelector('kbd')?.className ?? '';

test('while a turn is written, Queue hints Enter and Stop hints esc', () => {
  renderMenu('responding', true);
  const menu = open();

  assert.equal(hintOf(item(menu, 'Queue')), '↵');
  assert.equal(hintOf(item(menu, 'Stop')), 'esc');
});

test('with "send with Ctrl+Enter" on, Queue hints the Ctrl/⌘ form instead', () => {
  const onSelect = vi.fn<(choice: SendMenuChoice) => void>();
  render(
    <ComposerSendMenu state="responding" hasInput sendByCtrlEnter onSelect={onSelect} />,
  );
  const menu = open();

  assert.match(hintOf(item(menu, 'Queue')) ?? '', /^(Ctrl\+↵|⌘↵)$/);
});

test('while only background work runs, Queue and Send anyway carry no key hint', () => {
  renderMenu('background', true);
  const menu = open();

  assert.equal(hintOf(item(menu, 'Queue')), null);
  assert.equal(hintOf(item(menu, 'Send anyway')), null);
});

test('every hint, wherever it appears, gates on hover and a fine pointer', () => {
  renderMenu('responding', true);
  const menu = open();

  for (const label of ['Queue', 'Stop']) {
    const hint = hintClass(item(menu, label));
    assert.ok(hint.includes('[@media(hover:hover)_and_(pointer:fine)]:inline-block'), `${label}'s hint carries the gate, got: ${hint}`);
  }
});
