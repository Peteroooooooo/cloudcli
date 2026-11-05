import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

/** Curated Codex catalog shipped as immutable CloudCLI defaults. */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  // Chats run the bundled `@openai/codex` CLI, which takes model metadata from
  // its own bundled catalog (`codex debug models --bundled`), from a slug-prefix
  // match against that catalog, or (signed in to ChatGPT) from OpenAI's remote
  // catalog; anything else runs on fallback metadata. So every entry must be
  // one of the bundled catalog's exact slugs, which codex-models.test.ts checks.
  OPTIONS: [
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: 'Our most capable model for complex, demanding work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      description: 'Latest workhorse model for coding and everyday work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6.1-terra',
      label: 'GPT-6.1 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const readCodexConfig = async (): Promise<Record<string, unknown> | null> => {
  try {
    return readObjectRecord(TOML.parse(await readFile(CODEX_CONFIG_PATH, 'utf8')));
  } catch {
    return null;
  }
};

const readCatalogReasoningLevel = (level: unknown): { value: string; description?: string } | null => {
  if (typeof level === 'string') {
    const value = readOptionalString(level);
    return value ? { value } : null;
  }

  const record = readObjectRecord(level);
  const value = readOptionalString(record?.effort);
  if (!value) {
    return null;
  }
  const description = readOptionalString(record?.description);
  return description ? { value, description } : { value };
};

const toCatalogModelOption = (entry: Record<string, unknown>, slug: string): ProviderModelOption => {
  const levels = (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
    .map(readCatalogReasoningLevel)
    .filter((level): level is { value: string; description?: string } => level !== null);
  const defaultLevel = readOptionalString(entry.default_reasoning_level);
  const description = readOptionalString(entry.description);

  return {
    value: slug,
    label: readOptionalString(entry.display_name) ?? slug,
    ...(description ? { description } : {}),
    ...(levels.length > 0
      ? {
        effort: {
          ...(defaultLevel && levels.some((level) => level.value === defaultLevel) ? { default: defaultLevel } : {}),
          values: levels,
        },
      }
      : {}),
  };
};

/**
 * Turns a Codex `model_catalog_json` file into the picker catalog, in the
 * order and under the names the Codex CLI itself lists. Entries marked
 * `visibility: "hide"` stay out unless config.toml selects one of them.
 * Returns null when the file holds no usable model, so the caller falls back
 * to the built-in list.
 */
export const buildCodexModelsFromCatalog = (
  catalog: unknown,
  configuredModel?: string,
): ProviderModelsDefinition | null => {
  const entries = readObjectRecord(catalog)?.models;
  if (!Array.isArray(entries)) {
    return null;
  }

  const listed = entries
    .map((raw, index) => {
      const entry = readObjectRecord(raw);
      const slug = readOptionalString(entry?.slug);
      return entry && slug ? { entry, slug, index } : null;
    })
    .filter((item): item is { entry: Record<string, unknown>; slug: string; index: number } => item !== null)
    .filter(({ entry, slug }) => entry.visibility !== 'hide' || slug === configuredModel);

  const priorityOf = (entry: Record<string, unknown>): number => (
    typeof entry.priority === 'number' && Number.isFinite(entry.priority) ? entry.priority : Number.MAX_SAFE_INTEGER
  );
  listed.sort((left, right) => (priorityOf(left.entry) - priorityOf(right.entry)) || (left.index - right.index));

  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const { entry, slug } of listed) {
    if (!seen.has(slug)) {
      seen.add(slug);
      options.push(toCatalogModelOption(entry, slug));
    }
  }

  if (options.length === 0) {
    return null;
  }

  return {
    OPTIONS: options,
    DEFAULT: configuredModel && seen.has(configuredModel) ? configuredModel : options[0].value,
  };
};

let catalogCache: { key: string; models: ProviderModelsDefinition | null } | null = null;

/** The catalog file can be large (instructions per model), so it is parsed again only when it changes. */
const readCodexCatalogModels = async (
  catalogPath: string,
  configuredModel: string | undefined,
): Promise<ProviderModelsDefinition | null> => {
  const fileStat = await stat(catalogPath);
  const key = `${catalogPath}|${fileStat.mtimeMs}|${fileStat.size}|${configuredModel ?? ''}`;
  if (catalogCache?.key === key) {
    return catalogCache.models;
  }

  const models = buildCodexModelsFromCatalog(JSON.parse(await readFile(catalogPath, 'utf8')), configuredModel);
  catalogCache = { key, models };
  return models;
};

/** Provider registry model adapter for Codex predefined models and active config. */
export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const config = await readCodexConfig();
    const catalogSetting = readOptionalString(config?.model_catalog_json);
    if (!catalogSetting) {
      return CODEX_PREDEFINED_MODELS;
    }

    try {
      const catalogPath = path.resolve(path.dirname(CODEX_CONFIG_PATH), catalogSetting);
      return (await readCodexCatalogModels(catalogPath, readOptionalString(config?.model)))
        ?? CODEX_PREDEFINED_MODELS;
    } catch {
      return CODEX_PREDEFINED_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }
}
