/**
 * Bowi CLI (requirement.md §7.1).
 *
 * `run(argv, io)` does everything and returns the exit code (CLI-11), so it can be tested
 * in-process; bin.ts only wires it to the real process.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import {
  analyze,
  BowiError,
  createStageContext,
  DEFAULT_CONFIG,
  UsageError,
  type ReviewPlan,
  type Snapshot,
} from '@bowi/core';
import { renderHtml } from '@bowi/render-html';
import { openLocalSnapshot } from '@bowi/sources';
import { createProgress } from './progress.ts';

export const VERSION = '0.0.0';

export interface Writable {
  write(chunk: string): unknown;
}

export interface CliIo {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  now?: () => Date;
}

interface CliOptions {
  local?: boolean;
  base?: string;
  out?: string;
  jsonOnly?: boolean;
  untracked: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/;

export async function run(argv: string[], io: CliIo): Promise<number> {
  const program = new Command('bowi')
    .description('Turn a pull request into a guided, grouped review.')
    .argument('[pr-url]', 'GitHub pull request URL, e.g. https://github.com/owner/repo/pull/123')
    .option('--local', 'review the current repository: merge base of --base vs the working tree')
    .option(
      '--base <branch>',
      'base branch for --local (default: origin/HEAD, else main, else master)',
    )
    .option('--out <dir>', 'output folder (default: ./.bowi/<repo>-<pr-or-branch>/)')
    .option('--json-only', 'write only review-plan.json, not review.html')
    .option('--no-untracked', 'with --local, leave out untracked files')
    .option('-q, --quiet', 'print nothing but errors')
    .option('-v, --verbose', 'print more detail')
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 1;
    throw e;
  }

  const opts = program.opts<CliOptions>();
  const progress = createProgress(io.stderr, { quiet: !!opts.quiet, verbose: !!opts.verbose });
  try {
    const snapshot = await openSnapshot(program.args[0], opts, io, progress);
    const plan = await analyze(
      snapshot,
      createStageContext(DEFAULT_CONFIG, {
        ...(io.now && { now: io.now }),
        logger: progress.logger,
      }),
      { toolVersion: VERSION, onStage: progress.stage },
    );
    for (const w of plan.meta.warnings) progress.warn(w);

    const outDir = outDirFor(plan, opts, io.cwd);
    await mkdir(outDir, { recursive: true });
    const planPath = join(outDir, 'review-plan.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n');
    if (opts.jsonOnly) {
      progress.done(`Wrote ${planPath}`);
      return 0;
    }
    // Highlighting is added to the page's copy of the plan only; review-plan.json stays lean.
    const html = await progress.time(
      'Rendered',
      () => renderHtml(plan, { readFile: (version, path) => snapshot.readFile(version, path) }),
      (page) => `review.html, ${formatSize(Buffer.byteLength(page))}`,
    );
    const htmlPath = join(outDir, 'review.html');
    await writeFile(htmlPath, html);
    progress.done(`Wrote ${htmlPath}`);
    return 0;
  } catch (e) {
    if (e instanceof BowiError) {
      io.stderr.write(`error: ${e.message}\n`);
      if (e.hint) io.stderr.write(`  ${e.hint}\n`);
      return e.exitCode;
    }
    io.stderr.write(`error: unexpected failure: ${e instanceof Error ? e.message : String(e)}\n`);
    if (opts.verbose && e instanceof Error && e.stack) io.stderr.write(`${e.stack}\n`);
    return 3;
  }
}

async function openSnapshot(
  target: string | undefined,
  opts: CliOptions,
  io: CliIo,
  progress: ReturnType<typeof createProgress>,
): Promise<Snapshot> {
  if (target && opts.local) {
    throw new UsageError('Pass either a PR URL or --local, not both.');
  }
  if (!target && !opts.local) {
    throw new UsageError(
      'Nothing to review.',
      'Run `bowi <github-pr-url>` or `bowi --local`. See `bowi --help`.',
    );
  }
  if (target) {
    if (!PR_URL.test(target)) {
      throw new UsageError(
        `Not a GitHub pull request URL: ${target}`,
        'Expected https://github.com/<owner>/<repo>/pull/<number>.',
      );
    }
    throw new UsageError(
      'GitHub PR URLs are not supported yet (milestone M5).',
      'Use `bowi --local` for now.',
    );
  }

  return progress.time(
    'Resolved',
    () =>
      openLocalSnapshot({
        cwd: io.cwd,
        ...(opts.base !== undefined && { base: opts.base }),
        includeUntracked: opts.untracked,
        excludeUntracked: [
          resolve(io.cwd, '.bowi'),
          ...(opts.out ? [resolve(io.cwd, opts.out)] : []),
        ],
      }),
    (s) => `${s.meta.headRef} vs ${s.meta.baseRef} · merge base ${s.meta.mergeBaseSha.slice(0, 7)}`,
  );
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function outDirFor(plan: ReviewPlan, opts: CliOptions, cwd: string): string {
  if (opts.out) return resolve(cwd, opts.out);
  const which =
    plan.source.prNumber !== undefined ? String(plan.source.prNumber) : plan.source.headRef;
  const name = `${plan.source.repo}-${which}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return resolve(cwd, '.bowi', name);
}
