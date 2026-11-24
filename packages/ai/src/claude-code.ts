/**
 * The `claude-code` provider: runs the local Claude Code CLI headless (`claude -p`) with the
 * user's own Claude Code login, no API key (requirement.md §15 #6).
 *
 * Hardening, so the session can only answer the question it is given:
 * - it runs in an empty temporary folder, never the reviewed repository (AI-4: no whole files);
 * - no tools (`--tools ""`), no MCP servers, no slash commands, and no session saved;
 * - `--safe-mode`: the user's CLAUDE.md, hooks, plugins and skills are not loaded, so answers
 *   do not depend on personal setup (unlike `--bare`, the Claude Code login still works);
 * - Bowi's own system prompt, and `--json-schema` for the answer's shape (validated again by
 *   the engine);
 * - the prompt goes on stdin, never on the command line; GitHub tokens are not passed on.
 *
 * On Windows only the native `claude.exe` can be run: npm installs a `claude.cmd`, which needs
 * cmd.exe, and cmd.exe cannot pass the multi-line system prompt as an argument.
 *
 * Flags checked against Claude Code 2.1.314.
 */

import { AiError, type AiAnswer } from '@bowi/core';
import { childEnv, inTempDir, npmShimOnly, runProcess, type RunResult } from './process.ts';
import { firstLine, type AiTransport } from './transport.ts';

export interface ClaudeCodeOptions {
  /** Model alias or name for `--model`; empty for Claude Code's default. */
  model?: string;
  /** `--effort` level; empty for Claude Code's default. */
  effort?: string;
  /**
   * The Claude Code executable (default `claude`, found on PATH), or the executable and the
   * arguments that go before Bowi's (tests run a script with Node this way).
   */
  command?: string | string[];
  env?: NodeJS.ProcessEnv;
}

const NOT_INSTALLED_HINT =
  'Install Claude Code (https://claude.com/claude-code) and run `claude` once to log in, or run without --ai.';
const LOGIN_HINT = 'Run `claude` once and log in, then try again.';
const UPDATE_HINT = 'Update Claude Code with `claude update` (Bowi was tested with 2.1.314).';
const WINDOWS_NPM_HINT =
  'On Windows Bowi needs the native Claude Code (claude.exe), not the npm package (claude.cmd): install it with `irm https://claude.ai/install.ps1 | iex` in PowerShell, or run without --ai.';

export function claudeCode(options: ClaudeCodeOptions = {}): AiTransport {
  const command = options.command ?? 'claude';
  const model = options.model || undefined;
  const effort = options.effort || undefined;
  const details = [model, effort && `${effort} effort`].filter(Boolean).join(', ');
  return {
    id: 'claude-code',
    settings: { ...(model && { model }), ...(effort && { effort }) },
    describe: () =>
      `Claude${details ? ` (${details})` : ''} through Claude Code, with your Claude Code login`,
    async complete(request, signal) {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--tools',
        '',
        '--safe-mode',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--system-prompt',
        request.system,
        '--json-schema',
        JSON.stringify(request.schema),
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
      ];
      const result = await inTempDir((cwd) =>
        runClaude(command, args, request.prompt, {
          cwd,
          env: childEnv(options.env ?? process.env),
          signal,
        }),
      );
      return parseResult(result);
    },
  };
}

/** Checks that Claude Code is installed; returns its version. Throws a fatal AiError if not. */
export async function checkClaudeCode(options: ClaudeCodeOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await inTempDir((cwd) =>
    runClaude(options.command ?? 'claude', ['--version'], '', {
      cwd,
      env: childEnv(options.env ?? process.env),
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (code !== 0) {
    throw new AiError(`\`claude --version\` failed: ${firstLine(stderr) || `exit code ${code}`}`, {
      fatal: true,
      hint: NOT_INSTALLED_HINT,
    });
  }
  return stdout.trim().split(/\s/)[0] ?? '';
}

function runClaude(
  command: string | string[],
  args: string[],
  stdin: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<RunResult> {
  return runProcess(command, args, stdin, {
    ...options,
    notFound: (name) =>
      new AiError(`Claude Code is not installed (\`${name}\` was not found).`, {
        fatal: true,
        hint: npmShimOnly(name, options.env) ? WINDOWS_NPM_HINT : NOT_INSTALLED_HINT,
      }),
  });
}

/** Reads `claude -p --output-format json` output: one result object. */
function parseResult({ code, stdout, stderr }: RunResult): AiAnswer {
  let result: ClaudeResult | undefined;
  try {
    result = JSON.parse(stdout.trim()) as ClaudeResult;
  } catch {
    result = undefined;
  }
  if (!result || typeof result !== 'object') {
    throw classify(
      firstLine(stderr) || firstLine(stdout) || `Claude Code exited with code ${code}`,
    );
  }
  if (result.is_error || (result.subtype && result.subtype !== 'success')) {
    throw classify(
      (typeof result.result === 'string' && firstLine(result.result)) ||
        result.subtype ||
        'Claude Code reported an error',
    );
  }
  let output = result.structured_output;
  if (output === undefined && typeof result.result === 'string') {
    try {
      output = JSON.parse(result.result) as unknown;
    } catch {
      throw new AiError('the answer was not JSON');
    }
  }
  const model = mainModel(result.modelUsage);
  return { output, ...(model && { model }) };
}

interface ClaudeResult {
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  structured_output?: unknown;
  modelUsage?: Record<string, { outputTokens?: number }>;
}

/** The model that wrote the most output (Claude Code may use a small one on the side). */
function mainModel(usage: ClaudeResult['modelUsage']): string | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  return Object.entries(usage).sort(
    (a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0),
  )[0]?.[0];
}

/** Errors every further call would hit too are fatal: the engine then stops asking. */
function classify(message: string): AiError {
  if (/not logged in|\/login|invalid api key|authenticat|unauthori[sz]ed|oauth/i.test(message)) {
    return new AiError(`Claude Code is not logged in (${message}).`, {
      fatal: true,
      hint: LOGIN_HINT,
    });
  }
  if (/unknown option|unrecognized option|error: option/i.test(message)) {
    return new AiError(`this Claude Code version does not accept Bowi's flags (${message}).`, {
      fatal: true,
      hint: UPDATE_HINT,
    });
  }
  if (/usage limit|limit reached|credit balance|quota/i.test(message)) {
    return new AiError(`Claude's usage limit was reached (${message}).`, {
      fatal: true,
      hint: 'Try again when the limit resets, or run without --ai.',
    });
  }
  return new AiError(message);
}
