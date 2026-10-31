/**
 * Bowi configuration (requirement.md §10): DEFAULT_CONFIG, and `.bowi.json` validated with zod
 * (CLI-9). Unknown keys produce a warning, not an error; a known key with a wrong value is a
 * usage error that names the key.
 */

import { z } from 'zod';
import { UsageError } from './errors.ts';
import type { Layer } from './types.ts';

export type ReadingOrder = 'dependency' | 'tests-first';

export type AiProviderId = 'claude-code' | 'anthropic' | 'openai' | 'ollama';

export interface BowiConfig {
  base?: string;
  /** Extra glob patterns treated as generated files (NOISE-1). */
  generated: string[];
  /** Extra glob patterns per layer, checked before plugins and path heuristics (SYM-4). */
  layers: Partial<Record<Layer, string[]>>;
  grouping: {
    edgeThreshold: number;
    moveSimilarity: number;
    maxGroupShare: number;
  };
  /** Unchanged call sites per changed symbol (GRAPH-11); 0 turns the search off. */
  outsideRefs: { maxPerSymbol: number };
  order: ReadingOrder;
  ai: { enabled: boolean; provider: AiProviderId; model: string };
}

export const DEFAULT_CONFIG: BowiConfig = {
  generated: [],
  layers: {},
  grouping: { edgeThreshold: 0.5, moveSimilarity: 0.8, maxGroupShare: 0.4 },
  outsideRefs: { maxPerSymbol: 5 },
  order: 'dependency',
  ai: { enabled: false, provider: 'claude-code', model: '' },
};

const LAYERS: Layer[] = [
  'schema',
  'data',
  'util',
  'domain',
  'service',
  'api',
  'ui',
  'config',
  'test',
  'docs',
  'unknown',
];

const share = z.number().min(0).max(1);
const configSchema = z.object({
  // Editors use `$schema` to find a JSON Schema; it is not a setting.
  $schema: z.string().optional(),
  base: z.string().min(1).optional(),
  generated: z.array(z.string().min(1)).optional(),
  layers: z.record(z.string(), z.array(z.string().min(1))).optional(),
  grouping: z
    .object({
      edgeThreshold: share.optional(),
      moveSimilarity: share.optional(),
      maxGroupShare: z.number().gt(0).max(1).optional(),
    })
    .optional(),
  outsideRefs: z.object({ maxPerSymbol: z.number().int().min(0).max(50).optional() }).optional(),
  order: z.enum(['dependency', 'tests-first']).optional(),
  ai: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.enum(['claude-code', 'anthropic', 'openai', 'ollama']).optional(),
      model: z.string().optional(),
    })
    .optional(),
});

export interface LoadedConfig {
  config: BowiConfig;
  warnings: string[];
}

/**
 * Validates the text of a config file and merges it over DEFAULT_CONFIG. `label` names the file
 * in messages. Throws UsageError for invalid JSON or values.
 */
export function parseConfig(text: string, label: string): LoadedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new UsageError(
      `${label} is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
      'Fix the file, or pass another one with --config <path>.',
    );
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.length ? i.path.join('.') : '(top level)'}: ${i.message}`);
    throw new UsageError(
      `${label} has invalid settings: ${issues.join('; ')}.`,
      'See the configuration section of the README for the allowed values.',
    );
  }

  const warnings = unknownKeys(raw, configSchema).map(
    (key) => `${label}: unknown setting "${key}" was ignored`,
  );
  const c = result.data;
  const layers: Partial<Record<Layer, string[]>> = {};
  for (const [layer, globs] of Object.entries(c.layers ?? {})) {
    if (LAYERS.includes(layer as Layer)) layers[layer as Layer] = globs;
    else warnings.push(`${label}: unknown layer "${layer}" in "layers" was ignored`);
  }
  if (c.ai?.enabled) {
    warnings.push(`${label}: AI enrichment is not available in this version; "ai" was ignored`);
  }

  const d = DEFAULT_CONFIG;
  const config: BowiConfig = {
    generated: c.generated ?? d.generated,
    layers,
    grouping: { ...d.grouping, ...c.grouping },
    outsideRefs: { ...d.outsideRefs, ...c.outsideRefs },
    order: c.order ?? d.order,
    ai: { ...d.ai, ...c.ai, enabled: false },
  };
  if (c.base) config.base = c.base;
  return { config, warnings };
}

/** Dotted paths of object keys the schema does not know. */
function unknownKeys(value: unknown, schema: z.ZodType, prefix = ''): string[] {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  if (!(inner instanceof z.ZodObject) || typeof value !== 'object' || value === null) return [];
  const shape = inner.shape as Record<string, z.ZodType>;
  return Object.keys(value)
    .sort()
    .flatMap((key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const child = shape[key];
      if (!child) return [path];
      return unknownKeys((value as Record<string, unknown>)[key], child, path);
    });
}
