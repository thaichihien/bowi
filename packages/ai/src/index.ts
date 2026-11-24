/**
 * Optional AI enrichment (§7.11): providers, prompts and the answer cache.
 *
 * `createEnricher` turns a transport (one provider, AI-2: `claude-code`, `codex`, `anthropic`,
 * `openai` or `openai-compatible`, opened by `openProvider`) into the engine's `AiEnricher`: it writes the prompts, asks the transport, and caches valid answers.
 * The engine validates every answer again before using it (AI-5).
 */

import {
  aiAnswerJsonSchema,
  aiGroupAnswer,
  aiOverviewAnswer,
  type AiAnswer,
  type AiEnricher,
} from '@bowi/core';
import { answerKey, readAnswer, writeAnswer } from './cache.ts';
import { groupPrompt, overviewPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from './prompts.ts';
import type { AiRequest, AiTransport } from './transport.ts';

export { anthropic, ANTHROPIC_DEFAULT_MODEL, type AnthropicOptions } from './anthropic.ts';
export { checkClaudeCode, claudeCode, type ClaudeCodeOptions } from './claude-code.ts';
export { checkCodex, codex, type CodexOptions } from './codex.ts';
export { OPENAI_DEFAULT_MODEL, openAi, type OpenAiOptions } from './openai.ts';
export { openProvider, type ProviderEnvironment, type ProviderSettings } from './providers.ts';
export { strictSchema, type AiRequest, type AiTransport } from './transport.ts';
export { groupPrompt, overviewPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from './prompts.ts';

export interface EnricherOptions {
  transport: AiTransport;
  /** Folder for cached answers; no caching without it. */
  cacheDir?: string;
}

export function createEnricher({ transport, cacheDir }: EnricherOptions): AiEnricher {
  const ask = async (
    kind: 'group' | 'overview',
    prompt: string,
    valid: (output: unknown) => boolean,
    signal: AbortSignal,
  ): Promise<AiAnswer> => {
    const request: AiRequest = { system: SYSTEM_PROMPT, prompt, schema: aiAnswerJsonSchema(kind) };
    const key = answerKey([PROMPT_VERSION, transport.id, transport.settings, kind, request]);
    if (cacheDir) {
      const hit = await readAnswer(cacheDir, key);
      if (hit && valid(hit.output)) return { ...hit, cached: true };
    }
    const answer = await transport.complete(request, signal);
    // A cache that cannot be written only costs a call next time.
    if (cacheDir && valid(answer.output)) await writeAnswer(cacheDir, key, answer).catch(() => {});
    return answer;
  };
  return {
    id: transport.id,
    describe: () => transport.describe(),
    group: (input, signal) =>
      ask('group', groupPrompt(input), (o) => aiGroupAnswer.safeParse(o).success, signal),
    overview: (input, signal) =>
      ask('overview', overviewPrompt(input), (o) => aiOverviewAnswer.safeParse(o).success, signal),
  };
}
