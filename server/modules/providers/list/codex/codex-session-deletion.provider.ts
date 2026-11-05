import { rm } from 'node:fs/promises';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderSessionDeletion } from '@/shared/interfaces.js';

/**
 * Deletes a Codex thread through `codex app-server`'s `thread/delete`, the
 * call behind `codex delete`. Codex keeps a thread in its own databases as
 * well as the rollout file, and its IDE list and `codex resume` read the
 * databases, so unlinking the file alone leaves the thread listed.
 */
export class CodexSessionDeletionProvider implements IProviderSessionDeletion {
  async deleteSession(input: { providerSessionId: string | null; jsonlPath: string | null }): Promise<void> {
    if (input.providerSessionId) {
      await codexAppServer.deleteThread(input.providerSessionId);
    }
    // Codex indexes the rollout files it finds on disk, so a file whose thread
    // was already gone from Codex's databases has to go too, or the thread
    // would be listed again.
    if (input.jsonlPath) {
      await rm(input.jsonlPath, { force: true });
    }
  }
}
