import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionTitleProvider } from '@/modules/providers/list/claude/claude-session-title.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { findFilesRecursivelyChangedAfter } from '@/shared/utils.js';

/**
 * A session name is shared with the CLI it belongs to: a rename in Claude Code
 * or Codex reaches CloudCLI, and a rename in CloudCLI is written where the CLI
 * reads it. The provider's own name wins over the one in CloudCLI's index.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-rename-db-'));

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

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

// The SDK refuses ids that are not UUIDs, as Claude's own are.
const SESSION_ID = '6f1c2b8e-3a4d-4e5f-9a1b-2c3d4e5f6a7b';

async function writeClaudeTranscript(home: string, extraLines: object[] = []): Promise<string> {
  const projectDir = path.join(home, '.claude', 'projects', '-workspace-demo');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(home, '.claude', 'history.jsonl'), '', 'utf8');
  const filePath = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1', cwd: '/workspace/demo', sessionId: SESSION_ID },
    { type: 'ai-title', aiTitle: 'Generated title', sessionId: SESSION_ID },
    ...extraLines,
  ];
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return filePath;
}

test('a /rename made in Claude replaces the name CloudCLI already stored', { concurrency: false }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-rename-in-cli-'));
  const restoreHomeDir = patchHomeDir(home);
  try {
    const filePath = await writeClaudeTranscript(home, [
      { type: 'custom-title', customTitle: 'Renamed in Claude', sessionId: SESSION_ID },
    ]);

    await withIsolatedDatabase(async () => {
      // One row found on disk, one created by CloudCLI and mapped to the transcript later.
      sessionsDb.createSession(SESSION_ID, 'claude', '/workspace/demo', 'Name CloudCLI picked first');
      const synchronizer = new ClaudeSessionSynchronizer();
      const rowId = await synchronizer.synchronizeFile(filePath);
      assert.equal(sessionsDb.getSessionById(rowId!)?.custom_name, 'Renamed in Claude');
    });

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo', 'Started in CloudCLI');
      sessionsDb.assignProviderSessionId('app-1', SESSION_ID);
      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Renamed in Claude');
    });
  } finally {
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('a Claude session with no /rename takes the title Claude generated, as Claude Code shows it', { concurrency: false }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-no-rename-'));
  const restoreHomeDir = patchHomeDir(home);
  try {
    const filePath = await writeClaudeTranscript(home);
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo', 'Started in CloudCLI');
      sessionsDb.assignProviderSessionId('app-1', SESSION_ID);
      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Generated title');
    });
  } finally {
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('a Claude session with no title yet keeps the name CloudCLI stored', { concurrency: false }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-no-title-yet-'));
  const restoreHomeDir = patchHomeDir(home);
  try {
    const filePath = await writeClaudeTranscript(home);
    const firstLine = (await readFile(filePath, 'utf8')).split('\n')[0];
    await writeFile(filePath, `${firstLine}\n`, 'utf8');
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'claude', '/workspace/demo', 'Started in CloudCLI');
      sessionsDb.assignProviderSessionId('app-1', SESSION_ID);
      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Started in CloudCLI');
    });
  } finally {
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('a CloudCLI rename is written to the Claude transcript without moving its modified time', { concurrency: false }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-write-title-'));
  const restoreHomeDir = patchHomeDir(home);
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  try {
    const filePath = await writeClaudeTranscript(home, [
      { type: 'custom-title', customTitle: 'Old name', sessionId: SESSION_ID },
      { type: 'agent-name', agentName: 'Old name', sessionId: SESSION_ID },
    ]);
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await utimes(filePath, lastWeek, lastWeek);

    await new ClaudeSessionTitleProvider().setTitle({ providerSessionId: SESSION_ID, jsonlPath: filePath, title: 'Named in CloudCLI' });

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      lines.slice(-2).map((line) => [line.type, line.customTitle ?? line.agentName]),
      [['custom-title', 'Named in CloudCLI'], ['agent-name', 'Named in CloudCLI']],
    );
    assert.equal((await stat(filePath)).mtime.getTime(), lastWeek.getTime());

    // The synchronizer reads the same line back.
    await withIsolatedDatabase(async () => {
      sessionsDb.createSession(SESSION_ID, 'claude', '/workspace/demo', 'Old name');
      await new ClaudeSessionSynchronizer().synchronizeFile(filePath);
      assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, 'Named in CloudCLI');
    });
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('no agent-name line is added to a transcript that never had one', { concurrency: false }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-write-title-plain-'));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  try {
    const filePath = await writeClaudeTranscript(home);
    await new ClaudeSessionTitleProvider().setTitle({ providerSessionId: SESSION_ID, jsonlPath: filePath, title: 'First name' });

    const content = await readFile(filePath, 'utf8');
    assert.equal(content.includes('"agent-name"'), false);
    assert.ok(content.endsWith(`${JSON.stringify({ type: 'custom-title', customTitle: 'First name', sessionId: SESSION_ID })}\n`));
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    await rm(home, { recursive: true, force: true });
  }
});

async function writeCodexHome(home: string, threadId: string, indexLines: object[]): Promise<string> {
  const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '11', '05');
  await mkdir(sessionsDir, { recursive: true });
  const rolloutPath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
  await writeFile(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: '/workspace/demo' } })}\n`, 'utf8');
  await writeFile(
    path.join(home, '.codex', 'session_index.jsonl'),
    indexLines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    'utf8',
  );
  return rolloutPath;
}

test('the latest name in Codex\'s index wins, for discovered and CloudCLI-created sessions', { concurrency: false }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-name-index-'));
  const restoreHomeDir = patchHomeDir(home);
  try {
    await writeCodexHome(home, 'thread-1', [
      { id: 'thread-1', thread_name: 'First name', updated_at: '2026-11-01T00:00:00Z' },
      { id: 'thread-1', thread_name: 'Renamed in Codex', updated_at: '2026-11-05T00:00:00Z' },
    ]);

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Started in CloudCLI');
      sessionsDb.assignProviderSessionId('app-1', 'thread-1');

      await new CodexSessionSynchronizer().synchronize();
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Renamed in Codex');
    });
  } finally {
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('synchronizeNames applies an index change and reports only the sessions it renamed', { concurrency: false }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-name-sync-'));
  const restoreHomeDir = patchHomeDir(home);
  try {
    const indexPath = path.join(home, '.codex', 'session_index.jsonl');
    await writeCodexHome(home, 'thread-1', [{ id: 'thread-1', thread_name: 'Before', updated_at: '' }]);

    await withIsolatedDatabase(async () => {
      sessionsDb.createSession('thread-1', 'codex', '/workspace/demo', 'Before');
      sessionsDb.createSession('thread-2', 'codex', '/workspace/demo', 'Not in the index');
      const synchronizer = new CodexSessionSynchronizer();

      assert.deepEqual(await synchronizer.synchronizeNames(), []);

      await writeFile(indexPath, `${JSON.stringify({ id: 'thread-1', thread_name: 'After', updated_at: '' })}\n`, { flag: 'a' });
      assert.deepEqual(await synchronizer.synchronizeNames(), ['thread-1']);
      assert.equal(sessionsDb.getSessionById('thread-1')?.custom_name, 'After');
      assert.equal(sessionsDb.getSessionById('thread-2')?.custom_name, 'Not in the index');
    });
  } finally {
    restoreHomeDir();
    await rm(home, { recursive: true, force: true });
  }
});

test('a CloudCLI rename names the Codex thread first and fails without touching the index if that fails', { concurrency: false }, async () => {
  const realSetThreadName = codexAppServer.setThreadName;
  const calls: unknown[] = [];
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Started in CloudCLI');
      sessionsDb.assignProviderSessionId('app-1', 'thread-1');

      codexAppServer.setThreadName = async (input) => {
        calls.push(input);
      };
      await sessionsService.renameSessionById('app-1', 'Named in CloudCLI');
      assert.deepEqual(calls, [{ threadId: 'thread-1', name: 'Named in CloudCLI' }]);
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Named in CloudCLI');

      codexAppServer.setThreadName = async () => {
        throw new Error('app-server exited');
      };
      await assert.rejects(
        sessionsService.renameSessionById('app-1', 'Never saved'),
        (error: { code?: string }) => error.code === 'SESSION_RENAME_FAILED',
      );
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Named in CloudCLI');
    });
  } finally {
    codexAppServer.setThreadName = realSetThreadName;
  }
});

test('a session that has not run yet is renamed in the index only', { concurrency: false }, async () => {
  const realSetThreadName = codexAppServer.setThreadName;
  let called = false;
  codexAppServer.setThreadName = async () => {
    called = true;
  };
  try {
    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-1', 'codex', '/workspace/demo', 'Started in CloudCLI');
      await sessionsService.renameSessionById('app-1', 'Renamed before the first run');
      assert.equal(called, false);
      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Renamed before the first run');
    });
  } finally {
    codexAppServer.setThreadName = realSetThreadName;
  }
});

test('the incremental scan picks up transcripts written after the last scan, not only new ones', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'changed-after-'));
  try {
    const untouched = path.join(root, 'untouched.jsonl');
    const written = path.join(root, 'written.jsonl');
    await writeFile(untouched, '{}\n');
    await writeFile(written, '{}\n');
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(untouched, longAgo, longAgo);

    // Both files are created before this boundary; only `written` is then
    // given a modified time after it.
    const lastScanAt = new Date(Date.now() + 60 * 1000);
    const later = new Date(Date.now() + 120 * 1000);
    await utimes(written, later, later);

    assert.deepEqual(await findFilesRecursivelyChangedAfter(root, '.jsonl', lastScanAt), [written]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
