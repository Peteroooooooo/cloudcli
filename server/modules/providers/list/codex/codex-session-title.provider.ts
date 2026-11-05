import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderSessionTitle } from '@/shared/interfaces.js';

/**
 * Names a Codex thread through `codex app-server`'s `thread/name/set`, the
 * same call the Codex IDE extension makes. Codex records it in
 * `session_index.jsonl` and its thread database; the rollout file is not
 * touched, so the session keeps its place in "recent" lists.
 */
export class CodexSessionTitleProvider implements IProviderSessionTitle {
  async setTitle(input: { providerSessionId: string; jsonlPath: string | null; title: string }): Promise<void> {
    await codexAppServer.setThreadName({ threadId: input.providerSessionId, name: input.title.trim() });
  }
}
