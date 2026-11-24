/**
 * What every provider implements: one request to a model, one answer. Prompts, caching and
 * validation are shared (`index.ts`); a transport only carries the request.
 */

import type { AiAnswer } from '@bowi/core';

export interface AiRequest {
  system: string;
  prompt: string;
  /** JSON Schema of the answer. */
  schema: Record<string, unknown>;
}

/** Sends one request to a model. Implemented per provider; prompts and caching are shared. */
export interface AiTransport {
  id: string;
  /** Settings that change answers (model, effort, endpoint); part of the cache key. */
  settings: Record<string, string>;
  describe(): string;
  complete(request: AiRequest, signal: AbortSignal): Promise<AiAnswer>;
}

/** Keywords strict structured output (OpenAI, Anthropic) does not accept; zod checks them after. */
const UNSUPPORTED = new Set(['minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']);

/**
 * The answer schema in the subset that strict structured output accepts: string lengths,
 * patterns and array sizes left out. Every answer is still validated against the full schema
 * by the engine (AI-5), so nothing is lost but the hint to the model.
 */
export function strictSchema(schema: unknown): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !UNSUPPORTED.has(k))
        .map(([k, v]) => [k, k === 'properties' ? mapValues(v, strip) : strip(v)]),
    );
  };
  return strip(schema) as Record<string, unknown>;
}

/** `properties` maps names to schemas: a property named like a keyword is still a property. */
function mapValues(value: unknown, fn: (v: unknown) => unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fn(v)]));
}

export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  ).slice(0, 300);
}
