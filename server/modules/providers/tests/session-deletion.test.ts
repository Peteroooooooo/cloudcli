import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/index.js';
import { codexAppServer, type CodexThreadDeleteOutcome } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { connectedClients } from '@/modules/websocket/index.js';

/**
 * A permanent delete in CloudCLI removes the session from the provider too,
 * so the provider's own session list and resume picker stop offering it.
 * When the provider part fails, the row stays and the delete can be retried.
 *
 * Codex is reached through `codexAppServer`, which every test here replaces:
 * a real app-server would read the real `~/.codex`, whatever `os.homedir`
 * says inside this process.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-delete-db-'));

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

async function withTempHome(runTest: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'session-delete-home-'));
  const original = os.homedir;
  (os as any).homedir = () => home;
  try {
    await runTest(home);
  } finally {
    (os as any).homedir = original;
    await rm(home, { recursive: true, force: true });
  }
}

function replaceDeleteThread(
  replacement: (threadId: string) => Promise<CodexThreadDeleteOutcome>,
): () => void {
  const real = codexAppServer.deleteThread;
  codexAppServer.deleteThread = replacement;
  return () => {
    codexAppServer.deleteThread = real;
  };
}

const CLAUDE_ID = '6f1c2b8e-3a4d-4e5f-9a1b-2c3d4e5f6a7b';
const OTHER_CLAUDE_ID = '0a0b0c0d-1111-4222-8333-444455556666';

/** A Claude session with everything Claude keeps beside its transcript. */
async function writeClaudeSession(home: string, sessionId: string): Promise<{ transcript: string; sideFolders: string[] }> {
  const claudeHome = path.join(home, '.claude');
  const projectDir = path.join(claudeHome, 'projects', '-workspace-demo');
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  const sideFolders = [
    path.join(projectDir, sessionId),
    path.join(claudeHome, 'file-history', sessionId),
    path.join(claudeHome, 'session-env', sessionId),
  ];
  await mkdir(path.join(sideFolders[0], 'subagents'), { recursive: true });
  await writeFile(path.join(sideFolders[0], 'subagents', 'agent-1.jsonl'), '{}\n');
  await mkdir(sideFolders[1], { recursive: true });
  await writeFile(path.join(sideFolders[1], 'snapshot@v1'), 'old file');
  await mkdir(sideFolders[2], { recursive: true });
  await writeFile(transcript, `${JSON.stringify({ type: 'user', sessionId, cwd: '/workspace/demo' })}\n`);
  return { transcript, sideFolders };
}

test('deleting a Claude session removes its transcript and the folders Claude keeps for it, nothing else', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const target = await writeClaudeSession(home, CLAUDE_ID);
    const other = await writeClaudeSession(home, OTHER_CLAUDE_ID);
    const history = path.join(home, '.claude', 'history.jsonl');
    await writeFile(history, `${JSON.stringify({ display: 'hi', sessionId: CLAUDE_ID })}\n`);

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(CLAUDE_ID, 'claude', '/workspace/demo', 'Target', undefined, undefined, target.transcript);
      sessionsDb.createSession(OTHER_CLAUDE_ID, 'claude', '/workspace/demo', 'Other', undefined, undefined, other.transcript);

      const result = await sessionsService.deleteOrArchiveSessionById(CLAUDE_ID, { force: true, deletedFromDisk: true });

      assert.equal(result.action, 'deleted');
      assert.equal(sessionsDb.getSessionById(CLAUDE_ID), null);
      for (const removed of [target.transcript, ...target.sideFolders]) {
        assert.equal(existsSync(removed), false, `${removed} is gone`);
      }
      for (const kept of [other.transcript, ...other.sideFolders, history]) {
        assert.equal(existsSync(kept), true, `${kept} is kept`);
      }
      assert.ok(sessionsDb.getSessionById(OTHER_CLAUDE_ID));
    });
  });
});

test('deleting a Codex session deletes its thread and every thread it was edited off', { concurrency: false }, async () => {
  const deleted: string[] = [];
  const restore = replaceDeleteThread(async (threadId) => {
    deleted.push(threadId);
    return 'deleted';
  });
  try {
    await withTempHome(async (home) => {
      const rollout = path.join(home, '.codex', 'sessions', '2026', '11', '06', 'rollout-thread-2.jsonl');
      await mkdir(path.dirname(rollout), { recursive: true });
      await writeFile(rollout, '{}\n');

      await withIsolatedDatabase(async () => {
        sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Edited twice');
        sessionsDb.assignProviderSessionId('app-1', 'thread-2');
        sessionsDb.markProviderSessionSuperseded({ providerSessionId: 'thread-1', provider: 'codex', sessionId: 'app-1', jsonlPath: null });
        sessionsDb.markProviderSessionSuperseded({ providerSessionId: 'thread-0', provider: 'codex', sessionId: 'app-1', jsonlPath: null });
        // The indexer pointing the row at its rollout.
        sessionsDb.createSession('thread-2', 'codex', '/workspace/demo', undefined, undefined, undefined, rollout);

        await sessionsService.deleteOrArchiveSessionById('app-1', { force: true, deletedFromDisk: true });

        assert.deepEqual(deleted.sort(), ['thread-0', 'thread-1', 'thread-2']);
        assert.equal(existsSync(rollout), false);
        assert.equal(sessionsDb.getSessionById('app-1'), null);
        assert.equal(sessionsDb.isProviderSessionSuperseded('thread-1', 'codex'), false);
      });
    });
  } finally {
    restore();
  }
});

test('a Codex session whose thread could not be deleted keeps its row, so the delete can be retried', { concurrency: false }, async () => {
  let failing = true;
  const restore = replaceDeleteThread(async () => {
    if (failing) {
      throw new Error('codex app-server exited (code 1, signal null)');
    }
    return 'absent';
  });
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Kept');
      sessionsDb.assignProviderSessionId('app-1', 'thread-1');
      sessionsDb.markProviderSessionSuperseded({ providerSessionId: 'thread-0', provider: 'codex', sessionId: 'app-1', jsonlPath: null });

      await assert.rejects(
        sessionsService.deleteOrArchiveSessionById('app-1', { force: true, deletedFromDisk: true }),
        (error: { code?: string; statusCode?: number; message?: string }) =>
          error.code === 'SESSION_DELETE_FAILED'
          && error.statusCode === 502
          && Boolean(error.message?.includes('app-server exited')),
      );
      assert.ok(sessionsDb.getSessionById('app-1'));
      assert.equal(sessionsDb.isProviderSessionSuperseded('thread-0', 'codex'), true);

      // A thread Codex no longer has counts as deleted.
      failing = false;
      await sessionsService.deleteOrArchiveSessionById('app-1', { force: true, deletedFromDisk: true });
      assert.equal(sessionsDb.getSessionById('app-1'), null);
    });
  } finally {
    restore();
  }
});

test('archiving leaves the provider alone', { concurrency: false }, async () => {
  let called = false;
  const restore = replaceDeleteThread(async () => {
    called = true;
    return 'deleted';
  });
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Archived');
      sessionsDb.assignProviderSessionId('app-1', 'thread-1');

      const result = await sessionsService.deleteOrArchiveSessionById('app-1');

      assert.equal(result.action, 'archived');
      assert.equal(called, false);
      assert.equal(sessionsDb.getSessionById('app-1')?.isArchived, 1);
    });
  } finally {
    restore();
  }
});

test('a project is deleted only once every one of its sessions is gone from its provider', { concurrency: false }, async () => {
  const restore = replaceDeleteThread(async () => {
    throw new Error('thread is attached to another thread');
  });
  try {
    await withTempHome(async (home) => {
      const claude = await writeClaudeSession(home, CLAUDE_ID);
      await withIsolatedDatabase(async () => {
        sessionsDb.createSession(CLAUDE_ID, 'claude', '/workspace/demo', 'Claude', undefined, undefined, claude.transcript);
        sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Codex');
        sessionsDb.assignProviderSessionId('app-1', 'thread-1');
        const project = projectsDb.getProjectPath('/workspace/demo')!;

        await assert.rejects(
          deleteOrArchiveProject(project.project_id, true),
          (error: { code?: string }) => error.code === 'PROJECT_DELETE_INCOMPLETE',
        );

        assert.equal(sessionsDb.getSessionById(CLAUDE_ID), null, 'the session that could go is gone');
        assert.equal(existsSync(claude.transcript), false);
        assert.ok(sessionsDb.getSessionById('app-1'), 'the one that failed is kept');
        assert.ok(projectsDb.getProjectById(project.project_id), 'and so is its project');
      });
    });
  } finally {
    restore();
  }
});

test('the old-sessions list has sessions idle for the given days, but not starred projects', { concurrency: false }, async () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('old', 'claude', '/workspace/demo', 'Old', daysAgo(30), daysAgo(9));
    sessionsDb.createSession('older', 'codex', '/workspace/demo', 'Older', daysAgo(30), daysAgo(20));
    sessionsDb.createSession('recent', 'claude', '/workspace/demo', 'Recent', daysAgo(30), daysAgo(2));
    sessionsDb.createSession('starred-old', 'claude', '/workspace/starred', 'Starred', daysAgo(30), daysAgo(40));
    projectsDb.updateProjectIsStarred('/workspace/starred', true);

    const stale = await sessionsService.listStaleSessions(7, now);

    assert.deepEqual(stale.map((session) => session.sessionId), ['older', 'old']);
    assert.equal('isArchived' in stale[1], false);
    assert.equal(stale[1].projectDisplayName, 'demo');
    assert.equal(stale[1].lastActivity, daysAgo(9));

    assert.deepEqual((await sessionsService.listStaleSessions(15, now)).map((session) => session.sessionId), ['older']);
  });
});

/** Two open sockets, so a test can show that a client other than the one that asked is told. */
function connectTwoClients(): { framesOf: (index: number) => Array<Record<string, unknown>>; disconnect: () => void } {
  const frames: Array<Array<Record<string, unknown>>> = [[], []];
  const sockets = frames.map((received) => ({
    readyState: 1,
    send: (data: string) => received.push(JSON.parse(data) as Record<string, unknown>),
  }));
  sockets.forEach((socket) => connectedClients.add(socket as never));
  return {
    framesOf: (index) => frames[index].filter((frame) => frame.kind === 'sessions_removed'),
    disconnect: () => sockets.forEach((socket) => connectedClients.delete(socket as never)),
  };
}

test('every open client is told when a session is deleted', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const target = await writeClaudeSession(home, CLAUDE_ID);
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(CLAUDE_ID, 'claude', '/workspace/demo', 'Target', undefined, undefined, target.transcript);
      const clients = connectTwoClients();
      try {
        await sessionsService.deleteOrArchiveSessionById(CLAUDE_ID, { force: true, deletedFromDisk: true });
      } finally {
        clients.disconnect();
      }

      for (const index of [0, 1]) {
        assert.equal(clients.framesOf(index).length, 1, `socket ${index} is told once`);
        assert.deepEqual(clients.framesOf(index)[0].sessionIds, [CLAUDE_ID]);
        assert.deepEqual(clients.framesOf(index)[0].projectIds, []);
      }
    });
  });
});

test('every open client is told which sessions a project delete took, and the project', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const first = await writeClaudeSession(home, CLAUDE_ID);
    const second = await writeClaudeSession(home, OTHER_CLAUDE_ID);
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(CLAUDE_ID, 'claude', '/workspace/demo', 'First', undefined, undefined, first.transcript);
      sessionsDb.createSession(OTHER_CLAUDE_ID, 'claude', '/workspace/demo', 'Second', undefined, undefined, second.transcript);
      const project = projectsDb.getProjectPath('/workspace/demo')!;
      const clients = connectTwoClients();
      try {
        await deleteOrArchiveProject(project.project_id, true);
      } finally {
        clients.disconnect();
      }

      assert.equal(projectsDb.getProjectById(project.project_id), null);
      for (const index of [0, 1]) {
        const [event] = clients.framesOf(index);
        assert.deepEqual((event.sessionIds as string[]).sort(), [CLAUDE_ID, OTHER_CLAUDE_ID].sort());
        assert.deepEqual(event.projectIds, [project.project_id]);
      }
    });
  });
});

test('a project delete that stops part-way still tells the clients about the sessions that went', { concurrency: false }, async () => {
  const restore = replaceDeleteThread(async () => {
    throw new Error('thread is attached to another thread');
  });
  try {
    await withTempHome(async (home) => {
      const claude = await writeClaudeSession(home, CLAUDE_ID);
      await withIsolatedDatabase(async () => {
        sessionsDb.createSession(CLAUDE_ID, 'claude', '/workspace/demo', 'Claude', undefined, undefined, claude.transcript);
        sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Codex');
        sessionsDb.assignProviderSessionId('app-1', 'thread-1');
        const project = projectsDb.getProjectPath('/workspace/demo')!;
        const clients = connectTwoClients();
        try {
          await assert.rejects(deleteOrArchiveProject(project.project_id, true));
        } finally {
          clients.disconnect();
        }

        const [event] = clients.framesOf(1);
        assert.deepEqual(event.sessionIds, [CLAUDE_ID]);
        assert.deepEqual(event.projectIds, [], 'the project was kept');
      });
    });
  } finally {
    restore();
  }
});
