import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * Sub-pixel slack. Widths come from getBoundingClientRect, so a strip that fits
 * exactly can still measure a hundredth of a pixel wider than its container.
 */
const FIT_EPSILON = 0.5;

type TabFitInput = {
  /** Natural width of every tab with its icon and label, in row order. */
  widths: number[];
  /** Natural width of every tab in its compact form (no icon beside the label), in row order. */
  compactWidths: number[];
  /** Natural width of the overflow trigger, which takes the place of the dropped tabs. */
  triggerWidth: number;
  /** Width the row has to lay the tabs out in. */
  available: number;
  /** The tab that must stay in the row, or -1 when none is active. */
  activeIndex: number;
};

type TabFit = {
  /** The tabs the row keeps, in row order. */
  visible: number[];
  /** Whether the kept tabs only fit in their compact form. */
  compact: boolean;
};

/**
 * The kept tabs share the row in equal slots, so a set of tabs fits when its
 * widest tab fits in one slot, not when the widths merely add up.
 */
const fitsInEqualSlots = (indexes: number[], widths: number[], space: number) =>
  indexes.length * Math.max(0, ...indexes.map((index) => widths[index])) <= space + FIT_EPSILON;

/**
 * The tabs the row keeps and the form they are drawn in. The full form is
 * preferred, then the compact one; only when even that does not fit do tabs
 * drop into the overflow menu. Tabs are kept from the left and the active one
 * is always kept, so the strip still shows which section is on screen even
 * when that section's tab would have fallen past the fold.
 */
export function fitTabsInRow({ widths, compactWidths, triggerWidth, available, activeIndex }: TabFitInput): TabFit {
  const everyIndex = widths.map((_, index) => index);
  if (fitsInEqualSlots(everyIndex, widths, available)) {
    return { visible: everyIndex, compact: false };
  }
  if (fitsInEqualSlots(everyIndex, compactWidths, available)) {
    return { visible: everyIndex, compact: true };
  }

  const space = available - triggerWidth;
  const hasActive = activeIndex >= 0 && activeIndex < widths.length;
  let kept: number[] = hasActive ? [activeIndex] : [];
  for (const index of everyIndex) {
    if (index === activeIndex) {
      continue;
    }
    // Stop at the first tab that does not fit rather than skipping over it to a
    // narrower one: the strip reads as a left-to-right list, and a hole in the
    // middle of that list looks like a bug.
    const candidate = [...kept, index];
    if (!fitsInEqualSlots(candidate, compactWidths, space)) {
      break;
    }
    kept = candidate;
  }

  kept.sort((first, second) => first - second);
  return { visible: kept, compact: !fitsInEqualSlots(kept, widths, space) };
}

const isSameFit = (first: TabFit, second: TabFit) =>
  first.compact === second.compact
  && first.visible.length === second.visible.length
  && first.visible.every((index, position) => index === second.visible[position]);

/**
 * Splits a tab strip into the tabs that fit and the tabs that do not, and says
 * whether the ones that fit need their compact form.
 *
 * `rowRef` goes on the element the tabs must fit into and `mirrorRef` on an
 * off-layout copy of the strip: once a tab has been dropped it is no longer in
 * the row to be measured, so the natural widths have to come from somewhere
 * that always renders all of them. The mirror holds every tab in its full
 * form, then the overflow trigger, then every tab in its compact form.
 */
export function useTabOverflow(tabCount: number, activeIndex: number) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  // The tabs the row has room for and the form they fit in. It can only be
  // measured from a laid-out DOM, so it starts as "all of them, full" and the
  // first layout pass corrects it.
  const [fit, setFit] = useState<TabFit>(() => ({
    visible: Array.from({ length: tabCount }, (_, index) => index),
    compact: false,
  }));

  const measure = useCallback(() => {
    const row = rowRef.current;
    const mirror = mirrorRef.current;
    if (!row || !mirror) {
      return;
    }

    const measured = Array.from(mirror.children, (child) => child.getBoundingClientRect().width);
    // The mirror holds every tab twice plus the overflow trigger. A different
    // count means it is mid-render and the widths cannot be trusted yet.
    if (measured.length !== tabCount * 2 + 1) {
      return;
    }

    const available = row.getBoundingClientRect().width;
    // The header renders a desktop and a mobile copy of the strip and hides one
    // of them with `display: none`. The hidden copy measures zero — keep its
    // last layout rather than collapsing every tab into the dropdown.
    if (available <= 0) {
      return;
    }

    const next = fitTabsInRow({
      widths: measured.slice(0, tabCount),
      triggerWidth: measured[tabCount],
      compactWidths: measured.slice(tabCount + 1),
      available,
      activeIndex,
    });
    setFit((current) => (isSameFit(current, next) ? current : next));
  }, [tabCount, activeIndex]);

  useLayoutEffect(() => {
    measure();

    const row = rowRef.current;
    const mirror = mirrorRef.current;
    if (!row || !mirror || typeof ResizeObserver === 'undefined') {
      return;
    }

    // The row changes width while the sidebar is dragged; the mirror changes
    // when the tabs themselves do — a language switch, or the running-session
    // badge appearing next to the Activity icon.
    const observer = new ResizeObserver(() => measure());
    observer.observe(row);
    observer.observe(mirror);
    return () => observer.disconnect();
  }, [measure]);

  return { rowRef, mirrorRef, visibleIndexes: fit.visible, compact: fit.compact };
}
