/**
 * The only way Bowi runs git (SRC-7, NFR-4).
 *
 * Every call disables hooks and fsmonitor (both can execute commands), never prompts, and never
 * takes optional locks, so reading a repository cannot run its code or modify its index.
 * Diff-producing commands must also pass DIFF_FLAGS.
 */

import { spawn } from 'node:child_process';

const SAFE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
];

/**
 * Flags that pin diff output regardless of the user's git config (DIFF-1): no external diff
 * programs or textconv filters, fixed prefixes, algorithm, context, rename detection and order.
 */
export const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--histogram',
  '--indent-heuristic',
  '--unified=3',
  '--inter-hunk-context=0',
  '--find-renames',
  '-l5000',
  '--submodule=short',
  '-O/dev/null',
];

export interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Exit codes treated as success besides 0, e.g. [1] for `--verify --quiet` lookups. */
  okCodes?: number[];
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  readonly code: number;
  readonly stderr: string;

  constructor(args: string[], code: number, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`);
    this.code = code;
    this.stderr = stderr;
  }
}

export function git(args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...SAFE_CONFIG, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
      // stdin only when there is input: writing to a git that already exited raises EPIPE.
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' ? new Error('git is not installed or not on PATH') : e);
    });
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? -1,
      };
      if (result.code === 0 || options.okCodes?.includes(result.code)) resolve(result);
      else reject(new GitError(args, result.code, result.stderr));
    });
    if (child.stdin) {
      // git may exit before reading all input (e.g. on an error); its exit code reports that.
      child.stdin.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EPIPE') reject(e);
      });
      child.stdin.end(options.input);
    }
  });
}

/** Runs git and returns trimmed stdout. */
export async function gitText(args: string[], options: GitOptions): Promise<string> {
  return (await git(args, options)).stdout.trim();
}

/** Resolves a revision to a commit SHA, or null if it does not exist. */
export async function resolveCommit(rev: string, cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], {
    cwd,
    okCodes: [1, 128],
  });
  return r.code === 0 ? r.stdout.trim() : null;
}
