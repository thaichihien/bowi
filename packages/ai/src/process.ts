/**
 * Running an AI CLI (`claude`, `codex`) as a child process: in an empty temporary folder, with
 * the prompt on stdin, stopped when the call is aborted. Never through a shell.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AiError } from '@bowi/core';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** The error when the executable does not exist (ENOENT). */
  notFound: (command: string) => AiError;
}

/**
 * Runs `commandLine` (the executable, or the executable and the arguments that go before
 * `args`: tests run a script with Node this way) and collects its output.
 */
export function runProcess(
  commandLine: string | string[],
  args: string[],
  stdin: string,
  options: RunOptions,
): Promise<RunResult> {
  const [command = '', ...before] = typeof commandLine === 'string' ? [commandLine] : commandLine;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...before, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      const reason: unknown = options.signal.reason;
      finish(() => reject(reason instanceof Error ? reason : new AiError('stopped')));
    };
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          e.code === 'ENOENT'
            ? options.notFound(command)
            : new AiError(`could not run \`${command}\`: ${e.message}`, { fatal: true }),
        ),
      ),
    );
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
    // The child may exit before reading its input (EPIPE): the exit code tells what happened.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/** Runs `fn` in a new empty temporary folder, deleted afterwards. */
export async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bowi-ai-'));
  try {
    return await fn(dir);
  } finally {
    await removeTemp(dir);
  }
}

/**
 * Deletes the working folder of a call. On Windows a process that was just stopped still holds
 * its working folder for a moment (EBUSY): retry, and never let the cleanup replace the error of
 * the call itself; a left-over temporary folder is harmless.
 */
async function removeTemp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}

/** Windows, and `command` was not found as an executable but an npm shim of it is on PATH. */
export function npmShimOnly(command: string, env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return false;
  // Windows environment names are case-insensitive; a copied env object keeps the original case.
  const path = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => ['.cmd', '.bat', '.ps1'].some((ext) => existsSync(join(dir, command + ext))));
}

/** The child gets the user's environment (login, proxy settings) but no GitHub token. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GITHUB_TOKEN: _g, GH_TOKEN: _h, GH_ENTERPRISE_TOKEN: _e, ...rest } = env;
  return rest;
}
