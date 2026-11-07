import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, GetSessionActivity, IsSessionProcessing, MarkSessionBackground, MarkSessionIdle, MarkSessionProcessing, SessionActivity, SessionActivityMap, SessionOpenElsewhere, SessionOpenElsewhereMap, SyncProcessingSessions } from '@/shared/types';
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

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
    openElsewhere?: OpenElsewhereApiItem[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  markSessionBackground: MarkSessionBackground;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
  getSessionActivity: GetSessionActivity;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const BackgroundSessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const NO_SESSIONS_OPEN_ELSEWHERE: SessionOpenElsewhereMap = new Map();
// Defaults to empty rather than throwing: it only adds a marker, so a row or
// composer rendered outside the provider simply shows none.
const OpenElsewhereContext = createContext<SessionOpenElsewhereMap>(NO_SESSIONS_OPEN_ELSEWHERE);

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

/** A string that is equal for two maps exactly when their entries are. */
const openElsewhereKey = (sessions: SessionOpenElsewhereMap): string =>
  [...sessions]
    .map(([sessionId, { openIn, busy }]) => `${sessionId}:${openIn}:${busy ? 1 : 0}`)
    .sort()
    .join('\u0000');

/** Mounted by the project-workspace route; tracks which sessions are busy — producing a response or running background tasks — so chat, sidebar and project-workspace agree on session activity. */
export function SessionProtectionProvider({ children }: { children: ReactNode }) {
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

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
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
              tasks: parseBackgroundTasks(session.tasks),
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
      );

      const openSessions = parseOpenElsewhere(payload.data?.openElsewhere);
      const key = openElsewhereKey(openSessions);
      setOpenElsewhere((previous) => (previous.key === key ? previous : { key, sessions: openSessions }));
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

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      markSessionBackground,
      syncProcessingSessions,
      isSessionProcessing,
      getSessionActivity,
    }),
    [
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
              {children}
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
