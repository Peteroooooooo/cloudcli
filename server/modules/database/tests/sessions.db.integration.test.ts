import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session archive queries hide archived rows from active project views', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const activeProjectSessions = sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('createSession reactivates archived rows when the session becomes active again', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    sessionsDb.updateSessionIsArchived('session-reused', true);

    sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = sessionsDb.getAllSessions();
    const archivedSessions = sessionsDb.getArchivedSessions();
    const restoredSession = sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0]?.session_id, 'session-reused');
    assert.equal(activeSessions[0]?.custom_name, 'Updated Name');
    assert.equal(archivedSessions.length, 0);
    assert.equal(restoredSession?.isArchived, 0);
  });
});

test("createSession leaves an archived row archived when the transcript has not changed", async () => {
  await withIsolatedDatabase(() => {
    const createdAt = "2026-07-18T09:00:00.000Z";
    const updatedAt = "2026-07-18T10:00:00.000Z";
    const jsonlPath = "/transcripts/session-untouched.jsonl";

    sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, updatedAt, jsonlPath);
    sessionsDb.updateSessionIsArchived("session-untouched", true);

    // A full rescan re-indexes every transcript created since the last scan,
    // changed or not, and hands over the timestamps the file still carries.
    sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, updatedAt, jsonlPath);

    assert.equal(sessionsDb.getSessionById("session-untouched")?.isArchived, 1);
    assert.equal(sessionsDb.getArchivedSessions().length, 1);
    assert.equal(sessionsDb.getAllSessions().length, 0);

    // Actually writing to the session again still brings it back.
    sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, "2026-07-18T11:00:00.000Z", jsonlPath);

    assert.equal(sessionsDb.getSessionById("session-untouched")?.isArchived, 0);
  });
});

test("the upsert path counts an omitted timestamp as activity", async () => {
  await withIsolatedDatabase(() => {
    // An app-created row carries no provider id, so indexing it takes the
    // INSERT ... ON CONFLICT branch rather than the UPDATE above. Its
    // updated_at is CURRENT_TIMESTAMP, which resolves to whole seconds, so a
    // call in the same second is not *newer* -- the omitted timestamp itself
    // has to be what reactivates the row.
    sessionsDb.createAppSession("session-legacy", "claude", "/workspace/demo-project");
    sessionsDb.updateSessionIsArchived("session-legacy", true);

    sessionsDb.createSession("session-legacy", "claude", "/workspace/demo-project", "Indexed Name");

    assert.equal(sessionsDb.getSessionById("session-legacy")?.isArchived, 0);
  });
});

test("the upsert path leaves an archived row alone for a transcript older than it", async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession("session-stale", "claude", "/workspace/demo-project");
    sessionsDb.updateSessionIsArchived("session-stale", true);

    sessionsDb.createSession("session-stale", "claude", "/workspace/demo-project", "Indexed Name", "2026-07-18T09:00:00.000Z", "2026-07-18T10:00:00.000Z", "/transcripts/session-stale.jsonl");

    assert.equal(sessionsDb.getSessionById("session-stale")?.isArchived, 1);
  });
});


test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('recent sessions are globally ordered, paginated, and limited to visible conversations', async () => {
  await withIsolatedDatabase(() => {
    const fixtures: Array<Parameters<typeof sessionsDb.createSession>> = [
      ['session-oldest', 'claude', '/workspace/project-a', 'Oldest', '2026-07-18T09:00:00.000Z', '2026-07-18T10:00:00.000Z'],
      ['session-newest', 'codex', '/workspace/project-b', 'Newest', '2026-07-18T11:00:00.000Z', '2026-07-18T12:00:00.900Z'],
      ['session-same-second', 'claude', '/workspace/project-a', 'Same second, slightly older', '2026-07-18T12:00:00.000Z', '2026-07-18T12:00:00.100Z'],
      ['session-middle', 'claude', '/workspace/project-a', 'Middle', '2026-07-18T10:00:00.000Z', '2026-07-18T11:00:00.000Z'],
      ['session-archived', 'claude', '/workspace/project-a', 'Archived session', '2026-07-18T13:00:00.000Z', '2026-07-18T13:00:00.000Z'],
      ['session-hidden-project', 'claude', '/workspace/project-hidden', 'Archived project session', '2026-07-18T14:00:00.000Z', '2026-07-18T14:00:00.000Z'],
    ];
    fixtures.forEach((fixture) => sessionsDb.createSession(...fixture));

    sessionsDb.updateSessionIsArchived('session-archived', true);
    projectsDb.updateProjectIsArchived('/workspace/project-hidden', true);

    const firstPage = sessionsDb.getRecentSessionsPage(2, 0);
    const secondPage = sessionsDb.getRecentSessionsPage(2, 2);

    assert.equal(firstPage.total, 4);
    assert.deepEqual(
      firstPage.sessions.map((session) => session.session_id),
      ['session-newest', 'session-same-second'],
    );
    assert.equal(secondPage.total, 4);
    assert.deepEqual(
      secondPage.sessions.map((session) => session.session_id),
      ['session-middle', 'session-oldest'],
    );
  });
});

test('the provider argument narrows recent and project pages and their totals', async () => {
  await withIsolatedDatabase(() => {
    const fixtures: Array<Parameters<typeof sessionsDb.createSession>> = [
      ['claude-old', 'claude', '/workspace/project-a', 'Claude old', '2026-07-18T09:00:00.000Z', '2026-07-18T09:00:00.000Z'],
      ['codex-old', 'codex', '/workspace/project-a', 'Codex old', '2026-07-18T10:00:00.000Z', '2026-07-18T10:00:00.000Z'],
      ['claude-new', 'claude', '/workspace/project-b', 'Claude new', '2026-07-18T11:00:00.000Z', '2026-07-18T11:00:00.000Z'],
      ['codex-new', 'codex', '/workspace/project-a', 'Codex new', '2026-07-18T12:00:00.000Z', '2026-07-18T12:00:00.000Z'],
      ['codex-archived', 'codex', '/workspace/project-a', 'Codex archived', '2026-07-18T13:00:00.000Z', '2026-07-18T13:00:00.000Z'],
    ];
    fixtures.forEach((fixture) => sessionsDb.createSession(...fixture));
    sessionsDb.updateSessionIsArchived('codex-archived', true);

    const codexRecent = sessionsDb.getRecentSessionsPage(1, 0, 'codex');
    assert.equal(codexRecent.total, 2);
    assert.deepEqual(codexRecent.sessions.map((session) => session.session_id), ['codex-new']);
    assert.deepEqual(
      sessionsDb.getRecentSessionsPage(1, 1, 'codex').sessions.map((session) => session.session_id),
      ['codex-old'],
    );
    assert.equal(sessionsDb.getRecentSessionsPage(10, 0, 'cursor').total, 0);
    assert.equal(sessionsDb.getRecentSessionsPage(10, 0).total, 4, 'no provider lists every provider');

    assert.deepEqual(
      sessionsDb.getSessionsByProjectPathPage('/workspace/project-a', 10, 0, 'codex').map((session) => session.session_id),
      ['codex-new', 'codex-old'],
    );
    assert.deepEqual(
      sessionsDb.getSessionsByProjectPathPage('/workspace/project-a', 10, 0, 'claude').map((session) => session.session_id),
      ['claude-old'],
    );
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/project-a', 'codex'), 2);
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/project-a', 'claude'), 1);
    assert.equal(sessionsDb.countSessionsByProjectPath('/workspace/project-a'), 3);
  });
});

test('countSessionsByProvider counts archived sessions and archived projects too', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('claude-1', 'claude', '/workspace/project-a', 'Claude 1');
    sessionsDb.createSession('claude-2', 'claude', '/workspace/project-a', 'Claude 2');
    sessionsDb.createSession('codex-archived', 'codex', '/workspace/project-a', 'Codex archived');
    sessionsDb.updateSessionIsArchived('codex-archived', true);
    sessionsDb.createSession('cursor-hidden-project', 'cursor', '/workspace/project-hidden', 'Cursor');
    projectsDb.updateProjectIsArchived('/workspace/project-hidden', true);

    const counts = Object.fromEntries(
      sessionsDb.countSessionsByProvider().map(({ provider, count }) => [provider, count]),
    );
    assert.deepEqual(counts, { claude: 2, codex: 1, cursor: 1 });
  });
});
