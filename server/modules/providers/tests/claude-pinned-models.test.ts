import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_PREDEFINED_MODELS,
  applyClaudePinnedModels,
  readClaudeModelEnv,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const labelOf = (catalog: ReturnType<typeof applyClaudePinnedModels>, value: string) =>
  catalog.OPTIONS.find((option) => option.value === value)?.label;

test('keeps the built-in catalog when no alias is pinned', () => {
  assert.equal(applyClaudePinnedModels({}), CLAUDE_PREDEFINED_MODELS);
});

test('labels pinned aliases with their _NAME, or the pinned id without one', () => {
  const catalog = applyClaudePinnedModels({
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5',
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'claude-opus-5-5-kiro',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8[1M]',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'claude-opus-5-5',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
  });

  assert.equal(labelOf(catalog, 'fable'), 'claude-opus-5-5-kiro');
  assert.equal(labelOf(catalog, 'opus'), 'claude-opus-5-5');
  assert.equal(labelOf(catalog, 'haiku'), 'claude-haiku-4-5');
  assert.equal(labelOf(catalog, 'sonnet'), 'Sonnet');
  assert.match(
    catalog.OPTIONS.find((option) => option.value === 'fable')?.description ?? '',
    /claude-fable-5/,
  );
});

test('drops the 1M row of a pinned family only, as Claude Code does', () => {
  const catalog = applyClaudePinnedModels({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8[1M]' });
  const values = catalog.OPTIONS.map((option) => option.value);
  assert.ok(!values.includes('opus[1m]'));
  assert.ok(values.includes('sonnet[1m]'));
  assert.equal(catalog.DEFAULT, CLAUDE_PREDEFINED_MODELS.DEFAULT);
});

test('names both halves of Opus Plan when they are pinned', () => {
  const catalog = applyClaudePinnedModels({
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'claude-opus-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'gemini-3.8-flash',
  });
  assert.equal(labelOf(catalog, 'opusplan'), 'Opus Plan (claude-opus-5-5 → gemini-3.8-flash)');
});

test('reads pinned models from settings.json ahead of the server env', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-claude-models-'));
  const touchedKeys = [
    'CLAUDE_CONFIG_DIR',
    ...Object.keys(process.env).filter((key) => key.startsWith('ANTHROPIC_DEFAULT_')),
  ];
  const previous = Object.fromEntries(touchedKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of touchedKeys) {
      delete process.env[key];
    }
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'from-settings',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: '  Opus via gateway  ',
        ANTHROPIC_AUTH_TOKEN: 'not-a-model-setting',
      },
    }));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'from-process';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'sonnet-from-process';

    assert.deepEqual(await readClaudeModelEnv(), {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'from-settings',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Opus via gateway',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-from-process',
    });
  } finally {
    for (const key of [...touchedKeys, 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL']) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(configDir, { recursive: true, force: true });
  }
});
