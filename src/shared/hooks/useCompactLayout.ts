import { useSyncExternalStore } from 'react';

/** Tailwind's `md` breakpoint — the width below which the app uses its phone layouts. */
const COMPACT_QUERY = '(max-width: 767px)';

let query: MediaQueryList | null = null;
const readQuery = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return (query ??= window.matchMedia(COMPACT_QUERY));
};

function subscribe(onChange: () => void): () => void {
  const media = readQuery();
  if (!media) return () => undefined;
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const getSnapshot = (): boolean => readQuery()?.matches ?? false;

/**
 * True while the viewport is phone-sized.
 *
 * Used by the sidebar, whose rows each have a tappable card and a dense desktop
 * button and render only the one on screen, and by chat's transcript, which
 * folds each turn's tool calls into one work card on a phone.
 *
 * One `MediaQueryList` is shared by every caller, so the number of rows does
 * not change the number of listeners, and `useSyncExternalStore` re-renders
 * them only when the breakpoint is actually crossed.
 */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
