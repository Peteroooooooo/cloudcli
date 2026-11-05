import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { CodexForkProvider } from '@/modules/providers/list/codex/codex-fork.provider.js';
import { CodexProviderModels } from '@/modules/providers/list/codex/codex-models.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { CodexMcpProvider } from '@/modules/providers/list/codex/codex-mcp.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionDeletionProvider } from '@/modules/providers/list/codex/codex-session-deletion.provider.js';
import { CodexSessionTitleProvider } from '@/modules/providers/list/codex/codex-session-title.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { CodexSkillsProvider } from '@/modules/providers/list/codex/codex-skills.provider.js';
import type {
  IProviderAuth,
  IProviderFork,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionDeletion,
  IProviderSessionSynchronizer,
  IProviderSessionTitle,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class CodexProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = codexRuntime;
  readonly models: IProviderModels = new CodexProviderModels();
  readonly mcp = new CodexMcpProvider();
  readonly auth: IProviderAuth = new CodexProviderAuth();
  readonly skills: IProviderSkills = new CodexSkillsProvider();
  readonly sessions: IProviderSessions = new CodexSessionsProvider();
  readonly fork: IProviderFork = new CodexForkProvider();
  readonly sessionTitle: IProviderSessionTitle = new CodexSessionTitleProvider();
  readonly sessionDeletion: IProviderSessionDeletion = new CodexSessionDeletionProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new CodexSessionSynchronizer();

  constructor() {
    super('codex');
  }
}
