/**
 * Comments on the command line (M10): carried over when a run writes into a folder that has
 * them (§15 #64), listed by `bowi comments <dir> [--markdown]` (CLI-14) and sent to the pull
 * request by `bowi comments push <dir>` (M11, CLI-16).
 */

import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError } from 'commander';
import {
  anchorLabel,
  carryReview,
  hasReview,
  HostError,
  parseReview,
  pullRequestUrl,
  requestWords,
  submitUrl,
  reviewMarkdown,
  sortComments,
  SourceError,
  UsageError,
  type PostResult,
  type Review,
  type ReviewComment,
  type ReviewPlan,
} from '@bowi/core';
import type { CliIo } from './index.ts';
import { hostOf, pendingConflict, pluralWord, postStatus, sendReview, sentWhat } from './post.ts';

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
    (b.kind === 'local' ? a.headRef === b.headRef : a.prNumber === b.prNumber)
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
  if (argv[0] === 'push') return runPush(argv.slice(1), io);
  const program = new Command('bowi comments')
    .description('List the comments written in a report.')
    .argument('<dir>', 'the report folder (holds review-plan.json)')
    .option('--markdown', 'print them as Markdown, ready to paste')
    .addHelpText(
      'after',
      '\nTo send them to the pull request: bowi comments push <dir> (--help for more)',
    )
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
    const notes = [
      ...(c.sync ? [c.sync.pending ? 'sent as pending' : 'posted'] : []),
      ...(c.status === 'outdated' ? [`outdated (written on ${c.anchor.headSha.slice(0, 7)})`] : []),
    ];
    const head = [where, ...notes].join(' · ');
    out.push(`${head}\n${indent(c.body)}`);
  }
  const outdated = review.comments.filter((c) => c.status === 'outdated').length;
  const pending = review.comments.filter((c) => c.sync?.pending).length;
  const posted = review.comments.filter((c) => c.sync && !c.sync.pending).length;
  const n = review.comments.length;
  const totals = [
    `${n} comment${n === 1 ? '' : 's'}`,
    ...(pending ? [`${pending} sent as pending`] : []),
    ...(posted ? [`${posted} posted`] : []),
    ...(outdated ? [`${outdated} outdated`] : []),
  ];
  out.push(totals.join(', '));
  return out.join('\n\n') + '\n';
}

/** `file.ts:18`, `file.ts:44-46`, or `file.ts (file)`, for the list before sending. */
function shortPlace(c: ReviewComment): string {
  const { path, line, startLine, side } = c.anchor;
  if (line === undefined) return `${path} (file)`;
  const old = side === 'old' ? ' (old)' : '';
  return `${path}:${startLine !== undefined ? `${startLine}-` : ''}${line}${old}`;
}

/** `bowi comments push <dir> [--yes] [--now] [--outdated]` (CLI-16). */
async function runPush(argv: string[], io: CliIo): Promise<number> {
  const program = new Command('bowi comments push')
    .description('Send the comments of a report to its pull or merge request. Asks first.')
    .argument('<dir>', 'the report folder (holds review-plan.json)')
    .option('--yes', 'do not ask; stops if the pull request has new commits since the report')
    .option('--now', 'post at once, public, instead of as a pending review')
    .option('--outdated', 'also send outdated comments, on their files with the old lines quoted')
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
  const opts = program.opts<{ yes?: boolean; now?: boolean; outdated?: boolean }>();
  const out = (s: string) => void io.stdout.write(s);
  const dir = resolve(io.cwd, program.args[0]!);
  const plan = await readReport(dir);
  const review = plan.review ?? { body: '', comments: [] };
  const url = pullRequestUrl(plan.source);
  const words = requestWords(plan.source);
  const submitLine = `→ Submit    ${submitUrl(plan.source)}\n`;
  const anyPending = !!review.bodySync?.pending || review.comments.some((c) => c.sync?.pending);
  const unsent = sortComments(review.comments).filter((c) => !c.sync);
  const left = unsent.filter((c) => c.status === 'outdated' && !opts.outdated);
  const comments = unsent.filter((c) => !left.includes(c));
  const summary = !review.bodySync && review.body.trim() !== '';

  // A local report has no pull request; checked before "nothing new".
  const access =
    url === undefined || comments.length > 0 || summary ? await hostOf(plan, io) : undefined;
  if (!access) {
    const sent = review.comments.length - unsent.length;
    out(`Nothing new to post: ${pluralWord(sent, 'comment')} already sent.\n`);
    if (left.length > 0) {
      out(`  Left out: ${pluralWord(left.length, 'outdated comment')} (--outdated to include)\n`);
    }
    if (anyPending) out(submitLine);
    return 0;
  }

  const mode = opts.now ? 'now' : 'pending';
  const status = await postStatus(access);
  const head = plan.source.headSha;
  const conflict = pendingConflict(status, plan, mode);
  if (conflict) throw conflict;
  const via = status.via === 'gh' || status.via === 'glab' ? `${status.via} login` : status.via;
  const { host, request } = words!;
  out(`Posting to ${plan.source.repo}${words!.ref} as @${status.login} (${via})\n`);
  const moved = status.headSha !== head;
  if (moved && opts.yes) {
    throw new SourceError(
      `The ${request} has new commits since this report (${head.slice(0, 7)}, ${host} is on ${status.headSha.slice(0, 7)}).`,
      `Run \`bowi ${url} --out ${dir}\` first, or run without --yes to decide.`,
    );
  }
  if (moved) {
    out(
      `! This ${request} has new commits. This report is on ${head.slice(0, 7)}, ${host} is on ${status.headSha.slice(0, 7)}. Run Bowi again to check first.\n`,
    );
  }
  const leftOutSummary = summary && status.pending?.hasBody;
  out('\n');
  if (summary && !leftOutSummary) out('  Review summary\n');
  for (const c of comments)
    out(`  ${shortPlace(c)}${c.status === 'outdated' ? ' (on the file)' : ''}\n`);
  if (left.length > 0) {
    out(`  Left out: ${pluralWord(left.length, 'outdated comment')} (--outdated to include)\n`);
  }
  const sentBefore = review.comments.length - unsent.length;
  if (sentBefore > 0) out(`  Already sent, not sent again: ${pluralWord(sentBefore, 'comment')}\n`);
  if (status.pending) {
    out(`  They join your pending review (${pluralWord(status.pending.comments, 'comment')}).\n`);
  }
  out('\n');

  const what = sentWhat(comments.length, !!summary && !leftOutSummary);
  if (!opts.yes) {
    const ask = io.ask ?? (process.stdin.isTTY ? askTerminal : undefined);
    if (!ask) {
      throw new UsageError(
        'Nothing was posted: no terminal to ask on.',
        'Pass --yes to post without asking.',
      );
    }
    const place = moved ? ` on head ${head.slice(0, 7)}` : '';
    const question = opts.now
      ? `Post ${what} now, public${place}? [y/N] `
      : `Send ${what} as a pending review${place}? [y/N] `;
    const answer = await ask(question);
    if (!/^y(es)?$/i.test(answer.trim())) {
      out('Nothing was posted.\n');
      return 0;
    }
  }

  const result = await sendReview(
    dir,
    {
      mode,
      commentIds: comments.map((c) => c.id),
      summary,
    },
    access,
    io.now,
  );
  return pushOutcome(result, plan, io);
}

function pushOutcome(result: PostResult, plan: ReviewPlan, io: CliIo): number {
  const out = (s: string) => void io.stdout.write(s);
  const what = sentWhat(result.sent, result.summarySent);
  const any = result.sent > 0 || result.summarySent;
  // Without an error, "now" was published; an error before that leaves them pending.
  const pending = result.mode === 'pending' || !!result.error;
  if (any && pending) {
    out(`✓ Sent      ${what} as a pending review, not public yet\n`);
    out(`→ Submit    ${submitUrl(plan.source)}\n`);
    out('  Only you can see them until you submit.\n');
  } else if (any) {
    out(`✓ Posted    ${what}, public now\n`);
    out(`→ Open      ${pullRequestUrl(plan.source)}\n`);
  }
  const host = requestWords(plan.source)?.host ?? 'GitHub';
  for (const f of result.onFile) {
    out(
      `! On file   ${f.path}: ${host} did not accept ${f.label.toLowerCase()}, so it starts with it\n`,
    );
  }
  if (result.summaryLeftOut)
    out('  Your pending review already has a summary, so this one stayed here.\n');
  for (const f of result.failed) {
    io.stderr.write(`error: not sent: ${f.path} (${f.label}): ${f.message}\n`);
  }
  if (result.error) {
    const e = result.error;
    throw new HostError(e.kind, any ? e.message : `${e.message} Nothing was posted.`, e.hint);
  }
  return result.failed.length > 0 ? 2 : 0;
}

async function askTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
