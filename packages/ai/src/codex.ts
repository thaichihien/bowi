/**
 * The `codex` provider: runs the local OpenAI Codex CLI headless (`codex exec`) with the user's
 * own Codex login, which can be a ChatGPT plan (ChatGPT has no API of its own). No API key.
 *
 * Hardening, as for `claude-code`, so the session can only answer the question it is given:
 * - it runs in an empty temporary folder, never the reviewed repository (AI-4: no whole files);
 *   `--skip-git-repo-check` lets Codex start outside a git repository;
 * - a read-only sandbox, and the shell tool, web search and image viewing turned off;
 * - `--ignore-user-config`: the user's `config.toml` (MCP servers, profiles) is not loaded, so
 *   answers do not depend on personal setup; `--ephemeral`: no session saved;
 * - Bowi's system prompt goes first in the prompt, and `--output-schema` gives the answer's
 *   shape (validated again by the engine);
 * - the prompt goes on stdin (`-`), never on the command line; GitHub tokens are not passed on.
 *
 * Codex has no flag for a system prompt that replaces its own, and reads a global AGENTS.md
 * from its home folder; Bowi's instructions come first in the prompt instead.
 *
 * Flags taken from the Codex documentation (2026-11); not yet run against an installed Codex.
 * On Windows only a native `codex.exe` can be run, not npm's `codex.cmd` (cmd.exe re-reads
 * arguments).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AiError, type AiAnswer } from '@bowi/core';
import { childEnv, inTempDir, npmShimOnly, runProcess, type RunResult } from './process.ts';
import { firstLine, strictSchema, type AiTransport } from './transport.ts';

export interface CodexOptions {
  /** Model for `--model`; empty for Codex's default. */
  model?: string;
  /** `model_reasoning_effort`; empty for Codex's default. */
  effort?: string;
  /**
   * The Codex executable (default `codex`, found on PATH), or the executable and the arguments
   * that go before Bowi's (tests run a script with Node this way).
   */
  command?: string | string[];
  env?: NodeJS.ProcessEnv;
}

const NOT_INSTALLED_HINT =
  'Install Codex (`npm install -g @openai/codex`) and run `codex login` once, or run without --ai.';
const LOGIN_HINT = 'Run `codex login` once, then try again.';
const UPDATE_HINT = 'Update Codex with `npm install -g @openai/codex@latest`.';
const WINDOWS_NPM_HINT =
  "On Windows Bowi needs a native codex.exe on PATH (from Codex's GitHub releases), not the npm package (codex.cmd), or run without --ai.";

export function codex(options: CodexOptions = {}): AiTransport {
  const command = options.command ?? 'codex';
  const model = options.model || undefined;
  const effort = options.effort || undefined;
  const details = [model, effort && `${effort} effort`].filter(Boolean).join(', ');
  return {
    id: 'codex',
    settings: { ...(model && { model }), ...(effort && { effort }) },
    describe: () => `OpenAI${details ? ` (${details})` : ''} through Codex, with your Codex login`,
    complete: (request, signal) =>
      inTempDir(async (dir) => {
        // The schema sits next to the working folder, which stays empty.
        const schemaPath = join(dir, 'answer-schema.json');
        await writeFile(schemaPath, JSON.stringify(strictSchema(request.schema)));
        const cwd = join(dir, 'work');
        await mkdir(cwd);
        const args = [
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
          ...(model ? ['--model', model] : []),
          ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
          '-',
        ];
        const result = await runCodex(command, args, `${request.system}\n\n${request.prompt}`, {
          cwd,
          env: childEnv(options.env ?? process.env),
          signal,
        });
        return parseEvents(result, model);
      }),
  };
}

/** Checks that Codex is installed; returns its version. Throws a fatal AiError if not. */
export async function checkCodex(options: CodexOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await inTempDir((cwd) =>
    runCodex(options.command ?? 'codex', ['--version'], '', {
      cwd,
      env: childEnv(options.env ?? process.env),
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (code !== 0) {
    throw new AiError(`\`codex --version\` failed: ${firstLine(stderr) || `exit code ${code}`}`, {
      fatal: true,
      hint: NOT_INSTALLED_HINT,
    });
  }
  // "codex-cli 0.98.0"
  return stdout.trim().split(/\s/).at(-1) ?? '';
}

function runCodex(
  command: string | string[],
  args: string[],
  stdin: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<RunResult> {
  return runProcess(command, args, stdin, {
    ...options,
    notFound: (name) =>
      new AiError(`Codex is not installed (\`${name}\` was not found).`, {
        fatal: true,
        hint: npmShimOnly(name, options.env) ? WINDOWS_NPM_HINT : NOT_INSTALLED_HINT,
      }),
  });
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: unknown };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: unknown };
  message?: unknown;
}

/**
 * Reads `codex exec --json` output, one event per line: the last `agent_message` is the
 * answer, `turn.completed` carries the tokens used, `turn.failed` and `error` say what went
 * wrong.
 */
function parseEvents({ code, stdout, stderr }: RunResult, model: string | undefined): AiAnswer {
  let text: string | undefined;
  let usage: AiAnswer['usage'];
  let failure: string | undefined;
  for (const line of stdout.split('\n')) {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text === 'string') text = event.item.text;
    } else if (event.type === 'turn.completed' && event.usage) {
      usage = {
        inputTokens: event.usage.input_tokens ?? 0,
        outputTokens: event.usage.output_tokens ?? 0,
      };
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const message = event.error?.message ?? event.message;
      if (typeof message === 'string') failure ??= message;
    }
  }
  if (text === undefined) {
    throw classify(
      failure || firstLine(stderr) || firstLine(stdout) || `Codex exited with code ${code}`,
    );
  }
  let output: unknown;
  try {
    output = JSON.parse(text) as unknown;
  } catch {
    throw new AiError('the answer was not JSON');
  }
  return { output, ...(model && { model }), ...(usage && { usage }) };
}

/** Errors every further call would hit too are fatal: the engine then stops asking. */
function classify(message: string): AiError {
  if (/not logged in|codex login|log in|unauthori[sz]ed|\b401\b|authenticat/i.test(message)) {
    return new AiError(`Codex is not logged in (${message}).`, { fatal: true, hint: LOGIN_HINT });
  }
  if (/unexpected argument|unknown option|unrecognized|invalid value/i.test(message)) {
    return new AiError(`this Codex version does not accept Bowi's flags (${message}).`, {
      fatal: true,
      hint: UPDATE_HINT,
    });
  }
  if (/usage limit|limit reached|quota|credits/i.test(message)) {
    return new AiError(`the Codex usage limit was reached (${message}).`, {
      fatal: true,
      hint: 'Try again when the limit resets, or run without --ai.',
    });
  }
  return new AiError(message);
}
