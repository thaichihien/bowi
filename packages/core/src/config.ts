/**
 * Resolved Bowi configuration (requirement.md §10).
 *
 * The `.bowi.json` loader and its zod validation arrive in M6; until then the engine runs on
 * DEFAULT_CONFIG plus CLI flags.
 */

import type { Layer } from './types.ts';

export type ReadingOrder = 'dependency' | 'tests-first';

export type AiProviderId = 'claude-code' | 'anthropic' | 'openai' | 'ollama';

export interface BowiConfig {
  base?: string;
  /** Extra glob patterns treated as generated files (NOISE-1). */
  generated: string[];
  /** Extra glob patterns per layer, checked before path heuristics (SYM-4). */
  layers: Partial<Record<Layer, string[]>>;
  grouping: {
    edgeThreshold: number;
    moveSimilarity: number;
    maxGroupShare: number;
  };
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
