/**
 * The `openai` and `openai-compatible` providers: the Chat Completions API
 * (`POST <base>/chat/completions`), which OpenAI and most other servers speak (Ollama, LM Studio,
 * vLLM, gateways). Bowi itself connects to the endpoint, through `fetch`.
 *
 * - `openai`: api.openai.com with the user's `OPENAI_API_KEY`.
 * - `openai-compatible`: the `ai.baseUrl` of the reviewer's own config file and a model they
 *   name; the key, when the server needs one, comes from `BOWI_AI_API_KEY`, never from
 *   `OPENAI_API_KEY`, so an OpenAI key is never sent to another server.
 *
 * The answer's shape comes from `response_format` (`json_schema`, strict; validated again by the
 * engine). No tools. `ai.effort` goes to `reasoning_effort`.
 */

import { AiError, type AiAnswer } from '@bowi/core';
import { hostOf, postJson, type FetchFn } from './http.ts';
import { strictSchema, type AiTransport } from './transport.ts';

export const OPENAI_DEFAULT_MODEL = 'gpt-5.6-sol';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_KEY_VAR = 'OPENAI_API_KEY';
export const COMPATIBLE_KEY_VAR = 'BOWI_AI_API_KEY';

export interface OpenAiOptions {
  /** `openai` or `openai-compatible`. */
  id: 'openai' | 'openai-compatible';
  /** Up to `/v1`, e.g. "http://localhost:11434/v1". */
  baseUrl: string;
  /** Optional for a compatible server. */
  apiKey?: string;
  model: string;
  effort?: string;
  fetch?: FetchFn;
}

export function openAi(options: OpenAiOptions): AiTransport {
  const { id, model } = options;
  const effort = options.effort || undefined;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const host = hostOf(baseUrl);
  const keyVar = id === 'openai' ? OPENAI_KEY_VAR : COMPATIBLE_KEY_VAR;
  return {
    id,
    settings: {
      model,
      ...(effort && { effort }),
      ...(id === 'openai-compatible' && { baseUrl }),
    },
    describe: () =>
      `${model}${effort ? ` (${effort} effort)` : ''} at ${host}${id === 'openai-compatible' ? ' (OpenAI-compatible API)' : ''}${options.apiKey ? `, with your ${keyVar}` : ''}`,
    async complete(request, signal) {
      const json = (await postJson({
        url: `${baseUrl}/chat/completions`,
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
        body: {
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'answer', strict: true, schema: strictSchema(request.schema) },
          },
          ...(effort && { reasoning_effort: effort }),
        },
        signal,
        ...(options.fetch && { fetch: options.fetch }),
        service: id === 'openai' ? 'the OpenAI API' : `the OpenAI-compatible API at ${host}`,
        keyHint:
          id === 'openai' ? OPENAI_KEY_VAR : `${COMPATIBLE_KEY_VAR} and the server's settings`,
        ...(id === 'openai-compatible' && {
          unreachableHint: `Check that the server at ${baseUrl} is running ("ai.baseUrl" in your config file), or run without --ai.`,
        }),
      })) as ChatCompletion;
      return parseCompletion(json);
    },
  };
}

interface ChatCompletion {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: unknown; refusal?: unknown };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseCompletion(completion: ChatCompletion): AiAnswer {
  const choice = completion.choices?.[0];
  const refusal = choice?.message?.refusal;
  if (typeof refusal === 'string' && refusal) {
    throw new AiError(`the model declined to answer (${refusal.slice(0, 200)})`);
  }
  if (choice?.finish_reason === 'length') throw new AiError('the answer was cut off');
  const content = choice?.message?.content;
  let output: unknown;
  try {
    output = JSON.parse(typeof content === 'string' ? content : '') as unknown;
  } catch {
    throw new AiError('the answer was not JSON');
  }
  const u = completion.usage;
  return {
    output,
    ...(completion.model && { model: completion.model }),
    ...(u && {
      usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 },
    }),
  };
}
