import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyClaudePinnedModels,
  extractClaudeEventModel,
  extractClaudeRequestedModel,
  mapClaudeModelToCatalogValue,
  readClaudeSessionModelFromJsonl,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

const PINNED_ENV = {
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
  ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'claude-opus-5-5-kiro',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8[1M]',
  ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'claude-opus-5-5',
};

const writeTranscript = async (rows: unknown[]): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-model-tail-'));
  const file = path.join(directory, 'session.jsonl');
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return file;
};

test('reads what Claude Code requested, not the name a gateway answered with', async () => {
  const catalog = applyClaudePinnedModels(PINNED_ENV);
  const file = await writeTranscript([
    { type: 'attachment', sessionId: SESSION_ID, attachment: { type: 'model', identity: { modelId: 'claude-fable-5' } } },
    { type: 'api-request', sessionId: SESSION_ID, params: { model: 'claude-fable-5' } },
    { type: 'assistant', sessionId: SESSION_ID, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } },
  ]);

  assert.deepEqual(await readClaudeSessionModelFromJsonl(SESSION_ID, file, catalog, PINNED_ENV), { model: 'fable' });
});

test('a reply model the picker does not offer is no answer at all', async () => {
  const catalog = applyClaudePinnedModels(PINNED_ENV);
  const file = await writeTranscript([
    { type: 'assistant', sessionId: SESSION_ID, message: { model: 'claude-opus-5-5', content: [] } },
  ]);

  assert.equal(await readClaudeSessionModelFromJsonl(SESSION_ID, file, catalog, PINNED_ENV), null);
});

test('a reply model that is a pinned id still maps back to its alias', async () => {
  const catalog = applyClaudePinnedModels(PINNED_ENV);
  const file = await writeTranscript([
    { type: 'assistant', sessionId: SESSION_ID, message: { model: 'claude-opus-4-8', content: [] } },
  ]);

  assert.deepEqual(await readClaudeSessionModelFromJsonl(SESSION_ID, file, catalog, PINNED_ENV), { model: 'opus' });
});

test('the newest request wins, across chunk boundaries and multi-byte text', async () => {
  const catalog = applyClaudePinnedModels(PINNED_ENV);
  const filler = '模'.repeat(200_000);
  const file = await writeTranscript([
    { type: 'api-request', sessionId: SESSION_ID, params: { model: 'claude-opus-4-8[1M]' } },
    { type: 'user', sessionId: SESSION_ID, message: { content: filler } },
    { type: 'api-request', sessionId: SESSION_ID, params: { model: 'claude-fable-5' } },
    { type: 'user', sessionId: SESSION_ID, message: { content: filler } },
  ]);

  assert.deepEqual(await readClaudeSessionModelFromJsonl(SESSION_ID, file, catalog, PINNED_ENV), { model: 'fable' });
});

test('maps a pinned id or an id in parentheses to the picker value', () => {
  const catalog = applyClaudePinnedModels(PINNED_ENV);
  assert.equal(mapClaudeModelToCatalogValue('claude-fable-5', catalog, PINNED_ENV), 'fable');
  assert.equal(mapClaudeModelToCatalogValue('claude-opus-4-8', catalog, PINNED_ENV), 'opus');
  assert.equal(mapClaudeModelToCatalogValue('Fable 5 (claude-fable-5)', catalog, PINNED_ENV), 'fable');
  assert.equal(mapClaudeModelToCatalogValue('sonnet', catalog, PINNED_ENV), 'sonnet');
  assert.equal(mapClaudeModelToCatalogValue('claude-opus-5-5', catalog, PINNED_ENV), null);
  assert.equal(
    extractClaudeRequestedModel({ type: 'api-request', sessionId: 'other', params: { model: 'x' } }, SESSION_ID),
    null,
  );
});
