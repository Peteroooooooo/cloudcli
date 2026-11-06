import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

// The watcher resolves its roots from the home directory when its module is
// first imported, so the fixture home has to be in place before that import.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-unarchive-home-'));
const previousEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CHOKIDAR_USEPOLLING: process.env.CHOKIDAR_USEPOLLING,
  DATABASE_PATH: process.env.DATABASE_PATH,
};
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
// Native events instead of the 6 s poll, so the test does not wait on it.
process.env.CHOKIDAR_USEPOLLING = 'false';

const { closeSessionsWatcher, initializeSessionsWatcher } = await import(
  '@/modules/providers/services/sessions-watcher.service.js'
);

process.on('exit', () => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('a Codex thread archived and unarchived while CloudCLI runs leaves and comes back within seconds', { timeout: 60_000 }, async () => {
  const databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-unarchive-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();

  const sessionsDirectory = path.join(fixtureHome, '.codex', 'sessions', '2026', '10', '30');
  const archivedDirectory = path.join(fixtureHome, '.codex', 'archived_sessions');
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(archivedDirectory, { recursive: true });
  const rolloutName = 'rollout-thread-1.jsonl';
  const inSessions = path.join(sessionsDirectory, rolloutName);
  const inArchive = path.join(archivedDirectory, rolloutName);
  await writeFile(inSessions, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd: '/workspace/demo' } })}\n`);
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await utimes(inSessions, lastWeek, lastWeek);

  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };

  try {
    await initializeSessionsWatcher();
    assert.ok(sessionsDb.getSessionById('thread-1'), 'the startup scan indexes the thread');
    // Let the watchers finish their initial walk before files move.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    await rename(inSessions, inArchive);
    await waitFor(() => sessionsDb.getSessionById('thread-1') === null, 15_000);

    await rename(inArchive, inSessions);
    await waitFor(() => sessionsDb.getSessionById('thread-1') !== null, 15_000);
    assert.equal(sessionsDb.getSessionById('thread-1')?.jsonl_path, inSessions);

    assert.deepEqual(
      logged.filter((line) => line.includes('Session synchronization triggered')),
      [],
      'an indexed transcript change is not logged',
    );
  } finally {
    console.log = realLog;
    await closeSessionsWatcher();
    closeConnection();
    await rm(databaseDirectory, { recursive: true, force: true });
    await rm(fixtureHome, { recursive: true, force: true });
  }
});
