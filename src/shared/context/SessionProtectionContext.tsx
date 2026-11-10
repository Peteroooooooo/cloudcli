import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, GetSessionActivity, IsSessionProcessing, MarkSessionBackground, MarkSessionIdle, MarkSessionProcessing, ServerEvent, SessionActivity, SessionActivityMap, SessionOpenElsewhere, SessionOpenElsewhereMap, SyncProcessingSessions } from '@/shared/types';
import { api } from '@/shared/api';
import { i18n } from '@/modules/i18n';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  openIn?: unknown;
  canInterrupt?: unknown;
  background?: unknown;
  tasks?: unknown;
};

type OpenElsewhereApiItem = {
  sessionId?: unknown;
  openIn?: unknown;
  busy?: unknown;
};

type OpenInCloudCliApiItem = {
  sessionId?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
    openElsewhere?: OpenElsewhereApiItem[];
    openInCloudCli?: OpenInCloudCliApiItem[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  markSessionBackground: MarkSessionBackground;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
  getSessionActivity: GetSessionActivity;
  /** Closes a session in CloudCLI (the open list's ×); resolves once the lists here reflect it. */
  closeSessionInCloudCli: (sessionId: string) => Promise<void>;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const BackgroundSessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const NO_SESSIONS_OPEN_ELSEWHERE: SessionOpenElsewhereMap = new Map();
// Defaults to empty rather than throwing: it only adds a marker, so a row or
// composer rendered outside the provider simply shows none.
const OpenElsewhereContext = createContext<SessionOpenElsewhereMap>(NO_SESSIONS_OPEN_ELSEWHERE);
const NO_SESSIONS_OPEN_IN_CLOUDCLI: ReadonlySet<string> = new Set();
// Empty by default for the same reason as OpenElsewhereContext.
const OpenInCloudCliContext = createContext<ReadonlySet<string>>(NO_SESSIONS_OPEN_IN_CLOUDCLI);

/**
 * Frames after which the open lists may have changed: a session opened or
 * closed in CloudCLI, sessions deleted (their marks go with them), or a
 * reconnect that may have missed either.
 */
const OPEN_LIST_REFRESH_EVENTS = new Set(['open_sessions_changed', 'sessions_removed', 'websocket_reconnected']);

/**
 * The set of session ids whose activity passes `include`, with a stable
 * identity while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useSessionIdSet(
  processingSessions: SessionActivityMap,
  include: (activity: SessionActivity) => boolean,
): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions]
    .filter(([, activity]) => include(activity))
    .map(([sessionId]) => sessionId)
    .sort()
    .join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const isAnyActivity = () => true;
const isBackgroundOnly = (activity: SessionActivity) => Boolean(activity.background);

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The poll's task list, kept only when every entry has the shape the indicator reads. */
const parseBackgroundTasks = (value: unknown): BackgroundTaskSummary[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tasks: BackgroundTaskSummary[] = [];
  for (const item of value) {
    const task = item as Partial<Record<keyof BackgroundTaskSummary, unknown>> | null;
    if (
      !task
      || typeof task.taskId !== 'string'
      || typeof task.toolUseId !== 'string'
      || typeof task.taskType !== 'string'
      || typeof task.description !== 'string'
      || typeof task.startedAt !== 'number'
    ) {
      // One entry the server wrote in a shape this client does not read
      // should not hide the rest of the session's work.
      continue;
    }
    tasks.push({
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      taskType: task.taskType,
      description: task.description,
      ...(typeof task.workflowName === 'string' ? { workflowName: task.workflowName } : {}),
      startedAt: task.startedAt,
      ...(task.nested === true ? { nested: true } : {}),
    });
  }
  return tasks;
};

const OPEN_IN_VALUES = new Set<unknown>(['vscode', 'cli', 'other']);

/** The poll's open-elsewhere list, keyed by session id; entries in a shape this client does not read are dropped. */
const parseOpenElsewhere = (value: unknown): Map<string, SessionOpenElsewhere> => {
  const sessions = new Map<string, SessionOpenElsewhere>();
  if (!Array.isArray(value)) {
    return sessions;
  }

  for (const item of value as (OpenElsewhereApiItem | null)[]) {
    if (!item || typeof item.sessionId !== 'string' || !item.sessionId || !OPEN_IN_VALUES.has(item.openIn)) {
      continue;
    }
    sessions.set(item.sessionId, { openIn: item.openIn as SessionOpenElsewhere['openIn'], busy: item.busy === true });
  }
  return sessions;
};

/** The poll's open-in-CloudCLI list as a set of session ids; malformed entries are dropped. */
const parseOpenInCloudCli = (value: unknown): Set<string> => {
  const sessionIds = new Set<string>();
  if (!Array.isArray(value)) {
    return sessionIds;
  }

  for (const item of value as (OpenInCloudCliApiItem | null)[]) {
    if (item && typeof item.sessionId === 'string' && item.sessionId) {
      sessionIds.add(item.sessionId);
    }
  }
  return sessionIds;
};

/** A string that is equal for two maps exactly when their entries are. */
const openElsewhereKey = (sessions: SessionOpenElsewhereMap): string =>
  [...sessions]
    .map(([sessionId, { openIn, busy }]) => `${sessionId}:${openIn}:${busy ? 1 : 0}`)
    .sort()
    .join('\u0000');

type SessionProtectionProviderProps = {
  children: ReactNode;
  /** The websocket frame feed; when given, the open lists refresh as soon as the server says they changed. */
  subscribe?: (listener: (event: ServerEvent) => void) => () => void;
};

/** Mounted by the project-workspace route; tracks which sessions are busy — producing a response or running background tasks — or open, so chat, sidebar and project-workspace agree on session activity. */
export function SessionProtectionProvider({ children, subscribe }: SessionProtectionProviderProps) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    markSessionBackground,
    syncProcessingSessions,
    isSessionProcessing,
    getSessionActivity,
  } = useSessionProtection();

  // Replaced only when an entry changes, so the sidebar rows reading it do not
  // re-render on every 5 s poll.
  const [openElsewhere, setOpenElsewhere] = useState<{ key: string; sessions: SessionOpenElsewhereMap }>(
    { key: '', sessions: NO_SESSIONS_OPEN_ELSEWHERE },
  );
  // The sessions the user has open in CloudCLI itself, from the same poll.
  // Kept apart from openElsewhere because only those warn that a send here
  // branches the transcript another process holds. Replaced only on change.
  const [openInCloudCli, setOpenInCloudCli] = useState<{ key: string; sessionIds: ReadonlySet<string> }>(
    { key: '', sessionIds: NO_SESSIONS_OPEN_IN_CLOUDCLI },
  );
  // Numbers each poll so an answer that arrives after a newer one is dropped:
  // a poll sent just before a close must not put the closed row back.
  const pollSequenceRef = useRef({ issued: 0, applied: 0 });

  const refreshRunningSessions = useCallback(async () => {
    const sequence = ++pollSequenceRef.current.issued;
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      if (sequence < pollSequenceRef.current.applied) {
        return;
      }
      pollSequenceRef.current.applied = sequence;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: OPEN_IN_VALUES.has(session.openIn)
                ? i18n.t(`sidebar:openElsewhere.running.${session.openIn as string}`)
                : typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
              background: session.background === true,
              elsewhere: OPEN_IN_VALUES.has(session.openIn),
              tasks: parseBackgroundTasks(session.tasks),
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );

      const openSessions = parseOpenElsewhere(payload.data?.openElsewhere);
      const key = openElsewhereKey(openSessions);
      setOpenElsewhere((previous) => (previous.key === key ? previous : { key, sessions: openSessions }));

      const cloudCliSessionIds = parseOpenInCloudCli(payload.data?.openInCloudCli);
      const cloudCliKey = [...cloudCliSessionIds].sort().join('\u0000');
      setOpenInCloudCli((previous) => (
        previous.key === cloudCliKey ? previous : { key: cloudCliKey, sessionIds: cloudCliSessionIds }
      ));
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  useEffect(() => {
    if (!subscribe) {
      return undefined;
    }
    return subscribe((event) => {
      if (typeof event.kind === 'string' && OPEN_LIST_REFRESH_EVENTS.has(event.kind)) {
        void refreshRunningSessions();
      }
    });
  }, [refreshRunningSessions, subscribe]);

  const closeSessionInCloudCli = useCallback(async (sessionId: string) => {
    try {
      const response = await api.closeSessionInCloudCli(sessionId);
      if (!response.ok) {
        console.error('[SessionProtection] Failed to close the session in CloudCLI:', response.status);
      }
    } catch (error) {
      console.error('[SessionProtection] Failed to close the session in CloudCLI:', error);
    }
    // Re-read rather than drop the row locally: the server decides whether it
    // is still open, and a close that failed simply leaves it listed.
    await refreshRunningSessions();
  }, [refreshRunningSessions]);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      markSessionBackground,
      syncProcessingSessions,
      isSessionProcessing,
      getSessionActivity,
      closeSessionInCloudCli,
    }),
    [
      closeSessionInCloudCli,
      getSessionActivity,
      isSessionProcessing,
      markSessionBackground,
      markSessionIdle,
      markSessionProcessing,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useSessionIdSet(processingSessions, isAnyActivity);
  const backgroundSessionIds = useSessionIdSet(processingSessions, isBackgroundOnly);

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <BusySessionIdsContext.Provider value={busySessionIds}>
        <BackgroundSessionIdsContext.Provider value={backgroundSessionIds}>
          <SessionProtectionStateContext.Provider value={processingSessions}>
            <OpenElsewhereContext.Provider value={openElsewhere.sessions}>
              <OpenInCloudCliContext.Provider value={openInCloudCli.sessionIds}>
                {children}
              </OpenInCloudCliContext.Provider>
            </OpenElsewhereContext.Provider>
          </SessionProtectionStateContext.Provider>
        </BackgroundSessionIdsContext.Provider>
      </BusySessionIdsContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/**
 * Membership-only view of the busy sessions, background work included. Prefer
 * this over useProcessingSessions wherever the activity details are not
 * rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

/**
 * The busy sessions that are only running background tasks — no response in
 * flight. A subset of useBusySessionIdSet, with the same stable identity, for
 * the sidebar to draw those rows differently.
 */
export function useBackgroundSessionIdSet(): ReadonlySet<string> {
  const backgroundSessionIds = useContext(BackgroundSessionIdsContext);
  if (!backgroundSessionIds) {
    throw new Error('useBackgroundSessionIdSet must be used within SessionProtectionProvider');
  }
  return backgroundSessionIds;
}

/**
 * Where one session is open in another Claude process (a VS Code panel, a
 * terminal), or null when it is not. Stable across polls that change nothing.
 */
export function useSessionOpenElsewhere(sessionId: string | null | undefined): SessionOpenElsewhere | null {
  const sessions = useContext(OpenElsewhereContext);
  return (sessionId && sessions.get(sessionId)) || null;
}

/** Every session open in another Claude process, keyed by session id. Stable across polls that change nothing. */
export function useOpenElsewhereSessions(): SessionOpenElsewhereMap {
  return useContext(OpenElsewhereContext);
}

/**
 * Whether the user has this session open in CloudCLI: created or sent to from
 * here and not closed. Stable across polls that change nothing.
 */
export function useIsSessionOpenInCloudCli(sessionId: string | null | undefined): boolean {
  const sessionIds = useContext(OpenInCloudCliContext);
  return Boolean(sessionId && sessionIds.has(sessionId));
}

/** Every session open in CloudCLI, by id. Stable across polls that change nothing. */
export function useOpenInCloudCliSessionIds(): ReadonlySet<string> {
  return useContext(OpenInCloudCliContext);
}

export function useProcessingSessions(): SessionActivityMap {
  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
