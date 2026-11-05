import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';

import { projectsDb, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { broadcastSessionsRemoved } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

type PruneResult = {
  /** App-facing ids of the session rows that were dropped. */
  removedSessionIds: string[];
  /** Projects dropped because their last session row went with them. */
  removedProjectIds: string[];
};

type SessionSynchronizeResult = PruneResult & {
  processedByProvider: Record<LLMProvider, number>;
  /** Indexed sessions dropped because their transcript file no longer exists. */
  prunedOrphans: number;
  failures: string[];
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * The directory each provider keeps its transcripts under. Resolved per call
 * because tests point the home directory at a fixture after import.
 */
const getProviderTranscriptRoot = (provider: string): string | null => {
  const home = os.homedir();
  switch (provider) {
    case 'claude':
      return path.join(home, '.claude', 'projects');
    case 'codex':
      // Covers both `sessions/` and `archived_sessions/`.
      return path.join(home, '.codex');
    case 'cursor':
      return path.join(home, '.cursor', 'projects');
    default:
      return null;
  }
};

/** Codex app-server reports paths with the Windows `\\?\` prefix; `path.relative` does not strip it. */
const stripWindowsLongPathPrefix = (target: string): string => target.replace(/^\\\\\?\\/, '');

const isInsideDirectory = (directory: string, target: string): boolean => {
  const relativePath = path.relative(directory, target);
  return Boolean(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
};

/**
 * Removes indexed sessions whose transcript file has disappeared from disk,
 * then the projects that were left without any session.
 *
 * Nothing else deletes these rows: the synchronizers only ever upsert. A row
 * is dropped when its file is gone and the provider's transcript root still
 * exists, so deleting a whole project folder clears its sessions too. For a
 * transcript outside every known root, its containing directory has to exist
 * instead. Either way an unmounted or not-yet-created home is never read as
 * "every transcript was deleted" and cannot wipe the index.
 *
 * `providers` limits the pass to providers whose scan just succeeded: one that
 * failed may not have re-indexed transcripts it would otherwise have re-created.
 */
const pruneDeletedSessions = async (providers?: ReadonlySet<string>): Promise<PruneResult> => {
  const knownDirectoryExists = new Map<string, boolean>();
  const directoryExists = async (directory: string): Promise<boolean> => {
    let exists = knownDirectoryExists.get(directory);
    if (exists === undefined) {
      exists = await pathExists(directory);
      knownDirectoryExists.set(directory, exists);
    }
    return exists;
  };

  const removedSessionIds: string[] = [];
  const emptiedProjectPaths = new Set<string>();

  for (const row of sessionsDb.getSessionsWithTranscriptPath()) {
    if (providers && !providers.has(row.provider)) {
      continue;
    }
    if (await pathExists(row.jsonl_path)) {
      continue;
    }

    const transcriptPath = stripWindowsLongPathPrefix(row.jsonl_path);
    const providerRoot = getProviderTranscriptRoot(row.provider);
    const guardDirectory = providerRoot && isInsideDirectory(providerRoot, transcriptPath)
      ? providerRoot
      : path.dirname(transcriptPath);
    if (!(await directoryExists(guardDirectory))) {
      continue;
    }

    if (sessionsDb.deleteSessionById(row.session_id)) {
      removedSessionIds.push(row.session_id);
      if (row.project_path) {
        emptiedProjectPaths.add(row.project_path);
      }
    }
  }

  const removedProjectIds: string[] = [];
  for (const projectPath of emptiedProjectPaths) {
    const projectId = projectsDb.deleteProjectPathIfUnused(projectPath);
    if (projectId) {
      removedProjectIds.push(projectId);
    }
  }

  // Every open client learns about the removal, not only the one whose request
  // happened to find it: a client keeps sessions from pages it already loaded
  // when it merges a refreshed list.
  broadcastSessionsRemoved(removedSessionIds, removedProjectIds);

  return { removedSessionIds, removedProjectIds };
};

/**
 * The scan that every `synchronizeSessions()` caller shares while it runs.
 *
 * Opening the UI fires `/api/projects` and `/api/projects/archived` at once,
 * and each used to start its own full provider scan from the same
 * `last_scanned_at` cursor: identical work over identical transcripts,
 * contending for the same synchronous SQLite writes and doubling how long the
 * sidebar sits on its loading screen. Callers that arrive while a scan is
 * already running now await that scan instead of starting another.
 */
let inFlightSynchronization: Promise<SessionSynchronizeResult> | null = null;

/**
 * Runs all provider synchronizers and updates scan_state.last_scanned_at.
 */
async function runSessionSynchronization(): Promise<SessionSynchronizeResult> {
  const lastScanAt = scanStateDb.getLastScannedAt();
  const scanBoundary = new Date();
  const processedByProvider: Record<LLMProvider, number> = {
    claude: 0,
    codex: 0,
    cursor: 0,
    opencode: 0,
  };
  const failures: string[] = [];
  const succeededProviders = new Set<string>();

  const results = await Promise.allSettled(
    providerRegistry.listProviders().map(async (provider) => ({
      provider: provider.id,
      processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
    }))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      processedByProvider[result.value.provider] = result.value.processed;
      succeededProviders.add(result.value.provider);
      continue;
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(reason);
  }

  const pruned = await pruneDeletedSessions(succeededProviders);

  if (failures.length === 0) {
    scanStateDb.updateLastScannedAt(scanBoundary);
  } else {
    console.warn(
      `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
    );
  }

  return {
    processedByProvider,
    prunedOrphans: pruned.removedSessionIds.length,
    ...pruned,
    failures,
  };
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Scans every provider for new or changed sessions, coalescing concurrent
   * callers onto a single scan.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    if (inFlightSynchronization) {
      return inFlightSynchronization;
    }

    inFlightSynchronization = runSessionSynchronization().finally(() => {
      inFlightSynchronization = null;
    });

    return inFlightSynchronization;
  },

  /**
   * Drops sessions whose transcripts were deleted, without rescanning any
   * provider. Only checks that each indexed file still exists, so the watcher
   * can run it on every delete event.
   */
  async pruneDeletedSessions(): Promise<PruneResult> {
    return pruneDeletedSessions();
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
