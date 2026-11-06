import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

for (const command of ['', '  \n\t']) {
  test(`Codex supplies a prompt for an image-only turn (${JSON.stringify(command)})`, async (t) => {
    let capturedPrompt: unknown;
    const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
    const thread = {
      id: 'native-thread',
      async runStreamed(prompt: unknown) {
        capturedPrompt = prompt;
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
        })() };
      },
    } as unknown as Thread;

    t.mock.method(Codex.prototype, 'startThread', () => thread);
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    };

    await codexRuntime.run(command, {
      cwd: process.cwd(),
      images: [{ path: imagePath, mimeType: 'image/png' }],
    }, { isWebSocketWriter: true, send: () => {} }, context);

    assert.deepEqual(capturedPrompt, [
      { type: 'text', text: 'Please analyze the attached image(s).' },
      { type: 'local_image', path: imagePath },
    ]);
  });
}

function createContext(overrides: Partial<ProviderRuntimeContext> = {}): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

test('a Codex run stopped while it was being set up never starts a thread', async (t) => {
  const start = t.mock.method(Codex.prototype, 'startThread', () => {
    throw new Error('must not start');
  });
  const messages: Array<Record<string, unknown>> = [];
  const stop = new AbortController();
  stop.abort();

  await codexRuntime.run('hey there', {
    sessionId: 'app-stopped-early',
    cwd: process.cwd(),
    stopSignal: stop.signal,
  }, { isWebSocketWriter: true, send: (message) => messages.push(message as Record<string, unknown>) }, createContext());

  assert.equal(start.mock.callCount(), 0);
  assert.ok(!messages.some((message) => message.kind === 'complete'), 'the gateway reports the stop');
});

test('a stop reaches a running Codex turn, and a finished one has nothing left to stop', async (t) => {
  let releaseEvents: () => void = () => {};
  const eventsReleased = new Promise<void>((resolve) => { releaseEvents = resolve; });
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'native-thread' };
        await eventsReleased;
        yield { type: 'turn.completed', usage: {} };
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);
  const messages: Array<Record<string, unknown>> = [];
  const writer = { isWebSocketWriter: true, send: (message: unknown) => messages.push(message as Record<string, unknown>) };

  const stop = new AbortController();
  const stoppedRun = codexRuntime.run('first', { sessionId: 'app-codex-stop', cwd: process.cwd(), stopSignal: stop.signal }, writer, createContext());
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  stop.abort();
  releaseEvents();
  await stoppedRun;
  assert.ok(!messages.some((message) => message.kind === 'complete'), 'a stopped turn sends no complete of its own');
  assert.equal(codexRuntime.abort('app-codex-stop'), false, 'the stopped run left no entry behind');

  const finishedRun = codexRuntime.run('second', { sessionId: 'app-codex-stop', cwd: process.cwd() }, writer, createContext());
  await finishedRun;
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 0));
  assert.equal(codexRuntime.abort('app-codex-stop'), false, 'a completed turn reports nothing stopped');
});

test('a live Codex tool result is capped like the history copy before it is sent', async (t) => {
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'native-thread' };
        yield {
          type: 'item.completed',
          item: { id: 'item_0', type: 'command_execution', command: 'cat big.log', aggregated_output: 'x'.repeat(100_000), status: 'completed', exit_code: 0 },
        };
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);
  const messages: Array<Record<string, unknown>> = [];

  await codexRuntime.run('hey there', { sessionId: 'app-codex-cap', cwd: process.cwd() }, {
    isWebSocketWriter: true,
    send: (message) => messages.push(message as Record<string, unknown>),
  }, createContext({
    normalizeMessage: (raw) => (raw as Record<string, unknown>).type === 'item'
      ? [{ id: 'item_0_result', kind: 'tool_result', toolId: 'item_0', content: 'x'.repeat(100_000) } as never]
      : [],
  }));

  const live = messages.find((message) => message.kind === 'tool_result');
  assert.ok(typeof live?.content === 'string', 'the result was sent');
  assert.ok(live.content.length < 41_000, `sent ${live.content.length} characters`);
});
