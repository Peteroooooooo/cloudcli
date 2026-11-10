import { getConnection } from '@/modules/database/connection.js';

/**
 * Persistence for the sessions the user has open in CloudCLI (see
 * `CLOUDCLI_OPEN_SESSIONS_TABLE_SCHEMA_SQL`). Only the mark itself is stored;
 * whether a session still counts as open is decided against its row in
 * `sessions` every time the list is read.
 */
export const cloudCliOpenSessionsDb = {
  /**
   * Marks one session open, or moves the mark's time forward when it already
   * is. Returns true when the session was not marked before, which is when
   * the other clients have something new to show.
   */
  markOpen(sessionId: string, openedAt: string): boolean {
    const db = getConnection();
    const existing = db
      .prepare('SELECT 1 FROM cloudcli_open_sessions WHERE session_id = ?')
      .get(sessionId);

    db.prepare(
      `INSERT INTO cloudcli_open_sessions (session_id, opened_at)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET opened_at = excluded.opened_at`,
    ).run(sessionId, openedAt);

    return !existing;
  },

  /** Removes one session's mark. Returns true when there was one to remove. */
  close(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM cloudcli_open_sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  /**
   * The ids of every session still open in CloudCLI, most recently opened
   * first, after deleting the marks that no longer count: the session row is
   * gone or archived, or neither the session's last activity nor the mark
   * itself is at or after `activeSince` (an ISO timestamp).
   *
   * Pruning rather than filtering is what makes a lapsed mark stay closed: a
   * session that went quiet for a day and is later continued in VS Code is
   * not CloudCLI-open again until the user sends to it from here.
   */
  listOpenSessionIds(activeSince: string): string[] {
    const db = getConnection();
    db.prepare(
      `DELETE FROM cloudcli_open_sessions
       WHERE NOT EXISTS (
         SELECT 1 FROM sessions
         WHERE sessions.session_id = cloudcli_open_sessions.session_id
           AND COALESCE(sessions.isArchived, 0) = 0
           AND MAX(
             COALESCE(julianday(sessions.updated_at), julianday(sessions.created_at), 0),
             COALESCE(julianday(cloudcli_open_sessions.opened_at), 0)
           ) >= julianday(?)
       )`,
    ).run(activeSince);

    const rows = db
      .prepare('SELECT session_id FROM cloudcli_open_sessions ORDER BY julianday(opened_at) DESC, session_id ASC')
      .all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  },
};
