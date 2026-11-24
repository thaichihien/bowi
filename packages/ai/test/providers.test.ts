import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AiError, aiAnswerJsonSchema } from '@bowi/core';
import { anthropic, checkCodex, codex, openAi, openProvider, strictSchema } from '../src/index.ts';
import { fakeCalls } from './fake-claude.ts';
import { fakeCodex } from './fake-codex.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-ai-test-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const request = {
  system: 'Be brief.',
  prompt: 'Group g1, kind "feature".',
  schema: aiAnswerJsonSchema('group'),
};
const answer = { title: 'AI title', intent: 'What these changes do together.', moves: [] };
const signal = () => new AbortController().signal;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect: unknown;
}

/** A `fetch` that records each request and answers from `replies`, in order. */
function fakeFetch(
  ...replies: { status?: number; json: unknown; headers?: Record<string, string> }[]
) {
  const sent: Sent[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      redirect: init.redirect,
    });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fn, sent };
}

describe('strictSchema', () => {
  it('leaves out what strict structured output does not accept, and keeps the rest', () => {
    const schema = strictSchema(aiAnswerJsonSchema('group'));
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/minLength|maxLength|pattern|maxItems/);
    expect(schema).toMatchObject({
      type: 'object',
      required: ['title', 'intent', 'moves'],
      additionalProperties: false,
      properties: { moves: { type: 'array', items: { additionalProperties: false } } },
    });
    // A property named like a keyword stays.
    expect(strictSchema({ properties: { pattern: { type: 'string', minLength: 1 } } })).toEqual({
      properties: { pattern: { type: 'string' } },
    });
  });
});

describe('codex provider', () => {
  const setup = (mode = 'ok') => {
    const dir = tempDir();
    const log = join(dir, 'calls.log');
    const env = { FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: mode, GITHUB_TOKEN: 'secret' };
    return { command: fakeCodex(dir), log, env };
  };

  it('runs `codex exec` hardened: read-only, no tools, empty folder, prompt on stdin', async () => {
    const { command, log, env } = setup();
    const result = await codex({ command, env, model: 'gpt-test', effort: 'low' }).complete(
      { ...request, prompt: 'Group g1, kind "feature".' },
      signal(),
    );
    expect(result).toEqual({
      output: { title: 'AI title for g1', intent: 'What these changes do together.', moves: [] },
      model: 'gpt-test',
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
    const [call] = fakeCalls(log) as (ReturnType<typeof fakeCalls>[number] & { schema: unknown })[];
    const schemaPath = call!.args[call!.args.indexOf('--output-schema') + 1];
    expect(call!.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--color',
      'never',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.view_image=false',
      '-c',
      'web_search="disabled"',
      '--output-schema',
      schemaPath,
      '--model',
      'gpt-test',
      '-c',
      'model_reasoning_effort="low"',
      '-',
    ]);
    expect(call!.schema).toEqual(strictSchema(request.schema));
    expect(call!.stdin).toBe('Be brief.\n\nGroup g1, kind "feature".');
    expect(call!.entries).toEqual([]);
    expect(call!.cwd).toContain('bowi-ai-');
    expect(existsSync(call!.cwd)).toBe(false);
    expect(call!.githubToken).toBe(false);
  });

  it('reports a missing login as fatal, with the next step', async () => {
    const { command, env } = setup('login');
    await expect(codex({ command, env }).complete(request, signal())).rejects.toMatchObject({
      fatal: true,
      message: 'Codex is not logged in (Not logged in. Run codex login.).',
      hint: 'Run `codex login` once, then try again.',
    });
  });

  it('stops the process when the call is aborted', async () => {
    const { command, log, env } = setup('hang');
    const controller = new AbortController();
    const pending = codex({ command, env }).complete(request, controller.signal);
    while (fakeCalls(log).length === 0) await new Promise((r) => setTimeout(r, 20));
    controller.abort(new AiError('no answer after 1 s'));
    await expect(pending).rejects.toThrow('no answer after 1 s');
  });

  it('checks the installation: version, or a fatal error when `codex` is missing', async () => {
    const { command, env } = setup();
    await expect(checkCodex({ command, env })).resolves.toBe('0.98.0');
    await expect(checkCodex({ command: join(tempDir(), 'no-codex'), env })).rejects.toMatchObject({
      fatal: true,
      message: expect.stringContaining('Codex is not installed'),
      hint: expect.stringContaining('npm install -g @openai/codex'),
    });
  });
});

const anthropicReply = {
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(answer) }],
  usage: { input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 70 },
};

describe('anthropic provider', () => {
  it('sends the Messages request with structured output and reads the answer', async () => {
    const f = fakeFetch({ json: anthropicReply });
    const t = anthropic({ apiKey: 'sk-test', effort: 'low', fetch: f.fn });
    expect(t.describe()).toBe(
      'claude-opus-5-5 (low effort) at api.anthropic.com, with your ANTHROPIC_API_KEY',
    );
    expect(await t.complete(request, signal())).toEqual({
      output: answer,
      model: 'claude-opus-5-5',
      usage: { inputTokens: 1000, outputTokens: 70 },
    });
    const [sent] = f.sent;
    expect(sent!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent!.redirect).toBe('error');
    expect(sent!.headers).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    });
    expect(sent!.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'Be brief.',
      messages: [{ role: 'user', content: request.prompt }],
      output_config: {
        format: { type: 'json_schema', schema: strictSchema(request.schema) },
        effort: 'low',
      },
      fallbacks: 'default',
    });
  });

  it('asks for fallbacks only on the models that take them', async () => {
    const f = fakeFetch({ json: anthropicReply });
    await anthropic({ apiKey: 'k', model: 'claude-haiku-5-5', fetch: f.fn }).complete(
      request,
      signal(),
    );
    expect(f.sent[0]!.headers['anthropic-beta']).toBeUndefined();
    expect(f.sent[0]!.body).not.toHaveProperty('fallbacks');
    expect(f.sent[0]!.body.output_config).not.toHaveProperty('effort');
  });

  it('asks a busy server once more, then gives up on this call only', async () => {
    const busy = {
      status: 529,
      json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      headers: { 'retry-after': '0' },
    };
    const ok = fakeFetch(busy, { json: anthropicReply });
    await expect(
      anthropic({ apiKey: 'k', fetch: ok.fn }).complete(request, signal()),
    ).resolves.toMatchObject({ output: answer });
    expect(ok.sent).toHaveLength(2);

    const down = fakeFetch(busy);
    const error = await anthropic({ apiKey: 'k', fetch: down.fn })
      .complete(request, signal())
      .catch((e: unknown) => e);
    expect(down.sent).toHaveLength(2);
    expect(error).toMatchObject({
      fatal: false,
      message: 'the Anthropic API answered 529: Overloaded',
    });
  });

  it('stops every call when the key is rejected or the credit is spent', async () => {
    const rejected = fakeFetch({
      status: 401,
      json: {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      },
    });
    await expect(
      anthropic({ apiKey: 'k', fetch: rejected.fn }).complete(request, signal()),
    ).rejects.toMatchObject({
      fatal: true,
      message: 'the Anthropic API answered 401: invalid x-api-key.',
      hint: 'Check ANTHROPIC_API_KEY, or run without --ai.',
    });
    const spent = fakeFetch({
      status: 400,
      json: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
    });
    await expect(
      anthropic({ apiKey: 'k', fetch: spent.fn }).complete(request, signal()),
    ).rejects.toMatchObject({
      fatal: true,
      hint: expect.stringContaining('billing'),
    });
    expect(spent.sent).toHaveLength(1);
  });

  it('keeps a declined or cut-off answer to its own group', async () => {
    const declined = fakeFetch({
      json: {
        ...anthropicReply,
        stop_reason: 'refusal',
        stop_details: { category: 'cyber' },
        content: [],
      },
    });
    await expect(
      anthropic({ apiKey: 'k', fetch: declined.fn }).complete(request, signal()),
    ).rejects.toMatchObject({
      fatal: false,
      message: 'the model declined to answer (cyber)',
    });
    const cut = fakeFetch({ json: { ...anthropicReply, stop_reason: 'max_tokens' } });
    await expect(
      anthropic({ apiKey: 'k', fetch: cut.fn }).complete(request, signal()),
    ).rejects.toThrow('the answer was cut off');
  });

  it('says when the server cannot be reached', async () => {
    const offline = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    await expect(
      anthropic({ apiKey: 'k', fetch: offline }).complete(request, signal()),
    ).rejects.toMatchObject({
      fatal: true,
      message: 'cannot reach api.anthropic.com (ENOTFOUND).',
    });
  });
});

const completion = {
  model: 'gpt-test-2026',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer), refusal: null } }],
  usage: { prompt_tokens: 800, completion_tokens: 60 },
};

describe('openai and openai-compatible providers', () => {
  it('sends a Chat Completions request with a strict JSON schema and reads the answer', async () => {
    const f = fakeFetch({ json: completion });
    const t = openAi({
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-o',
      model: 'gpt-x',
      effort: 'high',
      fetch: f.fn,
    });
    expect(t.describe()).toBe('gpt-x (high effort) at api.openai.com, with your OPENAI_API_KEY');
    expect(await t.complete(request, signal())).toEqual({
      output: answer,
      model: 'gpt-test-2026',
      usage: { inputTokens: 800, outputTokens: 60 },
    });
    const [sent] = f.sent;
    expect(sent!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent!.headers).toMatchObject({ authorization: 'Bearer sk-o' });
    expect(sent!.body).toEqual({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: request.prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: strictSchema(request.schema) },
      },
      reasoning_effort: 'high',
    });
  });

  it('stops when the quota is spent, and keeps a refusal to its group', async () => {
    const quota = fakeFetch({
      status: 429,
      json: {
        error: {
          message: 'You exceeded your current quota.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      },
    });
    const t = (fetchFn: typeof fetch) =>
      openAi({
        id: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'k',
        model: 'm',
        fetch: fetchFn,
      });
    await expect(t(quota.fn).complete(request, signal())).rejects.toMatchObject({ fatal: true });
    expect(quota.sent).toHaveLength(1);
    const refused = fakeFetch({
      json: {
        choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help.' } }],
      },
    });
    await expect(t(refused.fn).complete(request, signal())).rejects.toMatchObject({
      fatal: false,
      message: 'the model declined to answer (I cannot help.)',
    });
  });

  it('talks to a compatible server without a key, and names it', async () => {
    const f = fakeFetch({ json: completion });
    const t = openAi({
      id: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1/',
      model: 'llama3.1',
      fetch: f.fn,
    });
    expect(t.describe()).toBe('llama3.1 at localhost:11434 (OpenAI-compatible API)');
    expect(t.settings).toEqual({ model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' });
    await t.complete(request, signal());
    expect(f.sent[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(f.sent[0]!.headers).not.toHaveProperty('authorization');
  });
});

describe('openProvider', () => {
  const settings = { model: '', effort: '', baseUrl: '' } as const;

  it('needs the key in the environment, with where to get one', async () => {
    for (const [provider, name] of [
      ['anthropic', 'ANTHROPIC_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
    ] as const) {
      await expect(openProvider({ ...settings, provider }, { env: {} })).rejects.toMatchObject({
        fatal: true,
        message: `${name} is not set.`,
        hint: expect.stringContaining(`export ${name}=`),
      });
    }
    const t = await openProvider(
      { ...settings, provider: 'openai' },
      { env: { OPENAI_API_KEY: 'k' } },
    );
    expect(t.settings.model).toBe('gpt-5.6-sol');
    const a = await openProvider(
      { ...settings, provider: 'anthropic' },
      { env: { ANTHROPIC_API_KEY: 'k' } },
    );
    expect(a.settings.model).toBe('claude-opus-5-5');
  });

  it('needs a base URL and a model for a compatible server, and never sends it the OpenAI key', async () => {
    const provider = 'openai-compatible';
    await expect(openProvider({ ...settings, provider }, { env: {} })).rejects.toThrow(
      'needs "ai.baseUrl"',
    );
    await expect(
      openProvider({ ...settings, provider, baseUrl: 'file:///etc' }, { env: {} }),
    ).rejects.toThrow('must start with http');
    await expect(
      openProvider({ ...settings, provider, baseUrl: 'http://u:p@host/v1' }, { env: {} }),
    ).rejects.toThrow('must not hold a user');
    await expect(
      openProvider({ ...settings, provider, baseUrl: 'http://localhost:1234/v1' }, { env: {} }),
    ).rejects.toThrow('needs a model');

    const f = fakeFetch({ json: completion });
    const env = { OPENAI_API_KEY: 'sk-openai' };
    const t = await openProvider(
      { ...settings, provider, baseUrl: 'http://localhost:1234/v1', model: 'qwen' },
      { env, fetch: f.fn },
    );
    await t.complete(request, signal());
    expect(JSON.stringify(f.sent[0]!.headers)).not.toContain('sk-openai');

    const keyed = fakeFetch({ json: completion });
    const withKey = await openProvider(
      { ...settings, provider, baseUrl: 'https://gw.example/v1', model: 'qwen' },
      { env: { BOWI_AI_API_KEY: 'gw-key' }, fetch: keyed.fn },
    );
    expect(withKey.describe()).toBe(
      'qwen at gw.example (OpenAI-compatible API), with your BOWI_AI_API_KEY',
    );
    await withKey.complete(request, signal());
    expect(keyed.sent[0]!.headers).toMatchObject({ authorization: 'Bearer gw-key' });
  });
});
