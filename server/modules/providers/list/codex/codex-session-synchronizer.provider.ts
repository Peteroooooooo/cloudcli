import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyChangedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /**
   * True when the name is the one Codex itself shows (`session_index.jsonl`).
   * It replaces whatever the row holds, including the name a CloudCLI-created
   * session started with: CloudCLI writes its renames there too.
   */
  isExplicitName?: boolean;
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.join(os.homedir(), '.codex');

  /**
   * Codex appends a line to this index on every rename, so the last line for a
   * thread is its current name.
   */
  private readNameIndex(): Promise<Map<string, string>> {
    return buildLookupMap(path.join(this.codexHome, 'session_index.jsonl'), 'id', 'thread_name', 'last');
  }

  /**
   * Scans ~/.codex/sessions and upserts discovered sessions into DB.
   *
   * `archived_sessions/` is left out: a thread archived in Codex is dropped
   * from the index, and comes back once Codex moves it into `sessions/` again.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await this.readNameIndex();
    const files = await findFilesRecursivelyChangedAfter(
      path.join(this.codexHome, 'sessions'),
      '.jsonl',
      since ?? null,
      { indexedPaths: sessionsDb.getTranscriptPathsByProvider(this.provider) },
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      await this.upsertSession(parsed, filePath);
      processed += 1;
    }

    // A rename in Codex only touches the index, never the rollout, so the
    // file scan above cannot see renames made while nothing was watching.
    // Read again: a rename made while the files were being read would
    // otherwise be undone with the names read at the start.
    this.applyNameIndex(await this.readNameIndex());

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const nameMap = await this.readNameIndex();
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    return this.upsertSession(parsed, filePath);
  }

  /**
   * Applies the names in Codex's index to indexed sessions. The watcher runs
   * this when the index changes, which is how a rename made in Codex reaches
   * the sidebar.
   */
  async synchronizeNames(): Promise<string[]> {
    return this.applyNameIndex(await this.readNameIndex());
  }

  private applyNameIndex(nameMap: Map<string, string>): string[] {
    const renamedSessionIds: string[] = [];
    for (const row of sessionsDb.getSessionNamesByProvider(this.provider)) {
      const indexedName = nameMap.get(row.provider_session_id ?? row.session_id);
      if (!indexedName?.trim()) {
        continue;
      }
      const name = normalizeSessionName(indexedName, 'Untitled Codex Session');
      if (row.custom_name !== name) {
        sessionsDb.updateSessionCustomName(row.session_id, name);
        renamedSessionIds.push(row.session_id);
      }
    }
    return renamedSessionIds;
  }

  private async upsertSession(parsed: ParsedSession, filePath: string): Promise<string> {
    const timestamps = await readFileTimestamps(filePath);
    const rowId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    // `createSession` keeps the name of a session CloudCLI created, so a name
    // given in Codex, or a first real name for an untitled row, has to be
    // applied to that row explicitly.
    const storedName = sessionsDb.getSessionById(rowId)?.custom_name;
    const hasRealName = Boolean(parsed.sessionName) && parsed.sessionName !== 'Untitled Codex Session';
    const replacesStored = parsed.isExplicitName || storedName === 'Untitled Codex Session';
    if (hasRealName && replacesStored && storedName !== parsed.sessionName) {
      sessionsDb.updateSessionCustomName(rowId, parsed.sessionName!);
    }

    return rowId;
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(parsed.sessionId, this.provider)) {
      return null;
    }

    // The name Codex shows wins over the stored one: renames made in Codex reach
    // CloudCLI, and CloudCLI's own renames are written to the same index.
    const indexedName = nameMap.get(parsed.sessionId);
    if (indexedName?.trim()) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(indexedName, 'Untitled Codex Session'),
        isExplicitName: true,
      };
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    const sessionName = await this.extractLastAgentMessageFromEnd(filePath);

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const lastAgentMessage = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && lastAgentMessage?.trim()) {
          return lastAgentMessage;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
