import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * Who hears a run, and what a stop reports: runs no socket started, stops that
 * land before the runtime has anything to interrupt, work that outlives the
 * run's `complete`, and the run id that scopes every replay position.
 */

const SESSION_ID = 'delivery-session';
const OTHER_SESSION_ID = 'other-delivery-session';

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type Writer = { send: (data: unknown) => void };
type RunHandler = (options: Record<string, unknown>, writer: Writer) => Promise<void>;

function createRuntime(overrides: {
  run?: RunHandler;
  abort?: () => Promise<boolean>;
  hasBackgroundWork?: (sessionId: string) => boolean;
} = {}) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork: overrides.hasBackgroundWork ?? (() => false),
    getPendingApprovalsForSession: () => [],
    run: async (_provider: string, _command: string, options: Record<string, unknown>, writer: Writer) => {
      await overrides.run?.(options, writer);
    },
    abort: overrides.abort ?? (async () => true),
  };
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-run-delivery-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory);
    sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', tempDirectory);
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function connect(socket: FakeSocket, runtime: ReturnType<typeof createRuntime>): void {
  handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

function subscribe(socket: FakeSocket, sessions: Array<Record<string, unknown>>): void {
  socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions }));
}

function framesOfKind(socket: FakeSocket, kind: string): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => frame.kind === kind);
}

test('a tab viewing a session receives a run of it that no socket started', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createRuntime({
      run: async (_options, writer) => {
        writer.send({ kind: 'text', provider: 'claude', sessionId: 'native-1', content: 'from the queue' });
        writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0 });
      },
    });
    const viewer = createFakeSocket();
    const elsewhere = createFakeSocket();
    connect(viewer, runtime);
    connect(elsewhere, runtime);
    subscribe(viewer, [{ sessionId: SESSION_ID }]);
    subscribe(elsewhere, [{ sessionId: OTHER_SESSION_ID }]);
    await settle();

    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'queued turn' },
      { runtime: runtime as never },
    );
    assert.equal(result.started, true);
    await result.finished;

    assert.deepEqual(framesOfKind(viewer, 'text').map((frame) => frame.content), ['from the queue']);
    assert.equal(framesOfKind(viewer, 'complete').length, 1);
    assert.equal(framesOfKind(elsewhere, 'text').length, 0, 'a tab on another session hears nothing');
  });
});

test('a closed tab, or one that moved to another session, is not handed new runs', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createRuntime({
      run: async (_options, writer) => {
        writer.send({ kind: 'text', provider: 'claude', sessionId: 'native-1', content: 'hello' });
      },
    });
    const moved = createFakeSocket();
    const closed = createFakeSocket();
    connect(moved, runtime);
    connect(closed, runtime);
    subscribe(moved, [{ sessionId: SESSION_ID }]);
    subscribe(closed, [{ sessionId: SESSION_ID }]);
    await settle();
    subscribe(moved, [{ sessionId: OTHER_SESSION_ID }]);
    closed.emit('close');
    await settle();

    const result = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'queued turn' },
      { runtime: runtime as never },
    );
    await result.finished;

    assert.equal(framesOfKind(moved, 'text').length, 0);
    assert.equal(framesOfKind(closed, 'text').length, 0);
  });
});

test('a stop while the runtime is still setting up keeps the turn from starting and is reported once', async () => {
  await withIsolatedDatabase(async () => {
    let reachSetupEnd: () => void = () => {};
    const setupEnd = new Promise<void>((resolve) => { reachSetupEnd = resolve; });
    let turnStarted = false;
    let runtimeReturned = false;
    const runtime = createRuntime({
      run: async (options) => {
        // Stands in for the awaits before a runtime creates its query.
        await setupEnd;
        if (!(options.stopSignal as AbortSignal).aborted) {
          turnStarted = true;
        }
        runtimeReturned = true;
      },
      // Nothing is registered yet, so the runtime has nothing to stop.
      abort: async () => false,
    });
    const socket = createFakeSocket();
    connect(socket, runtime);
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'go' }));
    await settle();

    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.equal(framesOfKind(socket, 'complete').length, 0, 'not reported stopped before anything stopped');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);

    reachSetupEnd();
    await settle();
    assert.equal(runtimeReturned, true);
    assert.equal(turnStarted, false);
    const completes = framesOfKind(socket, 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('a stop the runtime carried out is reported straight away', async () => {
  await withIsolatedDatabase(async () => {
    let finishRun: () => void = () => {};
    const runtime = createRuntime({
      run: () => new Promise<void>((resolve) => { finishRun = resolve; }),
      abort: async () => true,
    });
    const socket = createFakeSocket();
    connect(socket, runtime);
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'go' }));
    await settle();

    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    const completes = framesOfKind(socket, 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);

    finishRun();
    await settle();
    assert.equal(framesOfKind(socket, 'complete').length, 1, 'the run ending later adds no second complete');
  });
});

test('a stop after the run completed reaches the runtime while it still holds work', async () => {
  await withIsolatedDatabase(async () => {
    let holding = true;
    const aborts: string[] = [];
    const runtime = createRuntime({
      run: async (_options, writer) => {
        writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native-1', exitCode: 0 });
      },
      hasBackgroundWork: (sessionId) => sessionId === SESSION_ID && holding,
      abort: async () => {
        aborts.push(SESSION_ID);
        holding = false;
        return true;
      },
    });
    const sender = createFakeSocket();
    const otherTab = createFakeSocket();
    connect(sender, runtime);
    connect(otherTab, runtime);
    sender.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'wake me later' }));
    await settle();
    subscribe(otherTab, [{ sessionId: SESSION_ID }]);
    await settle();
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    sender.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(aborts, [SESSION_ID]);
    for (const socket of [sender, otherTab]) {
      const completes = framesOfKind(socket, 'complete');
      assert.equal(completes.at(-1)?.aborted, true, 'every watcher hears the stop');
    }
    assert.equal(framesOfKind(sender, 'protocol_error').length, 0);

    // Nothing is held any more, so a second stop has nothing to stop.
    sender.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();
    assert.equal(framesOfKind(sender, 'protocol_error')[0]?.code, 'NO_ACTIVE_RUN');
    assert.deepEqual(aborts, [SESSION_ID]);
  });
});

test('a stop after the run was evicted still reaches the runtime and answers the tab', async () => {
  await withIsolatedDatabase(async () => {
    const runtime = createRuntime({
      hasBackgroundWork: (sessionId) => sessionId === SESSION_ID,
      abort: async () => true,
    });
    const socket = createFakeSocket();
    connect(socket, runtime);
    socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_ID }));
    await settle();

    const completes = framesOfKind(socket, 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.aborted, true);
    assert.equal(completes[0]?.sessionId, SESSION_ID);
  });
});

test('events and the subscribe ack carry the run id that scopes their seq', async () => {
  await withIsolatedDatabase(async () => {
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
    });
    assert.ok(run);
    for (const content of ['one', 'two', 'three']) {
      run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'native-1', content });
    }

    const runtime = createRuntime();

    // Same run, seen up to seq 2: only the third event is replayed.
    const caughtUp = createFakeSocket();
    connect(caughtUp, runtime);
    subscribe(caughtUp, [{ sessionId: SESSION_ID, lastSeq: 2, runId: run.runId }]);
    await settle();
    assert.equal(caughtUp.frames[0]?.kind, 'chat_subscribed');
    assert.equal(caughtUp.frames[0]?.runId, run.runId);
    assert.deepEqual(framesOfKind(caughtUp, 'text').map((frame) => [frame.content, frame.runId]), [['three', run.runId]]);

    // A position in an earlier run says nothing about this one: replay all of it.
    const stale = createFakeSocket();
    connect(stale, runtime);
    subscribe(stale, [{ sessionId: SESSION_ID, lastSeq: 2, runId: 'an-earlier-run' }]);
    await settle();
    assert.deepEqual(framesOfKind(stale, 'text').map((frame) => frame.content), ['one', 'two', 'three']);
  });
});
