/**
 * The reviewer's comments (M10, UI-25..27): helpers shared by the report page and the CLI.
 *
 * Comments are user data kept in `ReviewPlan.review`; the engine never reads them. This module
 * runs in the browser too, so it imports nothing but types.
 */

import { compareStrings } from './determinism.ts';
import type {
  CommentAnchor,
  DiffLine,
  Hunk,
  Review,
  ReviewComment,
  ReviewPlan,
  ReviewSync,
  SnippetLine,
} from './types.ts';

export type Side = 'old' | 'new';

/** One line of one side of the diff: what a comment points at. */
export interface LineRef {
  side: Side;
  line: number;
}

export const emptyReview = (): Review => ({ body: '', comments: [] });

/** Whether a review holds anything worth keeping. */
export const hasReview = (r: Review | undefined): r is Review =>
  !!r && (r.body.trim() !== '' || r.comments.length > 0);

/**
 * The line a diff row stands for. Deleted lines are on the old side, added lines on the new one;
 * a context line is on the new side unless commented in the old column of the split layout.
 */
export function lineRefOf(l: DiffLine | SnippetLine, column?: Side): LineRef {
  if (l.kind === 'del') return { side: 'old', line: l.oldNo! };
  if (l.kind === 'add') return { side: 'new', line: l.newNo! };
  return column === 'old' ? { side: 'old', line: l.oldNo! } : { side: 'new', line: l.newNo! };
}

/** Whether a diff row shows the given line (a context row shows one line of each side). */
export function rowShows(l: DiffLine, ref: LineRef): boolean {
  return ref.side === 'old'
    ? l.kind !== 'add' && l.oldNo === ref.line
    : l.kind !== 'del' && l.newNo === ref.line;
}

/** First and last line of a line comment; undefined for a file comment. */
export function anchorRange(a: CommentAnchor): { start: LineRef; end: LineRef } | undefined {
  if (a.line === undefined || a.side === undefined) return undefined;
  const end = { side: a.side, line: a.line };
  const start =
    a.startLine !== undefined ? { side: a.startSide ?? a.side, line: a.startLine } : end;
  return { start, end };
}

/** Anchor for rows `from`..`to` (indexes into `hunk.lines`, either order) of a hunk. */
export function anchorFor(
  path: string,
  headSha: string,
  hunk: Hunk,
  from: { index: number; column?: Side },
  to: { index: number; column?: Side },
): CommentAnchor {
  const [first, last] = from.index <= to.index ? [from, to] : [to, from];
  const start = lineRefOf(hunk.lines[first.index]!, first.column);
  const end = lineRefOf(hunk.lines[last.index]!, last.column);
  return {
    path,
    headSha,
    hunkId: hunk.id,
    line: end.line,
    side: end.side,
    ...(first.index !== last.index && { startLine: start.line, startSide: start.side }),
  };
}

/** Indexes of the first and last row of a line comment in a hunk, when the hunk shows both. */
export function rowsOf(hunk: Hunk, a: CommentAnchor): [number, number] | undefined {
  const range = anchorRange(a);
  if (!range) return undefined;
  const last = hunk.lines.findIndex((l) => rowShows(l, range.end));
  if (last < 0) return undefined;
  const first = hunk.lines.findIndex((l) => rowShows(l, range.start));
  return first < 0 || first > last ? undefined : [first, last];
}

/** The rows a comment was written on, without highlighting. */
export function snippetOf(hunk: Hunk, first: number, last: number): SnippetLine[] {
  return hunk.lines.slice(first, last + 1).map((l) => ({
    kind: l.kind,
    text: l.text,
    ...(l.oldNo !== undefined && { oldNo: l.oldNo }),
    ...(l.newNo !== undefined && { newNo: l.newNo }),
  }));
}

/** "File comment", "Line 18", "Lines 44–46", "Old line 1", "Old line 1 to line 2". */
export function anchorLabel(a: CommentAnchor): string {
  const range = anchorRange(a);
  if (!range) return 'File comment';
  const { start, end } = range;
  const one = (r: LineRef) => `${r.side === 'old' ? 'Old line' : 'Line'} ${r.line}`;
  if (start.side === end.side && start.line === end.line) return one(end);
  if (start.side === end.side)
    return `${end.side === 'old' ? 'Old lines' : 'Lines'} ${start.line}–${end.line}`;
  return `${one(start)} to ${one(end).toLowerCase()}`;
}

/** A random comment id; `crypto.getRandomValues` works on `file://` pages too. */
export function newCommentId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `c-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface CarryResult {
  review: Review;
  /** Comments still on their lines, `moved` of them at a new position. */
  kept: number;
  moved: number;
  /** Comments whose lines changed: kept with their snippet, as GitHub does after a push. */
  outdated: number;
}

/**
 * Carries the comments of an earlier plan over to a new one (§15 #64). A comment whose lines
 * still read the same moves to where they are now; one whose lines changed or disappeared is kept
 * as outdated. Nothing is dropped.
 */
export function carryReview(old: Review, plan: ReviewPlan): CarryResult {
  let kept = 0;
  let moved = 0;
  let outdated = 0;
  const headSha = plan.source.headSha;
  const comments = old.comments.map((c): ReviewComment => {
    const next = c.status === 'outdated' ? undefined : relocate(c, plan);
    if (!next) {
      outdated++;
      return c.status === 'outdated' ? c : { ...c, status: 'outdated' };
    }
    kept++;
    if (next.moved) moved++;
    return { ...c, anchor: { ...next.anchor, headSha } };
  });
  return { review: { ...old, comments }, kept, moved, outdated };
}

function relocate(
  c: ReviewComment,
  plan: ReviewPlan,
): { anchor: CommentAnchor; moved: boolean } | undefined {
  const a = c.anchor;
  const file =
    plan.files.find((f) => f.path === a.path) ??
    plan.files.find((f) => f.oldPath === a.path && f.status === 'renamed');
  if (!file) return undefined;
  const range = anchorRange(a);
  if (!range) return { anchor: { path: file.path, headSha: a.headSha }, moved: false };

  const hunks = plan.hunks.filter((h) => h.fileId === file.id);
  const fits = (h: Hunk, first: number) =>
    first + c.snippet.length <= h.lines.length &&
    c.snippet.every((s, k) => {
      const l = h.lines[first + k]!;
      return l.kind === s.kind && l.text === s.text;
    });
  const candidates: { hunk: Hunk; first: number }[] = [];
  for (const h of hunks) {
    for (let i = 0; i < h.lines.length; i++) if (fits(h, i)) candidates.push({ hunk: h, first: i });
  }
  if (candidates.length === 0 || c.snippet.length === 0) return undefined;
  // Several places read the same: the one nearest to where the comment was.
  const distance = (x: { hunk: Hunk; first: number }) => {
    const ref = lineRefOf(x.hunk.lines[x.first]!, range.start.side);
    return Math.abs(ref.line - range.start.line);
  };
  const best = candidates.reduce((b, x) => (distance(x) < distance(b) ? x : b));
  const last = best.first + c.snippet.length - 1;
  const anchor = {
    ...anchorFor(
      file.path,
      a.headSha,
      best.hunk,
      { index: best.first, column: range.start.side },
      { index: last, column: range.end.side },
    ),
  };
  const moved =
    anchor.path !== a.path ||
    anchor.line !== a.line ||
    anchor.side !== a.side ||
    anchor.startLine !== a.startLine;
  return { anchor, moved };
}

/** Comments in reading order of the plan's files: path, then line; file comments first. */
export function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  const key = (c: ReviewComment) => {
    const r = anchorRange(c.anchor);
    return r ? r.end.line : 0;
  };
  return [...comments].sort(
    (x, y) => compareStrings(x.anchor.path, y.anchor.path) || key(x) - key(y),
  );
}

/**
 * The whole review as Markdown, for pasting anywhere (UI-27 "Copy all as Markdown", `bowi
 * comments --markdown`): the summary, each comment with the lines it is about, outdated last.
 */
export function reviewMarkdown(review: Review): string {
  const parts: string[] = [];
  if (review.body.trim()) parts.push(review.body.trim());
  const section = (c: ReviewComment) => {
    const where = anchorLabel(c.anchor);
    const title =
      where === 'File comment'
        ? `### \`${c.anchor.path}\``
        : `### \`${c.anchor.path}\` ${where.charAt(0).toLowerCase()}${where.slice(1)}`;
    const out = [
      c.status === 'outdated'
        ? `${title} (outdated, written on ${c.anchor.headSha.slice(0, 7)})`
        : title,
    ];
    if (c.snippet.length > 0) out.push(snippetFence(c.snippet));
    out.push(c.body.trim());
    return out.join('\n\n');
  };
  const sorted = sortComments(review.comments);
  for (const c of sorted.filter((x) => x.status === 'active')) parts.push(section(c));
  const old = sorted.filter((x) => x.status === 'outdated');
  if (old.length > 0) parts.push('## Outdated', ...old.map(section));
  return parts.join('\n\n') + (parts.length ? '\n' : '');
}

function snippetFence(snippet: readonly SnippetLine[]): string {
  const code = snippet
    .map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
    .join('\n');
  const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
  return `${fence}diff\n${code}\n${fence}`;
}

function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * A save from the page, with what already went to the host taken from `current` (§15 #70): sent
 * comments and a sent summary are read-only, whatever an old tab or a hand-made request says, and
 * only the server marks something as sent or posted (`setPosted`).
 */
export function keepSent(current: Review, incoming: Review): Review {
  const sent = new Map(current.comments.filter((c) => c.sync).map((c) => [c.id, c]));
  const comments = incoming.comments.map((c) => {
    const kept = sent.get(c.id);
    if (kept) return kept;
    if (!c.sync) return c;
    const copy = { ...c };
    delete copy.sync;
    return copy;
  });
  const shown = new Set(comments.map((c) => c.id));
  for (const c of sent.values()) if (!shown.has(c.id)) comments.push(c);
  return current.bodySync
    ? { body: current.body, bodySync: current.bodySync, comments }
    : { body: incoming.body, comments };
}

/** What "I submitted it" changes, and what its Undo changes back (§15 #72). */
export interface PostedMark {
  ids: string[];
  summary: boolean;
  posted: boolean;
}

/**
 * The review with the given sent comments (and the summary) marked as posted, or back to pending:
 * the reviewer says the pending review was submitted on the host, or takes that back.
 */
export function setPosted(review: Review, mark: PostedMark): Review {
  const ids = new Set(mark.ids);
  const set = (s: ReviewSync) => ({ ...s, pending: !mark.posted });
  return {
    ...review,
    ...(review.bodySync && { bodySync: mark.summary ? set(review.bodySync) : review.bodySync }),
    comments: review.comments.map((c) =>
      c.sync && ids.has(c.id) ? { ...c, sync: set(c.sync) } : c,
    ),
  };
}

/**
 * The text of a comment placed on its file instead of its lines: an outdated comment, quoting the
 * lines it was written on, or one whose lines the host refused, starting with them.
 */
export function bodyOnFile(c: ReviewComment): string {
  const where = anchorLabel(c.anchor);
  if (c.anchor.line === undefined) return c.body;
  if (c.status === 'outdated' && c.snippet.length > 0) {
    const head = `${where}, written on \`${c.anchor.headSha.slice(0, 7)}\`:`;
    return `${head}\n\n${snippetFence(c.snippet)}\n\n${c.body}`;
  }
  return `${where}:\n\n${c.body}`;
}

/** The address of a report's pull request; undefined for a local report. */
export function pullRequestUrl(source: {
  kind: string;
  repo: string;
  prNumber?: number;
}): string | undefined {
  if (source.kind !== 'github' || source.prNumber === undefined) return undefined;
  return `https://github.com/${source.repo}/pull/${source.prNumber}`;
}

/** What the page and `bowi comments push` learn before sending (M11, UI-28). */
export interface PostStatus {
  login: string;
  /** Which login: the GitHub CLI's, the environment variable, or a token pasted in the dialog. */
  via: 'gh' | 'GITHUB_TOKEN' | 'token';
  /** The name the reviewer gave a pasted token, if any. */
  tokenName?: string;
  /** The pull request's head on the host now; the report's own is in the plan. */
  headSha: string;
  /** The reviewer's pending review on this pull request, if any. */
  pending?: { comments: number; hasBody: boolean; headSha: string };
}

export interface PostRequest {
  mode: 'pending' | 'now';
  commentIds: string[];
  summary: boolean;
}

export type PostFailureKind = 'login' | 'read-only' | 'uncertain' | 'limit' | 'other';

export interface PostFailure {
  kind: PostFailureKind;
  message: string;
  hint?: string;
}

/** What a send did. Everything in `sent` is recorded, also when it stopped half way. */
export interface PostResult {
  review: Review;
  /** Who it went as; undefined when it stopped before asking the host. */
  login?: string;
  mode: 'pending' | 'now';
  sent: number;
  summarySent: boolean;
  /** The reviewer's pending review already has a summary. */
  summaryLeftOut: boolean;
  /** Sent, but on the file because the host refused the lines. */
  onFile: { id: string; path: string; label: string }[];
  /** Not sent: the host refused the file too. */
  failed: { id: string; path: string; label: string; message: string }[];
  /** Why it stopped before the end, or could not publish. */
  error?: PostFailure;
}
