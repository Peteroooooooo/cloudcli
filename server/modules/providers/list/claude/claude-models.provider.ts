import { open, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  readObjectRecord,
  readOptionalString,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

/**
 * The aliases a deployment can pin with `ANTHROPIC_DEFAULT_<KEY>_MODEL`, plus
 * the `_NAME` / `_DESCRIPTION` companions Claude Code shows in its own picker
 * when `ANTHROPIC_BASE_URL` points at a gateway.
 */
const CLAUDE_PINNABLE_ALIASES = [
  { alias: 'fable', envKey: 'FABLE', family: 'Fable' },
  { alias: 'opus', envKey: 'OPUS', family: 'Opus' },
  { alias: 'sonnet', envKey: 'SONNET', family: 'Sonnet' },
  { alias: 'haiku', envKey: 'HAIKU', family: 'Haiku' },
] as const;

const CLAUDE_MODEL_ENV_SUFFIXES = ['', '_NAME', '_DESCRIPTION'] as const;

export type ClaudeModelEnv = Partial<Record<string, string>>;

const claudeUserSettingsPath = (): string => {
  const configDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  const baseDirectory = configDirectory && path.isAbsolute(configDirectory)
    ? configDirectory
    : path.join(os.homedir(), '.claude');
  return path.join(baseDirectory, 'settings.json');
};

/**
 * Reads the model-pinning variables the spawned Claude CLI will see. The
 * user's settings.json `env` block wins over the server's own environment,
 * because the CLI applies that block on top of the env it inherits.
 */
export const readClaudeModelEnv = async (): Promise<ClaudeModelEnv> => {
  let settingsEnv: Record<string, unknown> = {};
  try {
    const settings = readObjectRecord(JSON.parse(await readFile(claudeUserSettingsPath(), 'utf8')));
    settingsEnv = readObjectRecord(settings?.env) ?? {};
  } catch {
    // A missing or unreadable settings file leaves only the process env.
  }

  const env: ClaudeModelEnv = {};
  for (const { envKey } of CLAUDE_PINNABLE_ALIASES) {
    for (const suffix of CLAUDE_MODEL_ENV_SUFFIXES) {
      const key = `ANTHROPIC_DEFAULT_${envKey}_MODEL${suffix}`;
      const value = readOptionalString(settingsEnv[key]) ?? readOptionalString(process.env[key]);
      if (value) {
        env[key] = value;
      }
    }
  }
  return env;
};

/**
 * Applies pinned aliases to the built-in catalog the way Claude Code's own
 * `/model` picker does: a pinned alias is labelled with its `_NAME` (or the
 * pinned id), and its family's separate 1M row is dropped because the pinned
 * id already decides the context window.
 */
export const applyClaudePinnedModels = (env: ClaudeModelEnv): ProviderModelsDefinition => {
  const pinned = new Map<string, { name: string; description: string }>();
  for (const { alias, envKey, family } of CLAUDE_PINNABLE_ALIASES) {
    const modelId = env[`ANTHROPIC_DEFAULT_${envKey}_MODEL`];
    if (!modelId) {
      continue;
    }
    pinned.set(alias, {
      name: env[`ANTHROPIC_DEFAULT_${envKey}_MODEL_NAME`] || modelId,
      description: env[`ANTHROPIC_DEFAULT_${envKey}_MODEL_DESCRIPTION`] || `Custom ${family} model (${modelId})`,
    });
  }

  if (pinned.size === 0) {
    return CLAUDE_PREDEFINED_MODELS;
  }

  const options: ProviderModelOption[] = [];
  for (const option of CLAUDE_PREDEFINED_MODELS.OPTIONS) {
    const extendedContextAlias = /^([a-z]+)\[1m\]$/.exec(option.value)?.[1];
    if (extendedContextAlias && pinned.has(extendedContextAlias)) {
      continue;
    }

    const pin = pinned.get(option.value);
    if (pin) {
      options.push({ ...option, label: pin.name, description: pin.description });
      continue;
    }

    if (option.value === 'opusplan' && (pinned.has('opus') || pinned.has('sonnet'))) {
      const planModel = pinned.get('opus')?.name ?? 'Opus';
      const executionModel = pinned.get('sonnet')?.name ?? 'Sonnet';
      options.push({
        ...option,
        label: `Opus Plan (${planModel} → ${executionModel})`,
        description: `Use ${planModel} while planning, then switch to ${executionModel} for execution.`,
      });
      continue;
    }

    options.push(option);
  }

  return { ...CLAUDE_PREDEFINED_MODELS, OPTIONS: options };
};

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

type ClaudeTranscriptRecord = ClaudeInitEvent & {
  attachment?: { type?: string; identity?: { modelId?: string } };
  params?: { model?: string };
};

/**
 * The model Claude Code itself asked for on this line, if the line records one.
 *
 * A reply's `message.model` is whatever the endpoint answered with, and a
 * gateway answers with its own upstream name (`claude-opus-5-5` for a turn
 * requested as `claude-fable-5`). Sending that name back as the session's model
 * routes the next turn somewhere else, so the request side is what counts.
 */
export const extractClaudeRequestedModel = (
  event: ClaudeTranscriptRecord,
  sessionId: string,
): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const requested = event.type === 'attachment' && event.attachment?.type === 'model'
    ? event.attachment.identity?.modelId
    : event.type === 'api-request'
      ? event.params?.model
      : undefined;
  const model = typeof requested === 'string' ? requested.trim() : '';
  return model && !isPlaceholderProviderModel(model) ? model : null;
};

const TRANSCRIPT_TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * Yields a JSONL file's lines newest first, reading it from the end in chunks
 * so a long transcript is not loaded whole to find its last few records.
 */
async function* readJsonlLinesFromEnd(jsonlPath: string): AsyncGenerator<string> {
  const handle = await open(jsonlPath, 'r');
  try {
    let position = (await handle.stat()).size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      const buffer = Buffer.concat([chunk, carry]);
      let end = buffer.length;
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] === 0x0a) {
          const line = buffer.subarray(index + 1, end).toString('utf8').trim();
          if (line) {
            yield line;
          }
          end = index;
        }
      }
      carry = Buffer.from(buffer.subarray(0, end));
    }
    const first = carry.toString('utf8').trim();
    if (first) {
      yield first;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Turns a model id found in a transcript into a value the picker offers.
 *
 * A pinned id maps back to its alias (`claude-fable-5` → `fable`), so the
 * picker selects the row the user knows and the next turn is sent the same
 * way. Returns null for an id the picker does not offer.
 */
export const mapClaudeModelToCatalogValue = (
  model: string,
  catalog: ProviderModelsDefinition,
  env: ClaudeModelEnv,
): string | null => {
  const candidates = [model, ...Array.from(model.matchAll(/\(([^()]+)\)/g), (match) => match[1])]
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const comparable = (value: string) => value.toLowerCase().replace(/\[1m\]$/, '');

  for (const candidate of candidates) {
    const option = catalog.OPTIONS.find((entry) => entry.value === candidate);
    if (option) {
      return option.value;
    }
    for (const { alias, envKey } of CLAUDE_PINNABLE_ALIASES) {
      const pinnedId = env[`ANTHROPIC_DEFAULT_${envKey}_MODEL`];
      if (pinnedId && comparable(pinnedId) === comparable(candidate)
        && catalog.OPTIONS.some((entry) => entry.value === alias)) {
        return alias;
      }
    }
  }
  return null;
};

export const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
  catalog: ProviderModelsDefinition,
  env: ClaudeModelEnv,
): Promise<ProviderCurrentActiveModel | null> => {
  for await (const line of readJsonlLinesFromEnd(jsonlPath)) {
    let event: ClaudeTranscriptRecord;
    try {
      event = JSON.parse(line) as ClaudeTranscriptRecord;
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
      continue;
    }

    const requested = extractClaudeRequestedModel(event, sessionId);
    if (requested) {
      return { model: mapClaudeModelToCatalogValue(requested, catalog, env) ?? requested };
    }

    // Older transcripts record no request, only replies. A reply's model is
    // trusted only when it is something the picker offers.
    const reported = extractClaudeEventModel(event, sessionId);
    const mapped = reported ? mapClaudeModelToCatalogValue(reported, catalog, env) : null;
    if (mapped) {
      return { model: mapped };
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    return applyClaudePinnedModels(await readClaudeModelEnv());
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const env = await readClaudeModelEnv();
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath, applyClaudePinnedModels(env), env)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
