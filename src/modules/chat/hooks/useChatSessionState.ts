import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { api } from '@/shared/api';
import { SESSION_OPEN_PAGE_SIZE } from '@/shared/constants';
import { takePrefetchedSessionResponse } from '@/shared/sessionOpenPrefetch';
import type { MarkSessionIdle, SessionActivityMap,Project,ProjectSession,LLMProvider,NormalizedMessage,ChatMessage,DiffCalculator } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { LiveSeqCursor } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import { createMessageHistoryRefreshCoordinator } from '@/modules/chat/utils/messageHistoryRefreshCoordinator';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { findSearchTargetIndex, resolveSearchWindowSize } from '@/modules/chat/utils/searchTargetLocator';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type { SearchTarget } from '@/modules/chat/utils/searchTargetLocator';

/**
 * Messages in the render window when a session opens. Counted in messages,
 * but shown as rows with a turn's tool calls folded into one card, so a
 * tool-heavy session needs several hundred to fill the screen; with 100 the
 * window often fell short of one screen and the transcript was redrawn as
 * more was mounted. Rows away from the viewport stay placeholders, so the
 * larger window costs little.
 */
const INITIAL_VISIBLE_MESSAGES = 400;
/**
 * Older history starts loading while the reader is still this many screens
 * below the top, so scrolling up never runs into an edge and waits.
 */
const OLDER_HISTORY_PREFETCH_SCREENS = 1.5;
/**
 * Rows per older-history request. Work cards fold a turn's tool rows into one
 * line, so the 20-row page the latest window uses added a card's height at a
 * time and scrolling up stopped for a request every few hundred pixels.
 */
const OLDER_HISTORY_PAGE_SIZE = 60;

/** Messages kept below a search hit so it lands mid-viewport rather than at the edge. */
const SEARCH_TARGET_CONTEXT_MESSAGES = 20;

/**
 * Widening the window can commit thousands of rows on an old hit, each running
 * the markdown pipeline, so the scroll waits about three seconds for that render
 * — the same budget the previous DOM scan used.
 */
const SEARCH_SCROLL_RETRIES = 20;
const SEARCH_SCROLL_RETRY_DELAY_MS = 150;

/**
 * Finds the rendered row for a resolved search target.
 *
 * Only an exact timestamp match counts while retries remain: the widened window
 * may not be committed yet, and accepting the nearest row then would scroll to
 * an arbitrary message and flash the highlight on it — the silent wrong answer
 * this rewrite exists to remove. `allowNearest` is used on the final attempt
 * because a hit on the second or later call of a collapsed tool group has no row
 * of its own; groupConsecutiveTools stamps the group with the run's FIRST
 * timestamp, so the group row is the nearest, not an exact, match.
 */
function findRenderedMessageElement(
  container: HTMLElement,
  timestamp: unknown,
  allowNearest: boolean,
): HTMLElement | null {
  const targetTimestamp = String(timestamp);
  const targetTime = new Date(targetTimestamp).getTime();
  const candidates = container.querySelectorAll<HTMLElement>('[data-message-timestamp]');

  let nearest: HTMLElement | null = null;
  let nearestDistance = Infinity;

  for (const candidate of candidates) {
    const candidateTimestamp = candidate.getAttribute('data-message-timestamp');
    if (!candidateTimestamp) {
      continue;
    }
    if (candidateTimestamp === targetTimestamp) {
      return candidate;
    }

    if (!allowNearest) {
      continue;
    }

    const candidateTime = new Date(candidateTimestamp).getTime();
    if (!Number.isFinite(candidateTime) || !Number.isFinite(targetTime)) {
      continue;
    }

    const distance = Math.abs(candidateTime - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }

  return nearest;
}
/** Stable empty list so `chatMessages` keeps its identity while no session is selected. */
const NO_MESSAGES: NormalizedMessage[] = [];

/**
 * The visible-window size that shows the row at `index` of `total` rows, with
 * a page of context above it; the current size when the row already shows.
 * The window is a tail slice, so a row is visible when at most `count` rows
 * follow it, itself included.
 */
export function visibleCountToReveal(total: number, index: number, current: number): number {
  const needed = total - index;
  return needed <= current ? current : needed + SESSION_MESSAGES_PAGE_SIZE;
}

type UseChatSessionStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Live-stream position per session; sent with `chat.subscribe`. */
  lastSeqRef: MutableRefObject<Map<string, LiveSeqCursor>>;
  sessionStore: SessionStore;
};

type ScrollRestoreState = {
  height: number;
  top: number;
  anchor: HTMLElement | null;
  anchorOffset: number | null;
};

function captureScrollRestoreState(container: HTMLDivElement): ScrollRestoreState {
  const containerBounds = container.getBoundingClientRect();
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('.chat-message'))
    .find((element) => element.getBoundingClientRect().bottom >= containerBounds.top)
    ?? null;

  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorOffset: anchor
      ? anchor.getBoundingClientRect().top - containerBounds.top
      : null,
  };
}

/** Distance from the end, in pixels, within which the reader counts as following the newest message. */
const NEAR_BOTTOM_PX = 50;

/** Where the reader left a transcript, so opening it again lands in the same place. */
type TranscriptViewMemory = {
  /** The reader was following the newest message; coming back follows whatever is newest by then. */
  atBottom: boolean;
  /** Timestamp of the top row on screen, the row the view is restored against. */
  anchorTimestamp: string | null;
  /** That row's top edge relative to the pane's top edge. */
  anchorOffset: number;
  /** Rows in the transcript and in the render window when this was taken. */
  messageCount: number;
  visibleMessageCount: number;
};

/** The pane's row wrappers in document order: one per transcript item, mounted or not. */
const listTranscriptRows = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(':scope > div > [data-message-timestamp]'));

function captureViewMemory(
  container: HTMLDivElement,
  messageCount: number,
  visibleMessageCount: number,
): TranscriptViewMemory {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
  const memory: TranscriptViewMemory = {
    atBottom,
    anchorTimestamp: null,
    anchorOffset: 0,
    messageCount,
    visibleMessageCount,
  };
  if (atBottom) return memory;

  const paneTop = container.getBoundingClientRect().top;
  const rows = listTranscriptRows(container);
  // Rows are in visual order, so the first one still reaching into the pane is found by bisection.
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom > paneTop) {
      found = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (found >= 0) {
    memory.anchorTimestamp = rows[found].getAttribute('data-message-timestamp');
    memory.anchorOffset = rows[found].getBoundingClientRect().top - paneTop;
  }
  return memory;
}

/** Render window that still reaches the remembered row once newer rows have arrived below it. */
const restoredVisibleCount = (memory: TranscriptViewMemory | undefined, messageCount: number): number => {
  if (!memory || memory.atBottom) return INITIAL_VISIBLE_MESSAGES;
  const grownBy = Math.max(0, messageCount - memory.messageCount);
  return Math.max(INITIAL_VISIBLE_MESSAGES, memory.visibleMessageCount + grownBy);
};

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: msg.taskNotificationStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
    // Survives the truncation that follows an edit, which clears every other
    // live row.
    replacesAnchorId: msg.replacesAnchorId,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // The sidebar-search hit this transcript still owes the user a scroll to.
  // State rather than a ref because resolving it widens the render window,
  // and it is cleared once the row is on screen or the retries run out.
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const searchScrollActiveRef = useRef(false);
  /**
   * The pending step of the search-jump retry chain, so a session change can
   * cancel a jump that belongs to the transcript the user just left.
   */
  const searchScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * `isUserScrolledUp` readable from a timer callback. Both deferred
   * scroll-to-bottom calls are armed while the user is at the bottom and fire
   * tens to hundreds of milliseconds later; without re-reading this at fire
   * time, a scroll-up inside that window is silently undone.
   */
  const isUserScrolledUpRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> ProjectWorkspaceRoute -> WorkspaceMain -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setSearchTarget(null);
    searchScrollActiveRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore. Background-only work shows in the
  // indicator but is not a response in flight: the composer can send.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null && !sessionActivity.background;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  const viewMemoryRef = useRef(new Map<string, TranscriptViewMemory>());
  const viewMemoryFrameRef = useRef(0);
  // The rows of a newly selected session are committed with the previous
  // session's scroll offset still on the pane, and the scroll event that
  // clamping fires must not be remembered as where the reader left it.
  // Raising the flag during render closes that gap before any event runs.
  const viewedSessionIdRef = useRef(activeSessionId);
  if (viewedSessionIdRef.current !== activeSessionId) {
    viewedSessionIdRef.current = activeSessionId;
    pendingInitialScrollRef.current = true;
  }

  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | void>>(
    async () => true,
  );
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === sessionId
      ),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage !== undefined) {
        setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
      }
    }
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current) => (
    refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve()
  ), []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
    // A page the sidebar prefetched on hover lets this very render show the
    // rows, instead of a loading frame followed by the transcript.
    if (activeSessionForStore) sessionStore.adoptPrefetchedHistory(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : NO_MESSAGES;

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    return all;
  }, [storeMessages, pendingUserMessage]);

  // Token usage last shown for each session, so switching back shows it at
  // once instead of "0" until the request returns.
  const tokenUsageBySessionRef = useRef(new Map<string, Record<string, unknown> | null>());
  // The session whose usage came from the sidebar's prefetch, which makes
  // the request on opening it unnecessary.
  const prefetchedTokenUsageSessionRef = useRef<string | null>(null);

  // Sized for the newly selected session during the render that selects it.
  // A layout effect committed the previous session's window first, which
  // drew the transcript twice before the first paint.
  const windowSessionKey = `${selectedProject?.projectId ?? ''}:${selectedSession?.id ?? ''}`;
  // Which session the render window and token count were last sized for.
  const [sizedForSessionKey, setSizedForSessionKey] = useState(windowSessionKey);
  if (sizedForSessionKey !== windowSessionKey) {
    setSizedForSessionKey(windowSessionKey);
    const sessionId = selectedSession?.id;
    const memory = sessionId ? viewMemoryRef.current.get(sessionId) : undefined;
    setVisibleMessageCount(restoredVisibleCount(memory, chatMessages.length));

    if (sessionId) {
      const prefetched = takePrefetchedSessionResponse(sessionId, 'tokenUsage', { settledOnly: true });
      if (prefetched?.body) {
        tokenUsageBySessionRef.current.set(
          sessionId,
          (prefetched.body as { data?: Record<string, unknown> }).data ?? null,
        );
        prefetchedTokenUsageSessionRef.current = sessionId;
      }
      const slotUsage = sessionStore.getSessionSlot(sessionId)?.tokenUsage;
      setTokenBudget(
        tokenUsageBySessionRef.current.get(sessionId)
          ?? (slotUsage === undefined ? null : (slotUsage as Record<string, unknown> | null)),
      );
    }
  }

  const messageCountRef = useRef(chatMessages.length);
  messageCountRef.current = chatMessages.length;
  const visibleMessageCountRef = useRef(visibleMessageCount);
  visibleMessageCountRef.current = visibleMessageCount;

  // Taken from scroll events, at most once a frame. Nothing is recorded while
  // a session is still being brought to its opening position.
  const rememberView = useCallback(() => {
    if (viewMemoryFrameRef.current) return;
    viewMemoryFrameRef.current = requestAnimationFrame(() => {
      viewMemoryFrameRef.current = 0;
      const container = scrollContainerRef.current;
      const sessionId = activeSessionIdRef.current;
      if (!container || !sessionId || pendingInitialScrollRef.current || messageCountRef.current === 0) return;
      viewMemoryRef.current.set(
        sessionId,
        captureViewMemory(container, messageCountRef.current, visibleMessageCountRef.current),
      );
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(viewMemoryFrameRef.current), []);

  /* ---------------------------------------------------------------- */
  /*  addMessage                                                       */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  // Mirrors the state into a ref so the two deferred scroll-to-bottom timers
  // can re-read it at fire time. An effect rather than assignments next to each
  // `setIsUserScrolledUp` call, because the setter is also returned from this
  // hook and driven from the composer.
  useEffect(() => {
    isUserScrolledUpRef.current = isUserScrolledUp;
  }, [isUserScrolledUp]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!isActive) return false;
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
      const scrollRestoreState = captureScrollRestoreState(container);

      try {
        const result = await sessionStore.fetchMore(selectedSession.id, {
          limit: OLDER_HISTORY_PAGE_SIZE,
          canRequest: () => (
            isActiveRef.current
            && activeSessionIdRef.current === selectedSession.id
          ),
        });
        const { slot, prependedCount } = result;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }

        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
        }
        if (prependedCount === 0) {
          return false;
        }

        pendingScrollRestoreRef.current = scrollRestoreState;
        setVisibleMessageCount((prev) => prev + prependedCount);
        return true;
      } finally {
        isLoadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    },
    [hasMoreMessages, isActive, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  // Keeps history above the viewport topped up: rows already in memory but
  // outside the render window are mounted first, and only then is the next
  // page requested. Each step restores the scroll position against the row
  // the reader is looking at, so nothing on screen moves.
  const revealOlderHistory = useCallback(async (container: HTMLDivElement) => {
    if (container.scrollTop > container.clientHeight * OLDER_HISTORY_PREFETCH_SCREENS) return false;
    // Until the first jump to the bottom has settled, scrollTop is still 0 and
    // says nothing about where the reader is.
    if (pendingInitialScrollRef.current) return false;
    if (isLoadingMoreRef.current || pendingScrollRestoreRef.current || searchScrollActiveRef.current) return false;

    if (chatMessages.length > visibleMessageCount) {
      pendingScrollRestoreRef.current = captureScrollRestoreState(container);
      setVisibleMessageCount((prev) => prev + OLDER_HISTORY_PAGE_SIZE);
      return true;
    }
    if (allMessagesLoadedRef.current) return false;
    return loadOlderMessages(container);
  }, [chatMessages.length, loadOlderMessages, visibleMessageCount]);

  const handleScroll = useCallback(async () => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    isUserScrolledUpRef.current = !nearBottom;
    setIsUserScrolledUp(!nearBottom);
    scrollPositionRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };
    rememberView();

    await revealOlderHistory(container);
  }, [isActive, isNearBottom, rememberView, revealOlderHistory]);

  // Scroll events alone are not enough: a loaded page whose turns fold into a
  // few cards may not fill the screen, and a pane that cannot scroll fires no
  // scroll event, so the check also runs whenever the transcript changes.
  useEffect(() => {
    if (!isActive || isLoadingSessionMessages || chatMessages.length === 0) return undefined;
    const frame = requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (container) void revealOlderHistory(container);
    });
    return () => cancelAnimationFrame(frame);
  }, [chatMessages.length, isActive, isLoadingSessionMessages, revealOlderHistory, visibleMessageCount]);

  const wasChatActiveRef = useRef(isActive);
  useLayoutEffect(() => {
    const becameActive = isActive && !wasChatActiveRef.current;
    wasChatActiveRef.current = isActive;
    if (!isActive || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    if (pendingScrollRestoreRef.current) {
      const { height, top, anchor, anchorOffset } = pendingScrollRestoreRef.current;
      if (anchor?.isConnected && anchorOffset !== null) {
        const nextAnchorOffset = (
          anchor.getBoundingClientRect().top
          - container.getBoundingClientRect().top
        );
        container.scrollTop += nextAnchorOffset - anchorOffset;
      } else {
        container.scrollTop = top + Math.max(container.scrollHeight - height, 0);
      }
      pendingScrollRestoreRef.current = null;
      return;
    }

    if (becameActive) {
      container.scrollTop = isUserScrolledUp
        ? scrollPositionRef.current.top
        : container.scrollHeight;
    }
  }, [chatMessages.length, isActive, isUserScrolledUp, visibleMessageCount]);

  // Reset scroll/pagination state on session change. A layout effect so the
  // restored render window is committed before the first frame of the new
  // session is painted.
  useLayoutEffect(() => {
    // A search jump belongs to the transcript it was requested against. Left
    // armed across a session change it did two visible things to the session
    // the user actually opened: the initial scroll bailed (it declines while a
    // jump is pending) so the transcript opened part-way up, and then, once the
    // retries ran out and started accepting the nearest row by timestamp, it
    // scrolled to an unrelated message and flashed the search highlight on it.
    //
    // Clearing it here is safe for the jump itself: the effect that reads
    // `__searchTargetSnippet` off the newly selected session runs after this
    // one, so a session opened *from* a search result re-arms immediately.
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);

    pendingInitialScrollRef.current = true;
    // A session read part-way up comes back with the rows the reader was on
    // still inside the render window (sized during render, above); one left
    // at the end opens on the newest.
    const memory = selectedSession?.id ? viewMemoryRef.current.get(selectedSession.id) : undefined;
    pendingScrollRestoreRef.current = null;
    const scrolledUp = Boolean(memory && !memory.atBottom);
    isUserScrolledUpRef.current = scrolledUp;
    setIsUserScrolledUp(scrolledUp);
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Opening position: the row the reader was on when they left this session,
  // or the newest message.
  //
  // Lazy content (markdown, code highlighting, images) keeps changing heights
  // for a while after the first commit, so the position is re-applied every
  // animation frame until scrollHeight holds for 3 frames, capped at ~1s (60
  // frames). The first application runs before paint, so a session switch
  // never shows a frame at the previous session's offset. Cancels cleanly on
  // session change via the pending flag.
  useLayoutEffect(() => {
    if (!isActive) return;
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    // An empty list right after opening is usually the page still on its way;
    // giving up here left the reload parked thousands of pixels above the end.
    if (chatMessages.length === 0) return;
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    const memory = activeSessionIdRef.current ? viewMemoryRef.current.get(activeSessionIdRef.current) : undefined;
    const anchorTimestamp = memory && !memory.atBottom ? memory.anchorTimestamp : null;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const place = () => {
      const anchor = anchorTimestamp
        ? listTranscriptRows(container).find((row) => row.getAttribute('data-message-timestamp') === anchorTimestamp)
        : undefined;
      if (anchor && memory) {
        const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += offset - memory.anchorOffset;
        return;
      }
      container.scrollTop = container.scrollHeight;
    };

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      place();
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
        // The remembered row can be gone (an edit truncated the transcript);
        // the reader is then at the end and should follow it.
        const following = isNearBottom();
        isUserScrolledUpRef.current = !following;
        setIsUserScrolledUp(!following);
        void revealOlderHistory(container);
      }
    };
    tick();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isActive, isLoadingSessionMessages, isNearBottom, revealOlderHistory, visibleMessageCount]);

  // Session replay/subscription remains active regardless of which main tab is
  // visible. Only persisted-history HTTP traffic is visibility-gated below.
  // This is the one place a subscribe is sent: `ws` changes when the socket
  // reconnects, so a reconnect re-subscribes here too.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    const cursor = lastSeqRef.current.get(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: cursor?.seq ?? 0,
        runId: cursor?.runId ?? undefined,
      }],
    });
  }, [lastSeqRef, selectedProject, selectedSession, sendMessage, statusCheckSentAtRef, ws]);

  // Main session loading effect — store-based.
  //
  // The dependency list is deliberately narrower than the values the body
  // reads. `selectedSession` is tracked by id only, so a websocket-driven list
  // refresh that hands back a new object for the same session does not reload
  // it; `currentSessionId` is read as the previously-loaded session (the body
  // itself is what advances it), so listing it would re-enter the effect right
  // after every load. Both are always current when the effect does run,
  // because React recreates the closure on each render.
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it — but
      // only for a response in flight: a session whose turn has ended with
      // background work still running has a canonical id, so a missing
      // selection there is a real navigation away.
      const activity = currentSessionId ? processingSessionsRef.current?.get(currentSessionId) : undefined;
      if (activity && !activity.background) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead.
    if (isCurrentHydratedSession) {
      if (sessionStore.isStale(selectedSessionId)) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingState();
    }

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    const restoredCount = restoredVisibleCount(
      viewMemoryRef.current.get(selectedSessionId),
      messageCountRef.current,
    );

    // A session opened before keeps its rows in the store. Showing them at
    // once and asking only for what is new keeps a switch back from
    // replacing everything with the newest 20 rows, re-measuring the whole
    // pane and losing the reader's place.
    if (existingSlot?.fetchedAt && existingSlot.status !== 'loading' && sessionStore.getMessages(selectedSessionId).length > 0) {
      messagesOffsetRef.current = existingSlot.offset;
      setHasMoreMessages(existingSlot.hasMore);
      setTotalMessages(existingSlot.total);
      setVisibleMessageCount(restoredCount);
      allMessagesLoadedRef.current = !existingSlot.hasMore;
      setAllMessagesLoaded(!existingSlot.hasMore);
      setIsLoadingAllMessages(false);
      setIsLoadingSessionMessages(false);
      void requestLatestMessages(selectedSessionId);
      return;
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(restoredCount);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_OPEN_PAGE_SIZE,
      offset: 0,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === selectedSessionId
      ),
    }).then(slot => {
      // The reader may have opened another session meanwhile; its own load owns these.
      if (activeSessionIdRef.current !== selectedSessionId) return;
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      if (activeSessionIdRef.current === selectedSessionId) setIsLoadingSessionMessages(false);
    });
  }, [
    isActive,
    resetStreamingState,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
  ]);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      return;
    }

    void refreshCoordinatorRef.current?.flushPending(activeSessionId);
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          const shouldStickToBottom = isActiveRef.current && isNearBottom();
          await requestLatestMessages(selectedSession.id);

          if (shouldStickToBottom) {
            setTimeout(() => {
              if (!isUserScrolledUpRef.current) {
                scrollToBottom();
              }
            }, 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    requestLatestMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!isActive || !searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
              canRequest: () => (
                isActiveRef.current
                && activeSessionIdRef.current === selectedSession.id
              ),
            });
            if (slot) {
              // Fetch the whole transcript so an old hit can be found, but do
              // not render all of it — the window below is widened to exactly
              // what the resolved target needs.
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.offset;
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
            } else if (!isActiveRef.current) {
              setSearchTarget(target);
              return;
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      // Resolve the target against the loaded transcript rather than the DOM.
      // The store is the freshest source here: the `fetchFromServer` above has
      // landed but `chatMessages` is from the render that scheduled this effect.
      const messagesForSearch = activeSessionIdRef.current
        ? normalizedToChatMessages(sessionStore.getMessages(activeSessionIdRef.current))
        : chatMessages;
      const targetIndex = findSearchTargetIndex(messagesForSearch, target);
      if (targetIndex < 0) {
        // The target is not in the transcript at all. Scrolling somewhere
        // plausible would claim a hit that does not exist.
        searchScrollActiveRef.current = false;
        return;
      }

      // Widen the window so the target is rendered. `visibleMessages` is a tail
      // slice, so covering index N means rendering everything after it.
      const requiredVisibleCount = resolveSearchWindowSize(
        messagesForSearch.length,
        targetIndex,
        SEARCH_TARGET_CONTEXT_MESSAGES,
      );
      setVisibleMessageCount((previous) => Math.max(previous, requiredVisibleCount));

      const targetTimestamp = messagesForSearch[targetIndex].timestamp;

      const scrollToRenderedTarget = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        // The target is inside the window by construction, so this only waits
        // for React to commit the widened list. A target collapsed inside a
        // tool group resolves to that group, which carries the same timestamp.
        const targetElement = findRenderedMessageElement(
          container,
          targetTimestamp,
          retriesLeft === 0,
        );

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement.classList.remove('search-highlight-flash'), 4000);
          searchScrollTimerRef.current = null;
          searchScrollActiveRef.current = false;
          return;
        }

        if (retriesLeft > 0) {
          searchScrollTimerRef.current = setTimeout(
            () => scrollToRenderedTarget(retriesLeft - 1),
            SEARCH_SCROLL_RETRY_DELAY_MS,
          );
          return;
        }

        searchScrollTimerRef.current = null;
        searchScrollActiveRef.current = false;
      };

      searchScrollTimerRef.current = setTimeout(
        () => scrollToRenderedTarget(SEARCH_SCROLL_RETRIES),
        150,
      );
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isActive, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId) {
      setTokenBudget(null);
      return;
    }
    if (prefetchedTokenUsageSessionRef.current === sessionId) {
      prefetchedTokenUsageSessionRef.current = null;
      return;
    }
    let cancelled = false;
    const fetchInitialTokenUsage = async () => {
      try {
        const prefetched = takePrefetchedSessionResponse(sessionId, 'tokenUsage');
        let usage: Record<string, unknown> | null = null;
        if (prefetched) {
          const body = (await prefetched.promise) as { data?: Record<string, unknown> } | null;
          usage = body?.data ?? null;
        } else {
          // The provider module resolves storage and provider details from the session id.
          const response = await api.providers.sessionTokenUsage(sessionId);
          usage = response.ok ? ((await response.json()).data ?? null) : null;
        }
        // A reply for a session the reader has already left belongs to that session only.
        if (!cancelled) setTokenBudget(usage);
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id]);

  // Kept per session for the next time it is opened.
  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (sessionId) tokenUsageBySessionRef.current.set(sessionId, tokenBudget);
  // Recorded when the usage changes; the session id is read, not tracked.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenBudget]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  // Rows exist above what is mounted, in memory or on the server. A transcript
  // that does not fill the pane yet is then drawn against the composer, so the
  // rows that arrive above it do not push what is on screen downwards.
  const hasOlderHistory = hasMoreMessages || chatMessages.length > visibleMessages.length;

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
  });

  useEffect(() => {
    if (!isActive) return;
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current) return;

    if (!isUserScrolledUp) {
      setTimeout(() => {
        if (!isUserScrolledUpRef.current) {
          scrollToBottom();
        }
      }, 50);
    }
  }, [chatMessages.length, isActive, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // A reader following the end stays at the end while rows finish rendering:
  // lazy rows mounting, markdown and code laying out, and a running turn's
  // card growing all change the height without changing the message count the
  // effect above listens to. Without this the end slid down out of view, and
  // the next scroll event then read the reader as having scrolled up.
  //
  // Checked after every render because the pane can mount after this hook.
  const followObserverRef = useRef<{ observer: ResizeObserver; target: Element } | null>(null);
  useEffect(() => {
    // The transcript column, always the pane's last child.
    const target = isActive ? scrollContainerRef.current?.lastElementChild ?? null : null;
    const current = followObserverRef.current;
    if (current?.target === target) return;
    current?.observer.disconnect();
    followObserverRef.current = null;
    if (!target || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      if (isUserScrolledUpRef.current || pendingScrollRestoreRef.current || searchScrollActiveRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
    observer.observe(target);
    followObserverRef.current = { observer, target };
  });
  useEffect(() => () => followObserverRef.current?.observer.disconnect(), []);

  const loadAllMessages = useCallback(async () => {
    if (!isActive) return;
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);

    const container = scrollContainerRef.current;
    const scrollRestoreState = container ? captureScrollRestoreState(container) : null;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
        canRequest: () => (
          isActiveRef.current
          && activeSessionIdRef.current === requestSessionId
        ),
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (scrollRestoreState) {
          pendingScrollRestoreRef.current = scrollRestoreState;
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);
      } else {
        allMessagesLoadedRef.current = false;
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [isActive, selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  /**
   * Fetches the whole transcript into the store and returns it, without
   * touching the render window.
   *
   * Export needs every message; the screen does not. Keeping those separate is
   * why exporting a long conversation no longer silently produces a file
   * containing only its last page.
   */
  const loadFullTranscript = useCallback(async (): Promise<ChatMessage[]> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return [];
    }

    await sessionStore.fetchFromServer(sessionId, {
      limit: null,
      offset: 0,
      canRequest: () => activeSessionIdRef.current === sessionId,
    });

    return normalizedToChatMessages(sessionStore.getMessages(sessionId));
  }, [sessionStore]);

  // Brings one row into view even when it is outside the visible window or
  // sits in a lazy row that has not mounted: widen the window to include it,
  // then scroll to the row's wrapper, which is in the DOM as soon as the row
  // is inside the window, mounted or not.
  const revealMessage = useCallback((message: ChatMessage) => {
    // Leaving the end on purpose: the rows mounted on the way must not pull
    // the pane back down before the smooth scroll reports a position.
    isUserScrolledUpRef.current = true;
    const index = chatMessages.indexOf(message);
    if (index >= 0) {
      setVisibleMessageCount((prev) => visibleCountToReveal(chatMessages.length, index, prev));
    }

    const attempt = (remaining: number) => {
      const container = scrollContainerRef.current;
      // The widened window commits after this frame, so the row can be absent
      // on the first attempts; only the last one may settle for the nearest
      // row (a hit collapsed inside a tool group carries the group's
      // timestamp), or the first attempt scrolls to an unrelated row and the
      // retries never run.
      const element = container ? findRenderedMessageElement(container, message.timestamp, remaining === 0) : null;
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (remaining > 0) {
        requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    requestAnimationFrame(() => attempt(10));
  }, [chatMessages]);

  return {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    hasOlderHistory,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  };
}
