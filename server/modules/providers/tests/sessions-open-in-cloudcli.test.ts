import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { connectedClients } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Sessions the user creates or sends to from CloudCLI stay in the sidebar's
 * open list, like a VS Code tab, until the user closes them there, the session
 * is deleted or archived, or a day passes with no activity in it.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (time: number) => new Date(time).toISOString();

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-open-sessions-'));

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

/** Points the Claude process registry at a temporary home holding `records`. */
async function withClaudeCliRegistry(
  records: Array<Record<string, unknown>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-open-registry-'));
  await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
  for (const record of records) {
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', `${String(record.pid)}.json`),
      JSON.stringify(record),
      'utf8',
    );
  }

  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDirectory;
  try {
    await runTest();
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

/** A session indexed from disk whose last message was at `lastActivity`. */
function createSessionActiveAt(sessionId: string, lastActivity: number): void {
  sessionsDb.createSession(sessionId, 'claude', '/tmp/open-project', sessionId, iso(lastActivity - HOUR), iso(lastActivity));
}

const openIds = (now = NOW) => sessionsService.listSessionsOpenInCloudCli(now).map((entry) => entry.sessionId);

test('a session sent to from CloudCLI is open there and stays open after the turn', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    createSessionActiveAt('sent-session', NOW - HOUR);
    createSessionActiveAt('viewed-session', NOW - HOUR);

    sessionsService.markSessionOpenInCloudCli('sent-session', NOW - HOUR);
    // Reading a session is not using it.
    sessionsService.getSessionDetailsById('viewed-session');

    assert.deepEqual(openIds(), ['sent-session']);
    // Nothing about a turn ending touches the mark; reading again changes nothing.
    assert.deepEqual(openIds(), ['sent-session']);
  });
});

test('closing removes only the mark, and sending again re-adds it', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    createSessionActiveAt('tab-session', NOW - HOUR);
    sessionsService.markSessionOpenInCloudCli('tab-session', NOW - HOUR);

    assert.deepEqual(sessionsService.closeSessionInCloudCli('tab-session'), { sessionId: 'tab-session', closed: true });
    assert.deepEqual(openIds(), []);
    assert.ok(sessionsDb.getSessionById('tab-session'), 'the session itself is untouched');
    assert.deepEqual(
      sessionsService.closeSessionInCloudCli('tab-session'),
      { sessionId: 'tab-session', closed: false },
      'closing a closed session is a no-op',
    );

    sessionsService.markSessionOpenInCloudCli('tab-session', NOW);
    assert.deepEqual(openIds(), ['tab-session']);
  });
});

test('a session with no activity for a day drops out, and stays out until sent to again', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    createSessionActiveAt('quiet-session', NOW - 30 * HOUR);
    createSessionActiveAt('busy-elsewhere-session', NOW - 2 * HOUR);
    createSessionActiveAt('just-sent-session', NOW - 40 * HOUR);
    sessionsService.markSessionOpenInCloudCli('quiet-session', NOW - 30 * HOUR);
    // Opened here long ago, but the conversation carried on since.
    sessionsService.markSessionOpenInCloudCli('busy-elsewhere-session', NOW - 30 * HOUR);
    // Sent to an hour ago; the turn has not written anything yet.
    sessionsService.markSessionOpenInCloudCli('just-sent-session', NOW - HOUR);

    assert.deepEqual(openIds().sort(), ['busy-elsewhere-session', 'just-sent-session']);

    // New activity from another program does not reopen a lapsed mark.
    createSessionActiveAt('quiet-session', NOW);
    assert.deepEqual(openIds().sort(), ['busy-elsewhere-session', 'just-sent-session']);

    sessionsService.markSessionOpenInCloudCli('quiet-session', NOW);
    assert.ok(openIds().includes('quiet-session'));
  });
});

test('deleting or archiving a session removes its mark', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    createSessionActiveAt('archived-session', NOW - HOUR);
    createSessionActiveAt('deleted-session', NOW - HOUR);
    createSessionActiveAt('vanished-session', NOW - HOUR);
    for (const sessionId of ['archived-session', 'deleted-session', 'vanished-session']) {
      sessionsService.markSessionOpenInCloudCli(sessionId, NOW - HOUR);
    }

    await sessionsService.deleteOrArchiveSessionById('archived-session');
    await sessionsService.deleteOrArchiveSessionById('deleted-session', { force: true, deletedFromDisk: false });
    // Removed by the watcher when its transcript went away outside the app.
    sessionsDb.deleteSessionById('vanished-session');

    assert.deepEqual(openIds(), []);
    // A restored session is not open again until it is used from here.
    sessionsService.restoreSessionById('archived-session');
    assert.deepEqual(openIds(), []);
  });
});

test('ids without a session row are never marked', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsService.markSessionOpenInCloudCli('no-such-session', NOW);
    assert.deepEqual(openIds(), []);
  });
});

test('every client hears when a session first opens or closes, not on every send', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    createSessionActiveAt('announced-session', NOW - HOUR);
    const frames: Array<Record<string, unknown>> = [];
    const client = {
      readyState: 1,
      send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>),
    } as unknown as RealtimeClientConnection;
    connectedClients.add(client);

    try {
      sessionsService.markSessionOpenInCloudCli('announced-session', NOW - HOUR);
      sessionsService.markSessionOpenInCloudCli('announced-session', NOW);
      sessionsService.closeSessionInCloudCli('announced-session');
      sessionsService.closeSessionInCloudCli('announced-session');

      assert.deepEqual(frames.map((frame) => frame.kind), ['open_sessions_changed', 'open_sessions_changed']);
    } finally {
      connectedClients.delete(client);
    }
  });
});

test('the running-sessions snapshot lists a session open both here and in VS Code in both lists', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('both-places', 'claude', '/tmp/open-project');
    sessionsDb.assignProviderSessionId('both-places', 'claude-native-both-places');
    sessionsService.markSessionOpenInCloudCli('both-places');

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-both-places', status: 'idle', entrypoint: 'claude-vscode', startedAt: 1_000 }],
      async () => {
        const snapshot = await sessionsService.getRunningSessionsSnapshot();
        assert.deepEqual(snapshot.openElsewhere, [{ sessionId: 'both-places', openIn: 'vscode', busy: false }]);
        assert.deepEqual(snapshot.openInCloudCli, [{ sessionId: 'both-places' }]);
      },
    );
  });
});
