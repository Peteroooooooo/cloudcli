import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { listProvidersWithSessions } from '@/shared/utils';
import type { LLMProvider, ServerEvent, SessionProviderCounts, SessionProviderFilter } from '@/shared/types';

type SessionProviderCountsPayload = {
  data?: { counts?: SessionProviderCounts };
};

type UseProviderFilterOptionsArgs = {
  providerFilter: SessionProviderFilter;
  onProviderFilterChange: (filter: SessionProviderFilter) => void;
  subscribe?: (listener: (event: ServerEvent) => void) => () => void;
};

/** How long a burst of events (a bulk delete, a run's first messages) is gathered into one refetch. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Used by Sidebar to decide which agents the agent filter offers: those with
 * at least one session, archived ones included, in display order.
 *
 * The counts are fetched on mount, and again at the moments an agent can gain
 * its first session or lose its last: a session of an agent not counted yet
 * appears, sessions are removed outside the app, the websocket reconnects, or
 * the caller reports a delete through `refreshCountsSoon`. A failed refetch
 * keeps the last counts.
 *
 * While the counts are unknown the chosen agent stays on offer, so the filter
 * can always be switched back to All. Once they are known, a choice whose agent
 * has no sessions left, or a sidebar with only one agent, falls back to All.
 */
export function useProviderFilterOptions({
  providerFilter,
  onProviderFilterChange,
  subscribe,
}: UseProviderFilterOptionsArgs) {
  // The last counts the server reported. Null until it first answers, which
  // reads as "not known yet" rather than "no sessions".
  const [counts, setCounts] = useState<SessionProviderCounts | null>(null);
  // Read by the websocket listener, which is registered once.
  const countsRef = useRef(counts);
  // Generation of the newest request, so an older answer never lands last.
  const requestIdRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    countsRef.current = counts;
  }, [counts]);

  const refreshCounts = useCallback(async () => {
    const requestId = (requestIdRef.current += 1);
    try {
      const response = await api.sessionProviderCounts();
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const payload = (await response.json()) as SessionProviderCountsPayload;
      if (requestId !== requestIdRef.current) {
        return;
      }
      setCounts(payload.data?.counts ?? {});
    } catch (error) {
      console.error('[Sidebar] Failed to load session counts per agent:', error);
    }
  }, []);

  const refreshCountsSoon = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshCounts();
    }, REFRESH_DEBOUNCE_MS);
  }, [refreshCounts]);

  useEffect(() => {
    void refreshCounts();
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [refreshCounts]);

  useEffect(() => {
    if (!subscribe) {
      return undefined;
    }

    return subscribe((event) => {
      if (event.kind === 'sessions_removed' || event.kind === 'websocket_reconnected') {
        refreshCountsSoon();
        return;
      }

      if (event.kind !== 'session_upserted' || typeof event.provider !== 'string') {
        return;
      }
      // Only a first session changes which agents are offered; more sessions
      // of a counted agent do not.
      const known = countsRef.current;
      if (known && !known[event.provider as LLMProvider]) {
        refreshCountsSoon();
      }
    });
  }, [refreshCountsSoon, subscribe]);

  const providersWithSessions = useMemo(
    () => (counts ? listProvidersWithSessions(counts) : null),
    [counts],
  );

  const providerFilterOptions = useMemo<LLMProvider[]>(
    () => providersWithSessions ?? (providerFilter === 'all' ? [] : [providerFilter]),
    [providerFilter, providersWithSessions],
  );

  useEffect(() => {
    if (!providersWithSessions || providerFilter === 'all') {
      return;
    }
    if (providersWithSessions.length < 2 || !providersWithSessions.includes(providerFilter)) {
      onProviderFilterChange('all');
    }
  }, [onProviderFilterChange, providerFilter, providersWithSessions]);

  return { providerFilterOptions, refreshCountsSoon };
}
