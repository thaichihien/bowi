/**
 * Comments on the command line (M10): carried over when a run writes into a folder that has
 * them (§15 #64), and listed by `bowi comments <dir> [--markdown]` (CLI-14).
 */

import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import {
  anchorLabel,
  carryReview,
  hasReview,
  parseReview,
  reviewMarkdown,
  sortComments,
  UsageError,
  type Review,
  type ReviewPlan,
} from '@bowi/core';
import type { CliIo } from './index.ts';

export const PLAN_FILE = 'review-plan.json';
export const HTML_FILE = 'review.html';

export const planJson = (plan: ReviewPlan) => JSON.stringify(plan, null, 2) + '\n';

/** The plan of a report folder, with errors that say what to run instead. */
export async function readReport(dir: string): Promise<ReviewPlan> {
  const path = join(dir, PLAN_FILE);
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      throw new UsageError(
        `No Bowi report in ${dir} (${PLAN_FILE} not found).`,
        'Run `bowi --local --out <dir>` first, or pass the folder that holds review.html.',
      );
    }
    throw e;
  });
  let plan: ReviewPlan;
  try {
    plan = JSON.parse(text) as ReviewPlan;
  } catch {
    throw new UsageError(`${path} is not valid JSON.`, 'Run bowi again to write a new report.');
  }
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.hunks)) {
    throw new UsageError(`${path} is not a Bowi review plan.`);
  }
  if (plan.review !== undefined) {
    const parsed = parseReview(plan.review);
    if ('error' in parsed) {
      throw new UsageError(
        `The comments in ${path} are not valid: ${parsed.error}.`,
        'Fix or remove the "review" field of the file.',
      );
    }
    plan.review = parsed.review;
  }
  return plan;
}

/**
 * Before a run overwrites `planPath`: takes the comments of the plan there over to `plan`.
 * Returns the progress line, or a warning when the old comments could not be used (the old file
 * is then kept next to the new one, so nothing is lost).
 */
export async function carryComments(
  planPath: string,
  plan: ReviewPlan,
): Promise<{ summary?: string; warning?: string }> {
  const text = await readFile(planPath, 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  let old: Partial<ReviewPlan> | undefined;
  try {
    old = JSON.parse(text) as Partial<ReviewPlan>;
  } catch {
    old = undefined;
  }
  if (old?.review === undefined) return {};
  const backup = async (why: string) => {
    await copyFile(planPath, `${planPath}.bak`);
    return { warning: `${why}; the old plan is kept as ${PLAN_FILE}.bak` };
  };
  const parsed = parseReview(old.review);
  if ('error' in parsed)
    return backup(`The comments in ${planPath} are not valid (${parsed.error})`);
  if (!hasReview(parsed.review)) return {};
  if (!sameReview(old, plan)) {
    return backup(`${planPath} held comments on another review, so they are not carried over`);
  }
  const r = carryReview(parsed.review, plan);
  plan.review = r.review;
  const parts = [`${r.kept} kept${r.moved ? ` (${r.moved} moved)` : ''}`];
  if (r.outdated) parts.push(`${r.outdated} outdated`);
  return { summary: r.review.comments.length ? parts.join(', ') : 'review summary kept' };
}

/** Same repository and pull request (or branch, for local changes). */
function sameReview(old: Partial<ReviewPlan>, plan: ReviewPlan): boolean {
  const a = old.source;
  const b = plan.source;
  return (
    !!a &&
    a.kind === b.kind &&
    a.repo === b.repo &&
    (b.kind === 'github' ? a.prNumber === b.prNumber : a.headRef === b.headRef)
  );
}

/**
 * Writes a file through a temporary one, so a reader never sees half of it. On Windows a rename
 * fails while another process has the target open (a browser reading review.html): retried.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      await rm(tmp, { force: true });
      throw e;
    }
  }
}

/** `bowi comments <dir> [--markdown]` (CLI-14). */
export async function runComments(argv: string[], io: CliIo): Promise<number> {
  const program = new Command('bowi comments')
    .description('List the comments written in a report.')
    .argument('<dir>', 'the report folder (holds review-plan.json)')
    .option('--markdown', 'print them as Markdown, ready to paste')
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
  const dir = resolve(io.cwd, program.args[0]!);
  const plan = await readReport(dir);
  const review = plan.review;
  if (program.opts<{ markdown?: boolean }>().markdown) {
    if (hasReview(review)) io.stdout.write(reviewMarkdown(review));
    return 0;
  }
  if (!hasReview(review)) {
    io.stdout.write(`No comments in ${dir}.\n`);
    return 0;
  }
  io.stdout.write(listing(review));
  return 0;
}

function listing(review: Review): string {
  const indent = (text: string) =>
    text
      .trim()
      .split('\n')
      .map((l) => (l ? `  ${l}` : ''))
      .join('\n');
  const out: string[] = [];
  if (review.body.trim()) out.push(`Review summary\n${indent(review.body)}`);
  const sorted = sortComments(review.comments);
  const ordered = [
    ...sorted.filter((c) => c.status === 'active'),
    ...sorted.filter((c) => c.status === 'outdated'),
  ];
  for (const c of ordered) {
    const where = `${c.anchor.path} · ${anchorLabel(c.anchor)}`;
    const head =
      c.status === 'outdated'
        ? `${where} · outdated (written on ${c.anchor.headSha.slice(0, 7)})`
        : where;
    out.push(`${head}\n${indent(c.body)}`);
  }
  const outdated = review.comments.filter((c) => c.status === 'outdated').length;
  const n = review.comments.length;
  out.push(`${n} comment${n === 1 ? '' : 's'}${outdated ? `, ${outdated} outdated` : ''}`);
  return out.join('\n\n') + '\n';
}
