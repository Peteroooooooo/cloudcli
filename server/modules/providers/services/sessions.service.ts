import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionsRemoved, broadcastSessionUpserted, chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { listLiveClaudeProcesses } from '@/modules/providers/services/claude-cli-liveness.service.js';
import type { ClaudeProcessHost } from '@/modules/providers/services/claude-cli-liveness.service.js';
import { eraseSessionFromProvider } from '@/modules/providers/services/session-deletion.service.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import type {
  BackgroundTaskSummary,
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  WorkflowAgentActivity,
} from '@/shared/types.js';
import { AppError, sliceTailPage } from '@/shared/utils.js';

/**
 * One session the running-sessions poll reports as busy.
 *
 * A chat run in progress is listed as before. A session whose turn has ended
 * but whose background tasks are still outstanding is listed with
 * `background: true` and `canInterrupt: false`: the composer stays usable
 * (the runtime accepts a new turn while the work runs) and there is no run to
 * abort — a task is stopped by id through `chat.stop-task` instead. `tasks`
 * rides along on both kinds whenever the session has any.
 *
 * A turn driven outside CloudCLI — a VS Code panel, the Claude CLI in the
 * Shell view, or a terminal the user opened themselves — is listed the same
 * way, with `canInterrupt: false` because there is no run here to abort, a
 * `statusText` saying where the work is happening, and `openIn` naming it.
 */
type RunningSessionEntry = {
  sessionId: string;
  provider: LLMProvider;
  startedAt: number;
  lastSeq: number;
  background?: true;
  canInterrupt?: false;
  statusText?: string;
  openIn?: ClaudeProcessHost;
  tasks?: BackgroundTaskSummary[];
};

/** A session another Claude process has open, whether or not it is mid-turn. */
type OpenElsewhereEntry = {
  sessionId: string;
  openIn: ClaudeProcessHost;
  busy: boolean;
};

type RunningSessionsSnapshot = {
  sessions: RunningSessionEntry[];
  openElsewhere: OpenElsewhereEntry[];
};

const RUNNING_ELSEWHERE_STATUS: Record<ClaudeProcessHost, string> = {
  vscode: 'Running in VS Code',
  cli: 'Running in the Claude CLI',
  other: 'Running in another Claude process',
};

type CreateAppSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  sessionName: string;
};

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

type RecentSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

type StaleSessionListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectPath' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

type RecentSessionsPage = {
  conversations: RecentSessionListItem[];
  total: number;
  hasMore: boolean;
};

type SessionDetails = {
  /** Canonical app-facing session id (may differ from the looked-up id when a provider-native id was given). */
  sessionId: string;
  provider: LLMProvider;
  summary: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isArchived: boolean;
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    isArchived: boolean;
  } | null;
};

const MAX_CLOUDCLI_SESSION_NAME_WORDS = 4;

function buildCloudCliSessionName(initialMessage: string): string {
  const words = initialMessage.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, MAX_CLOUDCLI_SESSION_NAME_WORDS).join(' ') || 'Untitled Session';
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Returns app-facing ids for provider runs that are currently processing,
   * plus every session whose background work outlived its turn.
   *
   * This is intentionally status-only: callers that only need sidebar activity
   * indicators should not attach to chat streams or request replayed messages.
   */
  async listRunningSessions(): Promise<RunningSessionEntry[]> {
    return (await sessionsService.getRunningSessionsSnapshot()).sessions;
  },

  /**
   * The running-sessions poll's whole payload: the busy sessions of
   * `listRunningSessions`, plus every session some other Claude process has
   * open right now, busy or idle.
   *
   * `openElsewhere` exists because a turn sent from CloudCLI resumes the
   * session in a process of its own; the VS Code panel or terminal that also
   * has it open never sees that turn, and its next message branches the
   * transcript. Both lists come from one read of the process registry.
   */
  async getRunningSessionsSnapshot(): Promise<RunningSessionsSnapshot> {
    const entries: RunningSessionEntry[] = chatRunRegistry.listRunningRuns();
    const runningById = new Map(entries.map((entry) => [entry.sessionId, entry]));

    for (const provider of providerRegistry.listProviders()) {
      for (const { sessionId, tasks } of provider.runtime.listBackgroundWork?.() ?? []) {
        const running = runningById.get(sessionId);
        if (running) {
          running.tasks = tasks;
          continue;
        }
        entries.push({
          sessionId,
          provider: provider.id,
          startedAt: Math.min(...tasks.map((task) => task.startedAt)),
          // The completed run stays in the registry for a while, and a client
          // that subscribes with its lastSeq replays the tail it missed.
          lastSeq: chatRunRegistry.getRun(sessionId)?.lastSeq ?? 0,
          background: true,
          canInterrupt: false,
          tasks,
        });
      }
    }

    const openElsewhereById = new Map<string, OpenElsewhereEntry>();
    for (const live of await listLiveClaudeProcesses()) {
      const session = sessionsDb.getSessionByProviderSessionId(live.providerSessionId);
      if (!session) {
        continue;
      }

      const known = openElsewhereById.get(session.session_id);
      // Two processes can hold one session (a VS Code panel and a terminal
      // resume); the busy one is the more useful to report.
      if (!known || (live.busy && !known.busy)) {
        openElsewhereById.set(session.session_id, { sessionId: session.session_id, openIn: live.host, busy: live.busy });
      }

      // The chat-run registry only knows about turns CloudCLI drives itself, so
      // without this a session working under another Claude process — including
      // one CloudCLI spawned for its own Shell view — looks idle. A session
      // already listed above keeps its richer entry.
      if (!live.busy || runningById.has(session.session_id)) {
        continue;
      }

      entries.push({
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        startedAt: live.startedAt,
        lastSeq: chatRunRegistry.getRun(session.session_id)?.lastSeq ?? 0,
        // There is no run here to abort: the turn belongs to a process
        // CloudCLI does not own, so it can be reported but not interrupted.
        canInterrupt: false,
        statusText: RUNNING_ELSEWHERE_STATUS[live.host],
        openIn: live.host,
      });
      runningById.set(session.session_id, entries[entries.length - 1]);
    }

    return { sessions: entries, openElsewhere: [...openElsewhereById.values()] };
  },

  /**
   * Returns the active conversation feed in true global activity order;
   * `provider` narrows the page and its total to one provider.
   */
  listRecentSessions(limit: number, offset: number, provider: LLMProvider | null = null): RecentSessionsPage {
    const page = sessionsDb.getRecentSessionsPage(limit, offset, provider);
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const conversations = page.sessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
      };
    });

    return {
      conversations,
      total: page.total,
      hasMore: offset + conversations.length < page.total,
    };
  },

  /**
   * Session count per provider for the sidebar's agent filter, which shows a
   * segment only for agents that have sessions. Archived sessions and those of
   * archived projects are counted too, because the filter also narrows the
   * Archive view. Providers with no sessions are left out, e.g.
   * `{ claude: 175, codex: 8 }`.
   */
  countSessionsByProvider(): Partial<Record<LLMProvider, number>> {
    const counts: Partial<Record<LLMProvider, number>> = {};
    for (const { provider, count } of sessionsDb.countSessionsByProvider()) {
      if (count > 0) {
        counts[provider as LLMProvider] = count;
      }
    }
    return counts;
  },

  /**
   * Resolves the provider-native session id a runtime needs for resume.
   *
   * Callers hand provider runtimes the stable app session id; the provider
   * CLIs/SDKs only understand their own native id, which lives on the session
   * row. Ids without a row are assumed to be provider-native already (direct
   * API callers that reference sessions the watcher has not indexed yet).
   */
  resolveProviderSessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) {
      return null;
    }

    const session = sessionsDb.getSessionById(sessionId);
    return session ? session.provider_session_id : sessionId;
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Allocates a stable app-facing session id before any provider run happens.
   *
   * This is the entry point of the session gateway: the frontend calls this
   * (via `POST /api/providers/sessions`) when the user starts a brand-new
   * chat, navigates to the returned id immediately, and the id never changes
   * for the lifetime of the conversation. The provider-native id is mapped to
   * this row later, when the provider runtime announces it mid-run. Its title
   * comes directly from the first visible CloudCLI message and is limited to
   * four whole words before any provider-owned storage exists.
   */
  createAppSession(
    provider: LLMProvider,
    projectPath: string,
    initialMessage: string,
  ): CreateAppSessionResult {
    const normalizedProjectPath = projectPath.trim();
    if (!normalizedProjectPath) {
      throw new AppError('projectPath is required.', {
        code: 'PROJECT_PATH_REQUIRED',
        statusCode: 400,
      });
    }

    const sessionId = randomUUID();
    const sessionName = buildCloudCliSessionName(initialMessage);
    sessionsDb.createAppSession(sessionId, provider, normalizedProjectPath, sessionName);

    return {
      sessionId,
      provider,
      projectPath: normalizedProjectPath,
      sessionName,
    };
  },

  /**
   * Branches a session into an independent one containing its conversation up
   * to `upToAnchorId` (the whole thing when omitted).
   *
   * The source is left completely untouched — this is the "try two approaches"
   * action, not a destructive one.
   */
  async forkSessionById(
    sessionId: string,
    options: { upToAnchorId?: string; title?: string } = {},
  ): Promise<CreateAppSessionResult> {
    const source = sessionsDb.getSessionById(sessionId);
    if (!source) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = source.provider as LLMProvider;
    const fork = providerRegistry.resolveProvider(provider).fork;
    if (!fork) {
      throw new AppError(`Sessions cannot be forked for provider "${provider}".`, {
        code: 'FORK_NOT_SUPPORTED',
        statusCode: 409,
      });
    }

    // A session that has never run has no transcript to copy, so there is
    // nothing a fork of it could resume from.
    if (!source.provider_session_id || !source.jsonl_path) {
      throw new AppError('This session has not produced a transcript yet.', {
        code: 'FORK_SOURCE_NOT_READY',
        statusCode: 409,
      });
    }

    const sessionName = options.title?.trim()
      || `${source.custom_name?.trim() || 'Session'} (fork)`;

    const forked = await fork.forkSession({
      providerSessionId: source.provider_session_id,
      jsonlPath: source.jsonl_path,
      projectPath: source.project_path ?? '',
      upToAnchorId: options.upToAnchorId,
      title: sessionName,
    });

    const forkSessionId = randomUUID();
    sessionsDb.createForkedSession({
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      customName: sessionName,
      providerSessionId: forked.providerSessionId,
      jsonlPath: forked.jsonlPath,
      forkedFromSessionId: sessionId,
      // A fork that silently dropped to the catalog default would answer
      // differently from the conversation it was branched from.
      model: source.model,
      effort: source.effort,
    });

    await broadcastSessionUpserted(forkSessionId);

    return {
      sessionId: forkSessionId,
      provider,
      projectPath: source.project_path ?? '',
      sessionName,
    };
  },

  /**
   * Resolves the provider-native id only for an explicit user copy action.
   * Normal session payloads continue to expose only the stable app id.
   */
  getProviderSessionId(sessionId: string): string {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!session.provider_session_id) {
      throw new AppError('This session ID is not available yet.', {
        code: 'PROVIDER_SESSION_ID_NOT_AVAILABLE',
        statusCode: 409,
      });
    }

    return session.provider_session_id;
  },

  /**
   * Fetches persisted history by app session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database. The provider adapter receives the
   * provider-native session id (the one written into transcripts on disk),
   * and every returned message is remapped back to the app session id so
   * provider ids never reach the frontend.
   */
  /**
   * Resolves where a conversation must resume from so that one already-sent
   * message, and everything after it, is replaced.
   *
   * Returns `null` when the provider cannot do this at all, which is how the
   * chat gateway knows to refuse the request rather than silently sending the
   * edit as a new message at the end of the conversation.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null } | null> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    if (!sessions.resolveEditAnchor) {
      return null;
    }

    return sessions.resolveEditAnchor(sessionId, anchorId);
  },

  /**
   * Whether editing a message on this session's provider means rewinding it on
   * disk first, rather than handing the anchor to the runtime as a resume
   * option.
   *
   * Answering this without doing anything is the point: the rewind moves the
   * session onto a different provider transcript and cannot be undone, so the
   * gateway has to know which shape the run takes before it commits to one.
   */
  providerRewindsForEdit(sessionId: string): boolean {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return Boolean(providerRegistry.resolveProvider(session.provider as LLMProvider).sessions.rewindSession);
  },

  /**
   * Rewinds a session on disk so `keepThroughId` is the last row it holds.
   *
   * Only call this once the run is admitted — see `providerRewindsForEdit`.
   */
  async rewindSessionForEdit(sessionId: string, keepThroughId: string | null): Promise<void> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    await sessions.rewindSession?.(sessionId, keepThroughId);
  },

  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // App-created sessions that never produced a provider transcript yet
    // (e.g. first message still streaming) simply have no history.
    if (!session.provider_session_id) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const provider = session.provider as LLMProvider;
    const providerSessions = providerRegistry.resolveProvider(provider).sessions;
    const providerSessionId = session.provider_session_id;
    const projectPath = session.project_path ?? '';
    const requestedLimit = options.limit ?? null;
    const requestedOffset = options.offset ?? 0;

    // Claude and Codex history readers parse `jsonl_path` itself, so a page
    // can be sliced from the stat-validated full-transcript cache instead of
    // re-parsing the whole file per request. Cursor and OpenCode read their
    // messages from elsewhere (store.db / shared SQLite), so that file's stat
    // says nothing about their history — they stay on the direct path.
    const transcriptPath = provider === 'claude' || provider === 'codex'
      ? session.jsonl_path
      : null;
    const fullHistory = await sessionHistoryCache.getFullHistory({
      sessionId,
      transcriptPath,
      loadFull: () => providerSessions.fetchHistory(sessionId, {
        limit: null,
        offset: 0,
        projectPath,
        providerSessionId,
      }),
    });

    let result: FetchHistoryResult;
    if (fullHistory) {
      // Providers slice with this same helper, so a cached page is identical
      // to what a direct `(limit, offset)` read would have returned.
      const { page, hasMore } = sliceTailPage(fullHistory.messages, requestedLimit, Math.max(0, requestedOffset));
      result = {
        ...fullHistory,
        messages: page,
        hasMore,
        offset: requestedOffset,
        limit: requestedLimit,
      };
    } else {
      result = await providerSessions.fetchHistory(sessionId, {
        limit: requestedLimit,
        offset: requestedOffset,
        projectPath,
        providerSessionId,
      });
    }

    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        sessionId,
      })),
    };
  },

  /**
   * Reads what one agent of a workflow run did, for the card that opened it.
   *
   * Not found covers both a provider that spawns no workflow agents and a run
   * that left no transcript for this agent: either way there is nothing to
   * show, and the card says so in one line.
   */
  async readWorkflowAgentActivity(sessionId: string, runId: string, agentId: string): Promise<WorkflowAgentActivity> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = providerRegistry.resolveProvider(session.provider as LLMProvider).sessions;
    const activity = await sessions.readWorkflowAgentActivity?.(sessionId, runId, agentId);
    if (!activity) {
      throw new AppError(`Workflow agent "${agentId}" was not found.`, {
        code: 'WORKFLOW_AGENT_NOT_FOUND',
        statusCode: 404,
      });
    }

    return activity;
  },

  /**
   * Resolves one session (by app id, falling back to the provider-native id)
   * to its metadata plus the owning project.
   *
   * This backs deep links like `/session/:sessionId`: the frontend's paginated
   * project payloads only carry each project's first session page, so a
   * session opened directly by URL may not be present client-side at all —
   * this lookup is the authoritative way to learn which project owns it.
   */
  getSessionDetailsById(sessionId: string): SessionDetails {
    const session =
      sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = session.project_path?.trim() ? session.project_path : null;
    const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

    return {
      sessionId: session.session_id,
      provider: session.provider as LLMProvider,
      summary: session.custom_name?.trim() || '',
      createdAt: session.created_at ?? null,
      updatedAt: session.updated_at ?? null,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      isArchived: Boolean(session.isArchived),
      project: project && projectPath
        ? {
            projectId: project.project_id,
            path: projectPath,
            fullPath: projectPath,
            displayName: resolveProjectDisplayName(projectPath, project.custom_project_name),
            isStarred: Boolean(project.isStarred),
            isArchived: Boolean(project.isArchived),
          }
        : null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * removes the session from the provider's own storage (unless
   * `deletedFromDisk` is false) before deleting the row; when that fails the
   * row stays, so the session is not lost from view while the provider still
   * has it.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    const deletedFromDisk = Boolean(options.deletedFromDisk);
    if (deletedFromDisk) {
      await eraseSessionFromProvider(session);
    }

    sessionsDb.clearSupersededProviderSessions(sessionId);
    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // The row is gone before the watcher sees the transcript go, so its removal
    // check finds nothing to report; the other open clients learn of it here.
    broadcastSessionsRemoved([sessionId], []);

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk,
    };
  },

  /**
   * Sessions with no activity for at least `olderThanDays` days, for the
   * "clean up old sessions" view. Sessions in starred projects and sessions
   * that are running now are left out.
   */
  async listStaleSessions(olderThanDays: number, now = Date.now()): Promise<StaleSessionListItem[]> {
    const cutoff = new Date(now - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const runningSessionIds = new Set((await sessionsService.listRunningSessions()).map((entry) => entry.sessionId));
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const items: StaleSessionListItem[] = [];

    for (const session of sessionsDb.getSessionsLastActiveBefore(cutoff)) {
      if (runningSessionIds.has(session.session_id)) {
        continue;
      }

      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;
      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }
      if (project?.isStarred) {
        continue;
      }

      items.push({
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        lastActivity: session.updated_at ?? session.created_at ?? null,
      });
    }

    return items;
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   *
   * The name is written to the provider first (Claude's transcript, Codex's
   * thread index) so the CLI shows it too, then to the index. The session
   * synchronizers read a provider's own name over the index's, so a name kept
   * only in the index would be replaced the next time the CLI renamed the
   * session; a failed write therefore fails the rename instead.
   */
  async renameSessionById(sessionId: string, summary: string): Promise<{ sessionId: string; summary: string }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessionTitle = providerRegistry.resolveProvider(session.provider as LLMProvider).sessionTitle;
    // A session CloudCLI created has no provider session until its first run;
    // there is nothing to name on the provider's side yet.
    if (sessionTitle && session.provider_session_id) {
      try {
        await sessionTitle.setTitle({
          providerSessionId: session.provider_session_id,
          jsonlPath: session.jsonl_path,
          title: summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Could not write the session name to the provider', { sessionId, provider: session.provider, error: message });
        throw new AppError(`The name could not be saved to ${session.provider}: ${message}`, {
          code: 'SESSION_RENAME_FAILED',
          statusCode: 502,
        });
      }
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
