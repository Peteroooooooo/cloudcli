import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { findFilesRecursivelyChangedAfter } from '@/shared/utils.js';

/**
 * The incremental scan only looks at files written since the last scan, which
 * misses a transcript that is moved back into place with its old modified time
 * (a Codex thread unarchived). A scan therefore also takes every transcript the
 * index does not hold yet.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-unindexed-db-'));

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
  const home = await mkdtemp(path.join(os.tmpdir(), 'session-unindexed-home-'));
  const original = os.homedir;
  (os as any).homedir = () => home;
  try {
    await runTest(home);
  } finally {
    (os as any).homedir = original;
    await rm(home, { recursive: true, force: true });
  }
}

/** Counts the read streams opened on each file while `run` runs. */
async function countReads(run: () => Promise<void>): Promise<(filePath: string) => number> {
  const reads = new Map<string, number>();
  const original = fs.createReadStream;
  (fs as any).createReadStream = (filePath: fs.PathLike, ...rest: unknown[]) => {
    const key = path.resolve(String(filePath));
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return (original as any).call(fs, filePath, ...rest);
  };
  try {
    await run();
  } finally {
    (fs as any).createReadStream = original;
  }
  return (filePath) => reads.get(path.resolve(filePath)) ?? 0;
}

const LAST_WEEK = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
// The fixtures are created during the test, so their creation time is now; a
// scan cursor ahead of it makes only the modified time and the index matter.
const LAST_SCAN = new Date(Date.now() + 60 * 1000);

async function writeRollout(home: string, folder: string, threadId: string): Promise<string> {
  const directory = path.join(home, '.codex', folder, ...(folder === 'sessions' ? ['2026', '10', '30'] : []));
  await mkdir(directory, { recursive: true });
  const rolloutPath = path.join(directory, `rollout-${threadId}.jsonl`);
  await writeFile(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: '/workspace/demo' } })}\n`);
  await utimes(rolloutPath, LAST_WEEK, LAST_WEEK);
  return rolloutPath;
}

test('a scan takes a transcript the index does not hold, however old it is', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'changed-after-unindexed-'));
  try {
    const indexed = path.join(root, 'indexed.jsonl');
    const unindexed = path.join(root, 'nested', 'unindexed.jsonl');
    await mkdir(path.dirname(unindexed), { recursive: true });
    await writeFile(indexed, '{}\n');
    await writeFile(unindexed, '{}\n');
    await utimes(indexed, LAST_WEEK, LAST_WEEK);
    await utimes(unindexed, LAST_WEEK, LAST_WEEK);

    // The path the index holds may differ in case on Windows.
    const indexedPaths = [process.platform === 'win32' ? indexed.toUpperCase() : indexed];
    assert.deepEqual(await findFilesRecursivelyChangedAfter(root, '.jsonl', LAST_SCAN, { indexedPaths }), [unindexed]);
    assert.deepEqual(await findFilesRecursivelyChangedAfter(root, '.jsonl', LAST_SCAN), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file that cannot be stat()ed does not cost the scan the rest of its folder', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'changed-after-stat-'));
  const failing = path.join(root, 'a-unreadable.jsonl');
  const written = path.join(root, 'b-written.jsonl');
  await writeFile(failing, '{}\n');
  await writeFile(written, '{}\n');

  const realStat = fsPromises.stat;
  (fsPromises as any).stat = async (target: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(target)) === failing) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return (realStat as any)(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const found = await findFilesRecursivelyChangedAfter(root, '.jsonl', LAST_WEEK);
    assert.ok(found.includes(written), 'the file after the failing one is still found');
    assert.ok(found.includes(failing), 'the failing one is handed on, since the cursor moves past it');
  } finally {
    (fsPromises as any).stat = realStat;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test('a Codex thread moved back from the archive is indexed again on the next scan; an archived one is not', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    await withIsolatedDatabase(async () => {
      const unarchived = await writeRollout(home, 'sessions', 'thread-back');
      await writeRollout(home, 'archived_sessions', 'thread-archived');
      const synchronizer = new CodexSessionSynchronizer();

      assert.equal(await synchronizer.synchronize(LAST_SCAN), 1);
      assert.equal(sessionsDb.getSessionById('thread-back')?.jsonl_path, unarchived);
      assert.equal(sessionsDb.getSessionById('thread-archived'), null, 'archived_sessions is not indexed');

      // Once indexed, an untouched rollout is not read again.
      assert.equal(await synchronizer.synchronize(LAST_SCAN), 0);
    });
  });
});

test('a Codex rename made while a scan runs is not undone by it', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    await withIsolatedDatabase(async () => {
      await writeRollout(home, 'sessions', 'thread-1');
      const indexPath = path.join(home, '.codex', 'session_index.jsonl');
      await writeFile(indexPath, `${JSON.stringify({ id: 'thread-1', thread_name: 'Before', updated_at: '' })}\n`);

      const synchronizer = new CodexSessionSynchronizer();
      const processSessionFile = (synchronizer as any).processSessionFile.bind(synchronizer);
      (synchronizer as any).processSessionFile = async (...args: unknown[]) => {
        const parsed = await processSessionFile(...args);
        // The rename lands after the scan read the index.
        await writeFile(indexPath, `${JSON.stringify({ id: 'thread-1', thread_name: 'Renamed meanwhile', updated_at: '' })}\n`, { flag: 'a' });
        return parsed;
      };

      await synchronizer.synchronize();
      assert.equal(sessionsDb.getSessionById('thread-1')?.custom_name, 'Renamed meanwhile');
    });
  });
});

const CLAUDE_ID = '6f1c2b8e-3a4d-4e5f-9a1b-2c3d4e5f6a7b';

async function writeClaudeProject(home: string, lines: object[]): Promise<{ transcript: string; subagent: string; history: string }> {
  const projectDir = path.join(home, '.claude', 'projects', '-workspace-demo');
  const transcript = path.join(projectDir, `${CLAUDE_ID}.jsonl`);
  const subagent = path.join(projectDir, CLAUDE_ID, 'subagents', 'agent-1.jsonl');
  const history = path.join(home, '.claude', 'history.jsonl');
  await mkdir(path.dirname(subagent), { recursive: true });
  await writeFile(transcript, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  await writeFile(subagent, `${JSON.stringify({ type: 'user', sessionId: CLAUDE_ID, cwd: '/workspace/demo' })}\n`);
  await writeFile(history, `${JSON.stringify({ display: 'First prompt', sessionId: CLAUDE_ID })}\n`);
  return { transcript, subagent, history };
}

test('the Claude scan reads history.jsonl only for a session it has no name for, and never enters subagents/', { concurrency: false }, async () => {
  await withTempHome(async (home) => {
    const titled = await writeClaudeProject(home, [
      { type: 'user', sessionId: CLAUDE_ID, cwd: '/workspace/demo' },
      { type: 'ai-title', aiTitle: 'Generated title', sessionId: CLAUDE_ID },
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const readsWithTitle = await countReads(async () => {
        await synchronizer.synchronize();
        await synchronizer.synchronizeFile(titled.transcript);
      });
      assert.equal(readsWithTitle(titled.history), 0, 'a titled transcript needs no history');
      assert.equal(readsWithTitle(titled.subagent), 0, 'subagent transcripts are not read');
      assert.equal(sessionsDb.getSessionById(CLAUDE_ID)?.custom_name, 'Generated title');
    });

    await writeFile(titled.transcript, `${JSON.stringify({ type: 'user', sessionId: CLAUDE_ID, cwd: '/workspace/demo' })}\n`);
    await withIsolatedDatabase(async () => {
      const readsUntitled = await countReads(async () => {
        await new ClaudeSessionSynchronizer().synchronize();
      });
      assert.equal(readsUntitled(titled.history), 1);
      assert.equal(sessionsDb.getSessionById(CLAUDE_ID)?.custom_name, 'First prompt');
    });
  });
});
