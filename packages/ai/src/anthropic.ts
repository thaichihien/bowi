/**
 * The `anthropic` provider: the Anthropic Messages API (`POST /v1/messages`) with the user's
 * `ANTHROPIC_API_KEY`. Bowi itself connects to api.anthropic.com, through `fetch`.
 *
 * The answer's shape comes from structured output (`output_config.format`, a JSON Schema in the
 * subset the API accepts; validated again by the engine). No tools. `ai.effort` goes to
 * `output_config.effort`. On the models that take it, a declined request is answered by the
 * fallback model Anthropic recommends (`fallbacks: "default"`) instead of failing.
 */

import { AiError, type AiAnswer } from '@bowi/core';
import { postJson, type FetchFn } from './http.ts';
import { strictSchema, type AiTransport } from './transport.ts';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_KEY_VAR = 'ANTHROPIC_API_KEY';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const MAX_TOKENS = 16_000;
/** Models that take server-side fallbacks after a refusal. */
const FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

export interface AnthropicOptions {
  apiKey: string;
  /** Empty for ANTHROPIC_DEFAULT_MODEL. */
  model?: string;
  effort?: string;
  fetch?: FetchFn;
}

export function anthropic(options: AnthropicOptions): AiTransport {
  const model = options.model || ANTHROPIC_DEFAULT_MODEL;
  const effort = options.effort || undefined;
  const fallbacks = FALLBACK_MODELS.has(model);
  return {
    id: 'anthropic',
    settings: { model, ...(effort && { effort }) },
    describe: () =>
      `${model}${effort ? ` (${effort} effort)` : ''} at api.anthropic.com, with your ${ANTHROPIC_KEY_VAR}`,
    async complete(request, signal) {
      const json = (await postJson({
        url: MESSAGES_URL,
        headers: {
          'x-api-key': options.apiKey,
          'anthropic-version': API_VERSION,
          ...(fallbacks && { 'anthropic-beta': 'server-side-fallback-2026-07-01' }),
        },
        body: {
          model,
          max_tokens: MAX_TOKENS,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: {
            format: { type: 'json_schema', schema: strictSchema(request.schema) },
            ...(effort && { effort }),
          },
          ...(fallbacks && { fallbacks: 'default' }),
        },
        signal,
        ...(options.fetch && { fetch: options.fetch }),
        service: 'the Anthropic API',
        keyHint: ANTHROPIC_KEY_VAR,
      })) as AnthropicMessage;
      return parseMessage(json);
    },
  };
}

interface AnthropicMessage {
  model?: string;
  stop_reason?: string;
  stop_details?: { category?: unknown } | null;
  content?: { type?: string; text?: unknown }[];
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

function parseMessage(message: AnthropicMessage): AiAnswer {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new AiError(
      `the model declined to answer${typeof category === 'string' ? ` (${category})` : ''}`,
    );
  }
  if (message.stop_reason === 'max_tokens') throw new AiError('the answer was cut off');
  const text = (message.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  let output: unknown;
  try {
    output = JSON.parse(text) as unknown;
  } catch {
    throw new AiError('the answer was not JSON');
  }
  const u = message.usage;
  return {
    output,
    ...(message.model && { model: message.model }),
    ...(u && {
      usage: {
        inputTokens:
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      },
    }),
  };
}
