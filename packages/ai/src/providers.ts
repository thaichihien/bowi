/**
 * The AI providers (AI-2) by id, as `ai.provider` names them, each checked before the analysis
 * so that a missing CLI, key or endpoint stops the run at once with how to set it up.
 *
 * Keys come only from environment variables, never from a config file.
 */

import { AiError, type AiProviderId } from '@bowi/core';
import { anthropic, ANTHROPIC_KEY_VAR } from './anthropic.ts';
import { checkClaudeCode, claudeCode } from './claude-code.ts';
import { checkCodex, codex } from './codex.ts';
import type { FetchFn } from './http.ts';
import {
  COMPATIBLE_KEY_VAR,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENAI_KEY_VAR,
  openAi,
} from './openai.ts';
import type { AiTransport } from './transport.ts';

export interface ProviderSettings {
  provider: AiProviderId;
  model: string;
  effort: string;
  /** `openai-compatible` only. */
  baseUrl: string;
}

export interface ProviderEnvironment {
  env?: NodeJS.ProcessEnv;
  /** For tests: the CLI to run for `claude-code` or `codex`. */
  command?: string | string[];
  /** For tests: the API providers' `fetch`. */
  fetch?: FetchFn;
}

/** The transport for `settings.provider`. Throws a fatal AiError, with a hint, when it cannot work. */
export async function openProvider(
  settings: ProviderSettings,
  environment: ProviderEnvironment = {},
): Promise<AiTransport> {
  const env = environment.env ?? process.env;
  const { model, effort } = settings;
  const cli = {
    model,
    effort,
    env,
    ...(environment.command && { command: environment.command }),
  };
  const http = environment.fetch && { fetch: environment.fetch };
  switch (settings.provider) {
    case 'claude-code':
      await checkClaudeCode(cli);
      return claudeCode(cli);
    case 'codex':
      await checkCodex(cli);
      return codex(cli);
    case 'anthropic':
      return anthropic({
        apiKey: requireKey(env, ANTHROPIC_KEY_VAR, 'https://platform.claude.com/settings/keys'),
        model,
        effort,
        ...http,
      });
    case 'openai':
      return openAi({
        id: 'openai',
        baseUrl: OPENAI_BASE_URL,
        apiKey: requireKey(env, OPENAI_KEY_VAR, 'https://platform.openai.com/api-keys'),
        model: model || OPENAI_DEFAULT_MODEL,
        effort,
        ...http,
      });
    case 'openai-compatible': {
      const baseUrl = compatibleBaseUrl(settings.baseUrl);
      if (!model) {
        throw new AiError('The provider "openai-compatible" needs a model.', {
          fatal: true,
          hint: 'Set "ai": { "model": "<model name on that server>" } in your config file.',
        });
      }
      const apiKey = env[COMPATIBLE_KEY_VAR];
      return openAi({
        id: 'openai-compatible',
        baseUrl,
        ...(apiKey && { apiKey }),
        model,
        effort,
        ...http,
      });
    }
  }
}

function requireKey(env: NodeJS.ProcessEnv, name: string, where: string): string {
  const key = env[name]?.trim();
  if (!key) {
    throw new AiError(`${name} is not set.`, {
      fatal: true,
      hint: `Create a key at ${where} and set it in the environment (\`export ${name}=…\`), or run without --ai.`,
    });
  }
  return key;
}

function compatibleBaseUrl(value: string): string {
  const hint =
    'Set "ai": { "baseUrl": "http://localhost:11434/v1" } (the server\'s address, up to /v1) in your own config file, passed with --config.';
  if (!value) {
    throw new AiError('The provider "openai-compatible" needs "ai.baseUrl".', {
      fatal: true,
      hint,
    });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiError(`"ai.baseUrl" is not a URL: ${value}`, { fatal: true, hint });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiError(`"ai.baseUrl" must start with http:// or https://: ${value}`, {
      fatal: true,
      hint,
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AiError('"ai.baseUrl" must not hold a user, password, query or fragment.', {
      fatal: true,
      hint: `Put a key in ${COMPATIBLE_KEY_VAR} instead.`,
    });
  }
  return value;
}
