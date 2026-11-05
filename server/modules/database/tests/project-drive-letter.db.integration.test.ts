import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { normalizeProjectPath } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'drive-letter-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

test('a Windows drive letter is upper-cased and the rest of the path is kept as given', () => {
  assert.equal(normalizeProjectPath('d:\\Desktop\\NUS study'), 'D:\\Desktop\\NUS study');
  assert.equal(normalizeProjectPath('d:\\Desktop\\nus study\\'), 'D:\\Desktop\\nus study');
  assert.equal(normalizeProjectPath('D:\\Desktop\\NUS study'), 'D:\\Desktop\\NUS study');
  assert.equal(normalizeProjectPath('d:\\'), 'D:\\');
  assert.equal(normalizeProjectPath('\\\\?\\d:\\Desktop'), 'D:\\Desktop');
  assert.equal(normalizeProjectPath('\\\\server\\share\\d'), '\\\\server\\share\\d');
});

test('a folder recorded as d:\\ by one tool and D:\\ by another is one project', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('claude-session', 'claude', 'd:\\Desktop\\NUS study');
    sessionsDb.createSession('codex-session', 'codex', 'D:\\Desktop\\NUS study');

    const paths = getConnection()
      .prepare("SELECT project_path FROM projects WHERE lower(project_path) = lower('D:\\Desktop\\NUS study')")
      .all() as Array<{ project_path: string }>;
    assert.deepEqual(paths.map((row) => row.project_path), ['D:\\Desktop\\NUS study']);
    assert.equal(sessionsDb.getSessionById('claude-session')?.project_path, 'D:\\Desktop\\NUS study');
    assert.equal(sessionsDb.getSessionById('codex-session')?.project_path, 'D:\\Desktop\\NUS study');
  });
});

test('the migration merges projects stored with a lower-case drive letter into the upper-case one', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    db.exec(`
      INSERT INTO users (id, username, password_hash) VALUES (1, 'user', 'x');

      INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived) VALUES
        ('lower-lab', 'd:\\Desktop\\Experiment Lab', NULL, 1, 0),
        ('upper-lab', 'D:\\Desktop\\Experiment Lab', NULL, 0, 0),
        ('lower-nus', 'd:\\Desktop\\NUS study', 'NUS', 0, 1),
        ('upper-nus', 'D:\\Desktop\\NUS study', NULL, 0, 0),
        ('lower-only', 'd:\\Desktop\\Solo', 'Solo name', 1, 0);

      INSERT INTO sessions (session_id, provider, project_path) VALUES
        ('codex-lab', 'codex', 'D:\\Desktop\\Experiment Lab'),
        ('claude-nus', 'claude', 'd:\\Desktop\\NUS study'),
        ('codex-nus', 'codex', 'D:\\Desktop\\NUS study'),
        ('claude-solo', 'claude', 'd:\\Desktop\\Solo');

      INSERT INTO session_drafts (user_id, draft_scope, draft_text) VALUES (1, 'project:lower-nus', 'unsent text');
    `);

    runMigrations(db);

    const projects = db
      .prepare('SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects ORDER BY project_path')
      .all();
    assert.deepEqual(projects, [
      { project_id: 'upper-lab', project_path: 'D:\\Desktop\\Experiment Lab', custom_project_name: null, isStarred: 1, isArchived: 0 },
      { project_id: 'upper-nus', project_path: 'D:\\Desktop\\NUS study', custom_project_name: 'NUS', isStarred: 0, isArchived: 0 },
      { project_id: 'lower-only', project_path: 'D:\\Desktop\\Solo', custom_project_name: 'Solo name', isStarred: 1, isArchived: 0 },
    ]);

    const sessions = db.prepare('SELECT session_id, project_path FROM sessions ORDER BY session_id').all();
    assert.deepEqual(sessions, [
      { session_id: 'claude-nus', project_path: 'D:\\Desktop\\NUS study' },
      { session_id: 'claude-solo', project_path: 'D:\\Desktop\\Solo' },
      { session_id: 'codex-lab', project_path: 'D:\\Desktop\\Experiment Lab' },
      { session_id: 'codex-nus', project_path: 'D:\\Desktop\\NUS study' },
    ]);

    assert.deepEqual(
      db.prepare('SELECT draft_scope, draft_text FROM session_drafts').all(),
      [{ draft_scope: 'project:upper-nus', draft_text: 'unsent text' }],
    );
    assert.equal(projectsDb.getProjectPath('d:\\Desktop\\NUS study')?.project_id, 'upper-nus');

    // Running the migrations again changes nothing.
    runMigrations(db);
    assert.deepEqual(
      db.prepare('SELECT project_id, project_path, custom_project_name, isStarred, isArchived FROM projects ORDER BY project_path').all(),
      projects,
    );
  });
});
