import { api } from '@/shared/api';
import { SESSION_OPEN_PAGE_SIZE } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';

/**
 * Requests a session needs before it can be drawn, started when the pointer
 * reaches its row in the sidebar instead of after the click.
 *
 * Over a relay every request costs a round trip of 100–200 ms, and opening a
 * session asked for its history, model and token usage only once it was
 * selected, so the transcript, the model button and the token count each
 * changed on screen as their answer came in. Hovering a row and clicking it
 * usually takes longer than that round trip, so by the click the answers are
 * here and the session is drawn complete.
 *
 * Every response is used at most once and only while it is fresh; a session
 * opened later asks the server again.
 */

/** One response asked for ahead of time: in flight, then its parsed body. */
type PrefetchedResponse = {
  /** Resolves with the parsed JSON of a successful response, or null. */
  promise: Promise<unknown>;
  /** Set once `promise` has resolved, so a caller can use `body` without waiting. */
  settled: boolean;
  body: unknown;
};

type SessionOpenPrefetch = {
  startedAt: number;
  provider: LLMProvider;
  history: PrefetchedResponse | null;
  selection: PrefetchedResponse | null;
  tokenUsage: PrefetchedResponse | null;
};

const PREFETCH_TTL_MS = 10_000;

const prefetches = new Map<string, SessionOpenPrefetch>();

/**
 * Whether chat already holds a session's history. A session opened before is
 * drawn from memory and only asks for what is new, so its opening page is not
 * asked for again.
 */
let isHistoryHeld: (sessionId: string) => boolean = () => false;

/**
 * Lets the prefetch skip the history of sessions already in memory. Returns
 * the function that removes the check again.
 *
 * Used by chat's session store, which owns the loaded histories.
 */
export function registerHeldHistoryCheck(check: (sessionId: string) => boolean): () => void {
  isHistoryHeld = check;
  return () => {
    if (isHistoryHeld === check) isHistoryHeld = () => false;
  };
}

function track(request: Promise<Response>): PrefetchedResponse {
  const entry: PrefetchedResponse = { promise: Promise.resolve(null), settled: false, body: null };
  entry.promise = request
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((body: unknown) => {
      entry.body = body;
      entry.settled = true;
      return body;
    });
  return entry;
}

function dropExpired(now: number) {
  for (const [sessionId, prefetch] of prefetches) {
    if (now - prefetch.startedAt > PREFETCH_TTL_MS) prefetches.delete(sessionId);
  }
}

/**
 * Starts the requests that opening this session will make. Calling it again
 * while an earlier prefetch is still fresh does nothing.
 *
 * Used by the sidebar's session rows on hover, focus and press.
 */
export function prefetchSessionOpen(sessionId: string, provider: LLMProvider): void {
  const now = Date.now();
  dropExpired(now);
  if (!sessionId || prefetches.has(sessionId)) return;

  prefetches.set(sessionId, {
    startedAt: now,
    provider,
    history: isHistoryHeld(sessionId)
      ? null
      : track(api.providers.sessionMessages(sessionId, { limit: SESSION_OPEN_PAGE_SIZE, offset: 0 })),
    selection: track(api.providers.sessionActiveModel(provider, sessionId)),
    tokenUsage: track(api.providers.sessionTokenUsage(sessionId)),
  });
}

/** Which of the three prefetched responses a caller wants. */
export type SessionOpenPrefetchPart = 'history' | 'selection' | 'tokenUsage';

/**
 * Hands over a prefetched response and forgets it, so it is used once.
 * `settledOnly` leaves a response that is still in flight for a caller that
 * can wait for it. A model selection is only handed to a caller asking for the
 * provider it was fetched for.
 *
 * Used by chat when it opens a session.
 */
export function takePrefetchedSessionResponse(
  sessionId: string,
  part: SessionOpenPrefetchPart,
  options: { settledOnly?: boolean; provider?: LLMProvider } = {},
): PrefetchedResponse | null {
  const prefetch = prefetches.get(sessionId);
  if (!prefetch) return null;
  if (Date.now() - prefetch.startedAt > PREFETCH_TTL_MS) {
    prefetches.delete(sessionId);
    return null;
  }
  if (part === 'selection' && options.provider && options.provider !== prefetch.provider) return null;

  const response = prefetch[part];
  if (!response || (options.settledOnly && !response.settled)) return null;

  prefetch[part] = null;
  if (!prefetch.history && !prefetch.selection && !prefetch.tokenUsage) prefetches.delete(sessionId);
  return response;
}
