import { useCallback, useEffect, useRef } from 'react';

import { prefetchSessionOpen } from '@/shared/sessionOpenPrefetch';
import type { LLMProvider } from '@/shared/types';

/**
 * How long the pointer has to stay on a row before its session is fetched.
 * Sweeping the pointer across the list on the way somewhere else stays
 * shorter than this, so it does not ask the server for every row it crosses.
 */
const HOVER_INTENT_MS = 70;

/**
 * Returns a function giving a sidebar session row the event handlers that
 * start loading its session before it is clicked: after a short hover, and at
 * once on press or keyboard focus. There is one pointer, so the rows of a
 * list share one hover timer.
 *
 * `disabled` is for rows a click will not open: the session already open, or
 * any row while the list is in selection mode.
 */
export function useSessionRowPrefetch() {
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHover = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelHover, [cancelHover]);

  return useCallback((
    sessionId: string | null | undefined,
    provider: LLMProvider | null | undefined,
    disabled: boolean,
  ) => {
    const prefetchNow = () => {
      cancelHover();
      if (sessionId && provider && !disabled) prefetchSessionOpen(sessionId, provider);
    };
    return {
      onPointerEnter: () => {
        cancelHover();
        if (sessionId && provider && !disabled) {
          hoverTimerRef.current = setTimeout(prefetchNow, HOVER_INTENT_MS);
        }
      },
      onPointerLeave: cancelHover,
      onPointerDown: prefetchNow,
      onFocus: prefetchNow,
    };
  }, [cancelHover]);
}
