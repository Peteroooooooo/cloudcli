import assert from 'node:assert/strict';

import { test } from 'vitest';

import { fitTabsInRow } from '@/modules/sidebar/hooks/useTabOverflow';

/**
 * The tabs split the row into equal widths, and the sidebar can be dragged down
 * to 220px. These cover which tabs the strip keeps at a given width and whether
 * they need their compact form; the measuring itself needs a laid-out DOM and
 * is not exercised here.
 */

// Projects, Conversations, Running, roughly at their rendered widths, with an
// icon beside the label and without one.
const WIDTHS = [76, 109, 28];
const COMPACT_WIDTHS = [60, 83, 28];
const TRIGGER_WIDTH = 30;

const fit = (available: number, activeIndex: number) =>
  fitTabsInRow({ widths: WIDTHS, compactWidths: COMPACT_WIDTHS, triggerWidth: TRIGGER_WIDTH, available, activeIndex });

test('keeps every tab in full when the widest one fits in a third of the row', () => {
  assert.deepEqual(fit(330, 0), { visible: [0, 1, 2], compact: false });
});

test('keeps a strip that fits to the pixel, and one that misses by a rounding error', () => {
  assert.deepEqual(fit(327, 0), { visible: [0, 1, 2], compact: false });
  assert.deepEqual(fit(326.8, 0), { visible: [0, 1, 2], compact: false });
});

test('drops the icons beside the labels when a third of the row is too narrow for both', () => {
  // The widths add up to 213, well under 259, but Conversations needs 109 and
  // a third of the row is only 86.
  assert.deepEqual(fit(259, 0), { visible: [0, 1, 2], compact: true });
});

test('drops the tabs past the fold, leaving room for the overflow trigger', () => {
  // 160 - 30 for the trigger leaves 130: Projects fits in full, but two compact
  // tabs at 83 each would not.
  assert.deepEqual(fit(160, 0), { visible: [0], compact: false });
});

test('keeps the active tab in the row even when it is past the fold', () => {
  // Running is pinned and Projects shares what is left with it: two slots of
  // 65, enough for the compact Projects (60) but not the full one (76).
  assert.deepEqual(fit(160, 2), { visible: [0, 2], compact: true });
});

test('shows the active tab alone when nothing else fits beside it', () => {
  assert.deepEqual(fit(120, 1), { visible: [1], compact: true });
});

test('drops from the left onwards rather than picking out whichever tabs fit', () => {
  const visible = fitTabsInRow({
    widths: [124, 30, 30],
    compactWidths: [124, 30, 30],
    triggerWidth: TRIGGER_WIDTH,
    available: 120,
    activeIndex: -1,
  });

  // The narrow tabs would each fit on their own, but a strip with a hole in it
  // reads as broken — the row stops at the first tab that does not fit.
  assert.deepEqual(visible, { visible: [], compact: false });
});
