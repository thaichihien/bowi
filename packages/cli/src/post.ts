/**
 * Sending a report's comments to its pull request (M11, §15 #70), for `bowi serve` and `bowi
 * comments push`. Each comment is recorded in the plan as soon as the host has it, so a send that
 * stops half way, or a second one, never posts anything twice. Bowi only sends: what happens to a
 * review on the host afterwards is the host's business.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  anchorLabel,
  bodyOnFile,
  emptyReview,
  HostError,
  sortComments,
  UsageError,
  type HostComment,
  type HostRef,
  type PostRequest,
  type PostResult,
  type PostStatus,
  type ReviewComment,
  type ReviewHost,
  type ReviewPlan,
  type ReviewSync,
} from '@bowi/core';
import { supportsComments, withReview } from '@bowi/render-html';
import { findGithubLogin, githubReviewHost, type GithubLogin } from '@bowi/sources';
import { HTML_FILE, PLAN_FILE, planJson, readReport, writeFileAtomic } from './comments.ts';
import type { CliIo } from './index.ts';

export interface HostAccess {
  host: ReviewHost;
  via: GithubLogin['via'];
  tokenName?: string;
}

/** A token pasted in the post dialog: kept in the server's memory only (§15 #73). */
export interface PastedToken {
  token: string;
  name?: string;
}

/**
 * The host of a report, with a pasted token first, else the login found now: `gh auth login`
 * needs no restart.
 */
export async function hostOf(
  plan: ReviewPlan,
  io: CliIo,
  pasted?: PastedToken,
): Promise<HostAccess> {
  const { kind, repo, prNumber } = plan.source;
  const [owner, name] = repo.split('/');
  if (kind !== 'github' || prNumber === undefined || !owner || !name) {
    throw new UsageError(
      'This report is of a local branch, so it has no pull request to post to.',
      '`bowi comments <dir> --markdown` prints the comments for pasting.',
    );
  }
  const given = io.github?.token;
  const login: GithubLogin = pasted
    ? { token: pasted.token, via: 'token' }
    : given
      ? { token: given, via: 'GITHUB_TOKEN' }
      : await findGithubLogin(io.env);
  const host = githubReviewHost({ owner, repo: name, number: prNumber }, login, {
    ...(io.github?.fetch && { fetch: io.github.fetch }),
    ...(io.github?.apiBase && { apiBase: io.github.apiBase }),
  });
  return { host, via: login.via, ...(pasted?.name && { tokenName: pasted.name }) };
}

/** What a dialog or prompt shows before anything is sent. */
export async function postStatus(access: HostAccess): Promise<PostStatus> {
  const { login, headSha, pending } = await access.host.status();
  return {
    login,
    via: access.via,
    ...(access.tokenName && { tokenName: access.tokenName }),
    headSha,
    ...(pending && { pending }),
  };
}

/** Why a pending review the reviewer already has stops this send, if it does. */
export function pendingConflict(
  status: Pick<PostStatus, 'pending'>,
  reportHead: string,
  mode: PostRequest['mode'],
): HostError | undefined {
  const pending = status.pending;
  if (!pending) return undefined;
  // Lines are read against the review's commit: on another one they could land on the wrong code.
  if (pending.headSha !== reportHead) {
    return new HostError(
      'other',
      `Your pending review on GitHub is on commit ${pending.headSha.slice(0, 7)}, this report on ${reportHead.slice(0, 7)}.`,
      'Submit or discard that review on GitHub, then post again.',
    );
  }
  if (mode === 'now') {
    return new HostError(
      'other',
      'You have a pending review on this pull request, so new comments can only join it.',
      'Submit it on GitHub first to post right away, or send these as pending.',
    );
  }
  return undefined;
}

/** Writes the review inside review.html, when the folder has a page that holds one. */
async function writePage(dir: string, plan: ReviewPlan): Promise<void> {
  const path = join(dir, HTML_FILE);
  const page = await readFile(path, 'utf8').catch(() => undefined);
  if (page !== undefined && supportsComments(page)) {
    await writeFileAtomic(path, withReview(page, plan.review));
  }
}

function toHost(c: ReviewComment, onLines: boolean): HostComment {
  const { path, line, side, startLine, startSide } = c.anchor;
  if (!onLines || line === undefined || side === undefined) {
    return { path, body: bodyOnFile(c) };
  }
  return {
    path,
    body: c.body,
    line,
    side,
    ...(startLine !== undefined && { startLine, startSide: startSide ?? side }),
  };
}

/** Sends what was asked and records it; a host's refusal comes back in `error`, never thrown. */
export async function sendReview(
  dir: string,
  request: PostRequest,
  access: HostAccess,
  now: () => Date = () => new Date(),
): Promise<PostResult> {
  const plan = await readReport(dir);
  const review = plan.review ?? emptyReview();
  plan.review = review;
  const wanted = new Set(request.commentIds);
  const comments = sortComments(review.comments).filter((c) => wanted.has(c.id) && !c.sync);
  const withSummary = request.summary && !review.bodySync && review.body.trim() !== '';
  const result: PostResult = {
    review,
    mode: request.mode,
    sent: 0,
    summarySent: false,
    summaryLeftOut: false,
    onFile: [],
    failed: [],
  };
  if (comments.length === 0 && !withSummary) return result;

  const save = () => writeFileAtomic(join(dir, PLAN_FILE), planJson(plan));
  const record = (ref: HostRef): ReviewSync => ({
    host: 'github',
    id: ref.id,
    url: ref.url,
    syncedAt: now().toISOString(),
    pending: true,
  });

  try {
    const status = await access.host.status();
    result.login = status.login;
    const conflict = pendingConflict(status, plan.source.headSha, request.mode);
    if (conflict) throw conflict;

    let reviewId = status.pendingId;
    if (reviewId === undefined) {
      const started = await access.host.startReview(
        plan.source.headSha,
        withSummary ? review.body : undefined,
      );
      reviewId = started.id;
      if (withSummary) {
        review.bodySync = record(started);
        result.summarySent = true;
      }
    } else if (withSummary) {
      if (status.pending?.hasBody) result.summaryLeftOut = true;
      else {
        review.bodySync = record(await access.host.setSummary(reviewId, review.body));
        result.summarySent = true;
      }
    }
    if (result.summarySent) await save();

    for (const c of comments) {
      const where = { id: c.id, path: c.anchor.path, label: anchorLabel(c.anchor) };
      const onLines = c.status === 'active' && c.anchor.line !== undefined;
      let answer = await access.host.addComment(reviewId, toHost(c, onLines));
      // Outside the host's diff, as with a rename found differently: on the file instead.
      if ('refused' in answer && onLines) {
        answer = await access.host.addComment(reviewId, toHost(c, false));
        if (!('refused' in answer)) result.onFile.push(where);
      }
      if ('refused' in answer) {
        result.failed.push({ ...where, message: answer.refused });
        continue;
      }
      c.sync = record(answer);
      result.sent++;
      await save();
    }

    if (request.mode === 'now' && result.sent + Number(result.summarySent) > 0) {
      await access.host.publish(reviewId);
      for (const c of comments) if (c.sync) c.sync.pending = false;
      if (result.summarySent && review.bodySync) review.bodySync.pending = false;
      await save();
    }
  } catch (e) {
    if (!(e instanceof HostError)) throw e;
    result.error = {
      kind: e.kind,
      message: e.message,
      ...(e.hint !== undefined && { hint: e.hint }),
    };
  }
  await writePage(dir, plan);
  return result;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "5 comments and the summary", for what a send is about. */
export function sentWhat(comments: number, summary: boolean): string {
  if (comments > 0) return plural(comments, 'comment') + (summary ? ' and the summary' : '');
  return summary ? 'the summary' : plural(0, 'comment');
}

export { plural as pluralWord };
