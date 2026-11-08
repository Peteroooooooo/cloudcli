import { api } from '@/shared/api';
import { isAuthTokenExpired } from '@/shared/authToken';
import { SESSION_OPEN_PAGE_SIZE } from '@/shared/constants';
import type { LLMProvider } from '@/shared/types';
import { IS_PLATFORM } from '@/shared/utils';

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
  /** Null when the session's provider was not known yet, so its model selection was not asked for. */
  provider: LLMProvider | null;
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
 * while an earlier prefetch is still fresh does nothing. Without a provider
 * the model selection, the one provider-specific request, is left out.
 *
 * Used by the sidebar's session rows on hover, focus and press, and at startup
 * by `prefetchSessionFromAddress`.
 */
export function prefetchSessionOpen(sessionId: string, provider: LLMProvider | null): void {
  const now = Date.now();
  dropExpired(now);
  if (!sessionId || prefetches.has(sessionId)) return;

  prefetches.set(sessionId, {
    startedAt: now,
    provider,
    history: isHistoryHeld(sessionId)
      ? null
      : track(api.providers.sessionMessages(sessionId, { limit: SESSION_OPEN_PAGE_SIZE, offset: 0 })),
    selection: provider ? track(api.providers.sessionActiveModel(provider, sessionId)) : null,
    tokenUsage: track(api.providers.sessionTokenUsage(sessionId)),
  });
}

/** A session page's address, after any router basename: `/session/<id>`. */
const SESSION_ADDRESS = /\/session\/([A-Za-z0-9_-]+)\/?$/;

/**
 * Starts the opening requests of the session the page was loaded on.
 *
 * Opening the app on a session's address asked for its history only after
 * sign-in had been checked and the workspace and chat had mounted: four round
 * trips, about half a second over the relay, before the largest download of
 * the page began. Started here it downloads during them. Nothing is asked for
 * without a stored token that is still valid; the server checks it on these
 * requests like on any other.
 *
 * Used once by main.tsx, before the app renders.
 */
export function prefetchSessionFromAddress(pathname: string): void {
  const match = SESSION_ADDRESS.exec(pathname);
  if (!match) return;
  if (!IS_PLATFORM) {
    const token = localStorage.getItem('auth-token');
    if (!token || isAuthTokenExpired(token)) return;
  }
  prefetchSessionOpen(match[1], null);
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
