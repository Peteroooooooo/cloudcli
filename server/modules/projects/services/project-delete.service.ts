import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { eraseSessionFromProvider } from '@/modules/providers/index.js';
import { broadcastSessionsRemoved } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Removes every session of a project from its provider's storage (transcripts,
 * the provider's side folders and databases) and deletes the rows of the ones
 * that went. A session that could not be removed keeps its row and is
 * returned in `failed`, so the project can be deleted again to retry it.
 */
export async function deleteProjectSessionsFromProviders(
  projectPath: string,
): Promise<{ deletedSessionIds: string[]; failed: Array<{ sessionId: string; message: string }> }> {
  const deletedSessionIds: string[] = [];
  const failed: Array<{ sessionId: string; message: string }> = [];

  for (const session of sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath)) {
    try {
      await eraseSessionFromProvider(session);
    } catch (error) {
      failed.push({
        sessionId: session.session_id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    sessionsDb.clearSupersededProviderSessions(session.session_id);
    sessionsDb.deleteSessionById(session.session_id);
    deletedSessionIds.push(session.session_id);
  }

  return { deletedSessionIds, failed };
}

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 *   The sidebar no longer offers this; the worktrees module still uses it when a worktree is removed.
 * - **Force** (`force` true): remove each session of that `project_path` from its provider and delete its row,
 *   then delete the `projects` row. If any session could not be removed, the project and that session's row
 *   are kept and the call fails. Every open client is told which sessions, and whether the project, went.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    return;
  }

  const { deletedSessionIds, failed } = await deleteProjectSessionsFromProviders(row.project_path);
  if (failed.length > 0) {
    broadcastSessionsRemoved(deletedSessionIds, []);
    throw new AppError(
      `${failed.length} session(s) of this project could not be deleted, so the project was kept: ${failed[0].message}`,
      {
        code: 'PROJECT_DELETE_INCOMPLETE',
        statusCode: 502,
        details: { failed },
      },
    );
  }

  sessionsDb.deleteSessionsByProjectPath(row.project_path);
  projectsDb.deleteProjectById(projectId);
  broadcastSessionsRemoved(deletedSessionIds, [projectId]);
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
}
