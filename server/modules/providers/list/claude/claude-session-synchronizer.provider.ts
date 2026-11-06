import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { readClaudeShownTitle } from '@/modules/providers/list/claude/claude-session-title.provider.js';
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
   * True when the name is the one Claude Code shows (a `/rename`, which
   * CloudCLI also writes, or Claude's generated title). Such a name replaces
   * whatever the row holds, including the name a CloudCLI-created session
   * started with.
   */
  isExplicitName?: boolean;
};

/** Directories under a project folder that hold subagent transcripts and tool output, never sessions. */
const NON_SESSION_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['subagents', 'tool-results']);

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The scan in `synchronize()` does not descend into
   * those directories; the watcher's single-file entry point checks here.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.some((part) => NON_SESSION_DIRECTORY_NAMES.has(part));
  }

  /**
   * The first prompt of each session, from `~/.claude/history.jsonl`. That file
   * grows with every prompt ever sent, so it is read only once a transcript
   * turns out to need it, and at most once per call.
   */
  private createHistoryNameLoader(): () => Promise<Map<string, string>> {
    let nameMap: Promise<Map<string, string>> | null = null;
    return () => {
      nameMap ??= buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
      return nameMap;
    };
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const loadHistoryNames = this.createHistoryNameLoader();
    const files = await findFilesRecursivelyChangedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null,
      {
        indexedPaths: sessionsDb.getTranscriptPathsByProvider(this.provider),
        skipDirectoryNames: NON_SESSION_DIRECTORY_NAMES,
      },
    );

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, loadHistoryNames);
      if (!parsed) {
        continue;
      }

      await this.upsertSession(parsed, filePath);
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath, this.createHistoryNameLoader());
    if (!parsed) {
      return null;
    }

    return this.upsertSession(parsed, filePath);
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

    // `createSession` keeps the name of a session CloudCLI created, so Claude's
    // title has to be applied to that row explicitly.
    if (parsed.isExplicitName && parsed.sessionName
      && sessionsDb.getSessionById(rowId)?.custom_name !== parsed.sessionName) {
      sessionsDb.updateSessionCustomName(rowId, parsed.sessionName);
    }

    return rowId;
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    loadHistoryNames: () => Promise<Map<string, string>>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // The title Claude Code shows wins over the stored name, so both apps name
    // a session the same. CloudCLI's own renames are written into the
    // transcript as a `/rename` line, so they are part of that title.
    const claudeTitle = await readClaudeShownTitle(filePath, parsed.sessionId);
    if (claudeTitle) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(claudeTitle, 'Untitled Claude Session'),
        isExplicitName: true,
      };
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    let sessionName = await this.extractSessionTitle(filePath, parsed.sessionId);
    if (!sessionName) {
      sessionName = (await loadHistoryNames()).get(parsed.sessionId);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  /**
   * Returns the best available title for one session from its transcript.
   *
   * Scans forward keeping the last match of each event type, then prefers
   * `custom-title` (a manual `/rename`) over `ai-title` over `last-prompt`.
   * Claude writes `custom-title` immediately before `ai-title`, so a reverse
   * scan that returns its first hit would always lose the manual rename.
   *
   * Returns undefined on a missing or unreadable file so sync can continue.
   */
  private async extractSessionTitle(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      let foundCustomTitle: string | undefined;
      let foundAiTitle: string | undefined;
      let foundLastPrompt: string | undefined;

      for (let index = 0; index < lines.length; index += 1) {
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
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;

        if (eventSessionId !== sessionId) {
          continue;
        }

        if (eventType === 'custom-title') {
          const title = typeof data.customTitle === 'string' ? data.customTitle : undefined;
          if (title?.trim()) {
            foundCustomTitle = title;
          }
        } else if (eventType === 'ai-title') {
          const title = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
          if (title?.trim()) {
            foundAiTitle = title;
          }
        } else if (eventType === 'last-prompt') {
          const prompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
          if (prompt?.trim()) {
            foundLastPrompt = prompt;
          }
        }
      }

      return foundCustomTitle || foundAiTitle || foundLastPrompt;
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
