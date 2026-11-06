import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * Live rows of a turn: a tool card the provider resends as it runs, the
 * history refresh that takes over once the turn is persisted, and a subagent
 * flood that must not push the turn's own rows out.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

let history: NormalizedMessage[] = [];

beforeEach(() => {
  history = [];
  sessionMessages.mockReset();
  sessionMessages.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ data: { messages: history, total: history.length, hasMore: false } }),
  }));
});

afterEach(() => {
  vi.resetModules();
});

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString();

const live = (fields: Partial<NormalizedMessage> & { id: string; kind: NormalizedMessage['kind'] }): NormalizedMessage => ({
  provider: 'codex',
  sessionId: 'session-1',
  timestamp: at(1),
  ...fields,
} as NormalizedMessage);

async function emptyStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
  });
  return view;
}

describe('live tool rows', () => {
  it('replace the row with the same id as the call progresses', async () => {
    const { result } = await emptyStore();

    act(() => {
      result.current.appendRealtime('session-1', live({ id: 'item_0', kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' } }));
      result.current.appendRealtime('session-1', live({ id: 'item_0_result', kind: 'tool_result', toolId: 'item_0', content: 'running' }));
      result.current.appendRealtime('session-1', live({ id: 'item_0_result', kind: 'tool_result', toolId: 'item_0', content: 'passed' }));
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => [message.id, message.content ?? null]),
      [['item_0', null], ['item_0_result', 'passed']],
    );
  });

  it('give way to the transcript once it reaches past them, whatever ids it uses', async () => {
    const { result } = await emptyStore();

    act(() => {
      result.current.appendRealtime('session-1', live({ id: 'item_0', kind: 'tool_use', toolName: 'Bash', timestamp: at(1) }));
      result.current.appendRealtime('session-1', live({ id: 'item_0_result', kind: 'tool_result', toolId: 'item_0', content: 'ok', timestamp: at(2) }));
    });

    // The rollout names the call by its call id, not the CLI's item counter.
    history = [
      live({ id: 'call_abc', kind: 'tool_use', toolName: 'Bash', timestamp: at(1) }),
      live({ id: 'call_abc_result', kind: 'tool_result', toolId: 'call_abc', content: 'ok', timestamp: at(2) }),
      live({ id: 'answer', kind: 'text', role: 'assistant', content: 'done', timestamp: at(3) }),
    ];
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.id),
      ['call_abc', 'call_abc_result', 'answer'],
    );
  });

  it('stay while the transcript has not caught up with them', async () => {
    const { result } = await emptyStore();

    history = [live({ id: 'prompt', kind: 'text', role: 'user', content: 'run the tests', timestamp: at(1) })];
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });
    act(() => {
      result.current.appendRealtime('session-1', live({ id: 'item_0', kind: 'tool_use', toolName: 'Bash', timestamp: at(2) }));
    });
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    assert.deepEqual(
      result.current.getMessages('session-1').map((message) => message.id),
      ['prompt', 'item_0'],
    );
  });
});

describe('live row cap', () => {
  it('keeps the turn\'s own rows when a subagent streams hundreds of its own', async () => {
    const { result } = await emptyStore();

    act(() => {
      result.current.appendRealtime('session-1', live({ id: 'prompt', kind: 'text', role: 'user', content: 'review the repo', provider: 'claude' }));
      result.current.appendRealtime('session-1', live({ id: 'agent', kind: 'tool_use', toolName: 'Agent', provider: 'claude' }));
      for (let index = 0; index < 800; index += 1) {
        result.current.appendRealtime('session-1', live({
          id: `sub_${index}`,
          kind: 'tool_use',
          toolName: 'Read',
          provider: 'claude',
          parentToolUseId: 'agent',
        }));
      }
    });

    const ids = result.current.getMessages('session-1').map((message) => message.id);
    assert.ok(ids.includes('prompt'), 'the prompt is still there');
    assert.ok(ids.includes('agent'), 'the agent card is still there');
    assert.ok(ids.includes('sub_0') && ids.includes('sub_799'));
  });
});
