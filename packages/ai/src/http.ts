/**
 * One JSON request to an AI provider's HTTP API, through Node's built-in `fetch`, for the API
 * providers (`anthropic`, `openai`, `openai-compatible`). The key goes in a header, never in the
 * URL; redirects are refused, so a header is never sent anywhere else.
 *
 * A busy or failing server (429 without a spent quota, 500, 502, 503, 529) is asked once more,
 * after the `retry-after` it names (at most 10 s) or 2 s. Errors every further call would hit
 * too (key rejected, quota spent, unknown model, server unreachable) are fatal, so the engine
 * stops asking.
 */

import { AiError } from '@bowi/core';
import { firstLine } from './transport.ts';

export type FetchFn = typeof fetch;

export interface PostOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  fetch?: FetchFn;
  /** "the Anthropic API", for messages. */
  service: string;
  /** What to check when the key is rejected, e.g. "ANTHROPIC_API_KEY". */
  keyHint: string;
  /** Next step when the server cannot be reached. */
  unreachableHint?: string;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRY_WAIT_MS = 10_000;

export async function postJson(options: PostOptions): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const response = await send(options);
    const text = await response.text();
    const json = parse(text);
    if (response.ok) {
      if (json === undefined) throw new AiError(`${options.service} answered with no JSON`);
      return json;
    }
    const message = errorMessage(json) || firstLine(text) || response.statusText;
    if (attempt === 0 && RETRY_STATUS.has(response.status) && !quotaSpent(json, message)) {
      await wait(retryAfterMs(response.headers.get('retry-after')), options.signal);
      continue;
    }
    throw statusError(response.status, message, json, options);
  }
}

async function send(options: PostOptions): Promise<Response> {
  const fetchFn = options.fetch ?? fetch;
  try {
    return await fetchFn(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      redirect: 'error',
      signal: options.signal,
    });
  } catch (e) {
    if (options.signal.aborted) {
      const reason: unknown = options.signal.reason;
      throw reason instanceof Error ? reason : new AiError('stopped');
    }
    const cause = (e as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' ? cause.code : (e as Error).message;
    throw new AiError(`cannot reach ${hostOf(options.url)} (${code}).`, {
      fatal: true,
      hint: options.unreachableHint ?? 'Check the network connection, or run without --ai.',
    });
  }
}

function statusError(
  status: number,
  message: string,
  json: unknown,
  options: PostOptions,
): AiError {
  const what = `${options.service} answered ${status}: ${message}`;
  if (status === 401 || status === 403) {
    return new AiError(`${what}.`, {
      fatal: true,
      hint: `Check ${options.keyHint}, or run without --ai.`,
    });
  }
  if (status === 402 || quotaSpent(json, message)) {
    return new AiError(`${what}.`, {
      fatal: true,
      hint: 'Check the billing of your account, or run without --ai.',
    });
  }
  if (status === 404) {
    return new AiError(`${what}.`, {
      fatal: true,
      hint: 'Check "ai.model" (and "ai.baseUrl") in your config file, or run without --ai.',
    });
  }
  // A request too long for the model is about this group only; any other bad request (an
  // option the model does not take, an answer schema it refuses) fails every call alike.
  if (status === 400 && !/context|too long|too many tokens|maximum/i.test(message)) {
    return new AiError(`${what}.`, {
      fatal: true,
      hint: 'Check "ai.model" and "ai.effort" in your config file, or run without --ai.',
    });
  }
  return new AiError(what);
}

function quotaSpent(json: unknown, message: string): boolean {
  const error = (json as { error?: { code?: unknown; type?: unknown } } | undefined)?.error;
  return (
    error?.code === 'insufficient_quota' ||
    error?.type === 'insufficient_quota' ||
    error?.type === 'billing_error' ||
    /credit balance|insufficient_quota|exceeded your current quota|billing/i.test(message)
  );
}

/** Anthropic `{ error: { message } }`, OpenAI `{ error: { message } }`, Ollama `{ error }`. */
function errorMessage(json: unknown): string {
  const error = (json as { error?: unknown } | undefined)?.error;
  if (typeof error === 'string') return firstLine(error);
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? firstLine(message) : '';
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS)
    : 2000;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new AiError('stopped'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
