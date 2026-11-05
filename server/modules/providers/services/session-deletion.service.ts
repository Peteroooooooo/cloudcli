import { rm } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProviderSessionDeletion } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

type SessionToErase = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  jsonl_path: string | null;
};

function sessionDeletionFor(provider: string): IProviderSessionDeletion | undefined {
  try {
    return providerRegistry.resolveProvider(provider).sessionDeletion;
  } catch {
    // A row left by a provider this build no longer has: only its file is known.
    return undefined;
  }
}

/**
 * Removes a session from its provider's storage, for a permanent delete:
 * the provider session it is in now and every one it was edited off, since
 * editing a message on a provider that rewinds by branching moves the session
 * onto a copy and leaves the earlier one behind.
 *
 * Providers without a deletion hook have their transcript files removed, which
 * is all they keep. On failure this throws and leaves the session row and its
 * superseded records alone, so deleting again retries what is left.
 */
export async function eraseSessionFromProvider(session: SessionToErase): Promise<void> {
  const targets = [
    { providerSessionId: session.provider_session_id, jsonlPath: session.jsonl_path },
    ...sessionsDb.getSupersededProviderSessions(session.session_id).map((row) => ({
      providerSessionId: row.provider_session_id,
      jsonlPath: row.jsonl_path,
    })),
  ];
  const deletion = sessionDeletionFor(session.provider);

  try {
    for (const target of targets) {
      if (deletion) {
        await deletion.deleteSession(target);
      } else if (target.jsonlPath) {
        await rm(target.jsonlPath, { force: true });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Could not delete the session from the provider', {
      sessionId: session.session_id,
      provider: session.provider,
      error: message,
    });
    throw new AppError(`The session could not be deleted from ${session.provider}: ${message}`, {
      code: 'SESSION_DELETE_FAILED',
      statusCode: 502,
    });
  }
}
