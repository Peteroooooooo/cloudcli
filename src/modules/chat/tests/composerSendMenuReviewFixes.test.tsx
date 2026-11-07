import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerSendMenu from '@/modules/chat/composer/ComposerSendMenu';

/**
 * Review fix on `ComposerSendMenu`: the destructive row (Stop / Send anyway)
 * lost `text-destructive-foreground` and renders `text-destructive` instead,
 * in both states.
 */

type SendMenuState = 'responding' | 'background';
type SendMenuChoice = 'queue' | 'steer' | 'stop' | 'send';

const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  return screen.getByRole('menu');
};

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
const classesOf = (row: HTMLElement): string[] => (row.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

afterEach(() => {
  vi.restoreAllMocks();
});

for (const [state, destructiveLabel] of [
  ['responding', 'Stop'],
  ['background', 'Send anyway'],
] as const) {
  test(`the destructive row while ${state} uses text-destructive, not text-destructive-foreground`, () => {
    render(<ComposerSendMenu state={state as SendMenuState} hasInput onSelect={vi.fn<(choice: SendMenuChoice) => void>()} />);
    const menu = open();
    const row = item(menu, destructiveLabel);

    const classes = classesOf(row);
    assert.ok(classes.includes('text-destructive'), `${destructiveLabel} has text-destructive`);
    assert.ok(!classes.includes('text-destructive-foreground'), `${destructiveLabel} does not have text-destructive-foreground`);
  });
}
