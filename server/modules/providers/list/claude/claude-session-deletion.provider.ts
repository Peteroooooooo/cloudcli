import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { IProviderSessionDeletion } from '@/shared/interfaces.js';

/** A Claude session id as it appears in file and folder names. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The Claude config folder a transcript belongs to, read off the transcript's
 * own path (`<config>/projects/<project>/<id>.jsonl`). Null for a transcript
 * stored anywhere else, which then has no side folders this can vouch for.
 */
function claudeHomeOfTranscript(jsonlPath: string): string | null {
  const projectsFolder = path.dirname(path.dirname(jsonlPath));
  return path.basename(projectsFolder) === 'projects' ? path.dirname(projectsFolder) : null;
}

/**
 * Deletes a Claude session and what Claude keeps beside it: the folder next to
 * the transcript (sub-agent transcripts, large tool results), the file
 * snapshots behind rewinds (`file-history/<id>`) and `session-env/<id>`.
 *
 * `history.jsonl` is left alone: it is Claude's prompt history across all
 * sessions, and Claude appends to it while it runs.
 */
export class ClaudeSessionDeletionProvider implements IProviderSessionDeletion {
  async deleteSession(input: { providerSessionId: string | null; jsonlPath: string | null }): Promise<void> {
    if (!input.jsonlPath) {
      return;
    }

    await rm(input.jsonlPath, { force: true });

    const claudeHome = claudeHomeOfTranscript(input.jsonlPath);
    if (!claudeHome) {
      return;
    }

    const transcriptId = path.basename(input.jsonlPath, '.jsonl');
    const sessionIds = new Set([transcriptId, input.providerSessionId ?? transcriptId]);
    for (const sessionId of sessionIds) {
      // The id becomes part of a path that is removed recursively.
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        continue;
      }
      await rm(path.join(path.dirname(input.jsonlPath), sessionId), { recursive: true, force: true });
      await rm(path.join(claudeHome, 'file-history', sessionId), { recursive: true, force: true });
      await rm(path.join(claudeHome, 'session-env', sessionId), { recursive: true, force: true });
    }
  }
}
