/**
 * The reviewer's comments in the page (M10, UI-25..27): what is shown, and where it is saved.
 *
 * Served by `bowi serve` (an `http://127.0.0.1` address with `?t=<token>`): the page loads the
 * comments from the server and saves every change into the plan right away. Opened as a file,
 * it starts from the comments embedded when the report was written; new, edited and deleted
 * comments become drafts in this browser ("Not saved"), and the served page later offers to save
 * them. A save that fails (the server was stopped) keeps the change as a draft too. Storage can be
 * missing or throw, so every access is guarded (as in progress.ts). What went to GitHub (M11) is
 * read-only here: edits, deletes and drafts leave it alone, and the server enforces the same.
 */

import {
  requestWords,
  setPosted,
  type PostedMark,
  type PostFailure,
  type PostRequest,
  type PostResult,
  type PostStatus,
} from '@bowi/core/review';
import type { Review, ReviewComment, ReviewPlan } from '@bowi/core/types';

export type SaveStatus = 'file' | 'loading' | 'saving' | 'saved' | 'offline' | 'stale';

/** Stands for the review summary in the sets of unsaved and deleted ids. */
export const SUMMARY_ID = '#summary';

export const DRAFT_PREFIX = 'bowi:comments:';
/** Drafts are written work, so they last longer than review progress (a week). */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Typing in the summary saves after a pause, not on every key. */
const TYPING_DELAY_MS = 600;

interface Draft {
  savedAt: number;
  review: Review;
  unsaved: string[];
  deleted: string[];
}

export interface Server {
  base: string;
  token: string;
}

/** The server this page was opened from, when `bowi serve` served it. */
export function serverOf(
  loc: Pick<Location, 'protocol' | 'search' | 'origin'>,
): Server | undefined {
  if (loc.protocol !== 'http:') return undefined;
  const token = new URLSearchParams(loc.search).get('t');
  return token ? { base: loc.origin, token } : undefined;
}

/** The folder of a report opened as a file, as the system writes paths. */
export function reportFolder(loc: Pick<Location, 'protocol' | 'pathname'>): string | undefined {
  if (loc.protocol !== 'file:') return undefined;
  let path = decodeURIComponent(loc.pathname).replace(/\/[^/]*$/, '');
  // file:///C:/Users/… on Windows.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1).replace(/\//g, '\\');
  return path || '/';
}

/** The command that serves a report folder, quoted for a shell when needed. */
export function serveCommand(folder: string | undefined): string {
  if (!folder) return 'bowi serve <report folder>';
  return /^[\w./\\:@~+-]+$/.test(folder) ? `bowi serve ${folder}` : `bowi serve "${folder}"`;
}

/** Drafts of a report: same repository and PR (or branch); they outlive re-runs. */
export function draftKey(plan: ReviewPlan): string {
  const s = plan.source;
  return `${DRAFT_PREFIX}${s.repo}${requestWords(s)?.ref ?? `@${s.headRef}`}`;
}

export interface PendingDrafts {
  count: number;
  save(): void;
  discard(): void;
}

export class ReviewStore {
  readonly mode: 'served' | 'file';
  status: SaveStatus;
  message: string | undefined;
  review: Review;
  /** Ids (and SUMMARY_ID) changed since the last save. */
  readonly unsaved = new Set<string>();
  private readonly deleted = new Set<string>();
  pending: PendingDrafts | undefined;
  /** The report folder, as the server names it. */
  folder: string | undefined;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving = false;
  private again = false;
  private readonly key: string;
  private readonly plan: ReviewPlan;
  private readonly server: Server | undefined;
  private readonly onChange: () => void;
  private readonly now: () => number;

  constructor(
    plan: ReviewPlan,
    server: Server | undefined,
    onChange: () => void,
    now: () => number = Date.now,
  ) {
    this.plan = plan;
    this.server = server;
    this.onChange = onChange;
    this.now = now;
    this.key = draftKey(plan);
    this.mode = server ? 'served' : 'file';
    this.review = plan.review ?? { body: '', comments: [] };
    pruneDrafts(now());
    if (server) {
      this.status = 'loading';
    } else {
      this.status = 'file';
      const draft = loadDraft(this.key);
      if (draft) {
        this.review = draft.review;
        for (const id of draft.unsaved) this.unsaved.add(id);
        for (const id of draft.deleted) this.deleted.add(id);
      }
    }
  }

  /** Served: loads the comments saved in the plan, then offers drafts left in this browser. */
  async load(): Promise<void> {
    if (!this.server) return;
    try {
      const res = await this.call('GET');
      if (!res.ok) throw new Error(await errorOf(res));
      const data = (await res.json()) as { generatedAt: string; review: Review; dir?: string };
      this.folder = data.dir;
      if (data.generatedAt !== this.plan.generatedAt) return this.stale();
      this.review = data.review;
      this.status = 'saved';
      this.message = undefined;
      const draft = loadDraft(this.key);
      const open = draft && this.withoutSent(draft);
      if (open && open.unsaved.length + open.deleted.length > 0) {
        this.pending = {
          count: new Set([...open.unsaved, ...open.deleted]).size,
          save: () => {
            this.pending = undefined;
            this.apply(open);
          },
          discard: () => {
            this.pending = undefined;
            removeDraft(this.key);
            this.onChange();
          },
        };
      }
    } catch (e) {
      this.status = 'offline';
      this.message = e instanceof Error ? e.message : String(e);
    }
    this.onChange();
  }

  /** Whether a comment (or SUMMARY_ID) shows "Not saved". */
  isUnsaved(id: string): boolean {
    return this.unsaved.has(id) && (this.mode === 'file' || this.status === 'offline');
  }

  add(c: ReviewComment): void {
    this.change({ ...this.review, comments: [...this.review.comments, c] }, [c.id], 0);
  }

  edit(id: string, body: string): void {
    if (this.isSent(id)) return;
    const at = new Date(this.now()).toISOString();
    const comments = this.review.comments.map((c) =>
      c.id === id ? { ...c, body, updatedAt: at } : c,
    );
    this.change({ ...this.review, comments }, [id], 0);
  }

  /** Deletes a comment; the returned function puts it back where it was. */
  remove(id: string): () => void {
    const index = this.review.comments.findIndex((c) => c.id === id);
    const comment = this.review.comments[index];
    if (!comment || comment.sync) return () => {};
    this.deleted.add(id);
    this.unsaved.delete(id);
    this.change(
      { ...this.review, comments: this.review.comments.filter((c) => c.id !== id) },
      [],
      0,
    );
    return () => {
      if (this.review.comments.some((c) => c.id === id)) return;
      const comments = [...this.review.comments];
      comments.splice(Math.min(index, comments.length), 0, comment);
      this.deleted.delete(id);
      this.change({ ...this.review, comments }, [id], 0);
    };
  }

  /** "Clear all comments": every comment and the summary, except what went to GitHub. */
  clear(): void {
    const kept = this.review.comments.filter((c) => c.sync);
    for (const c of this.review.comments) {
      if (c.sync) continue;
      this.deleted.add(c.id);
      this.unsaved.delete(c.id);
    }
    const { bodySync } = this.review;
    const next: Review = bodySync
      ? { body: this.review.body, bodySync, comments: kept }
      : { body: '', comments: kept };
    this.change(next, bodySync ? [] : [SUMMARY_ID], 0);
  }

  setBody(body: string): void {
    if (this.review.bodySync) return;
    this.change({ ...this.review, body }, [SUMMARY_ID], TYPING_DELAY_MS);
  }

  retry(): void {
    if (this.status === 'offline') this.schedule(0);
  }

  /**
   * "I submitted it" and its Undo, through the server: a save cannot change what was sent, so an
   * old tab cannot undo this either. False if the server could not do it.
   */
  async setPosted(mark: PostedMark): Promise<boolean> {
    if (!this.server) return false;
    try {
      const res = await this.call(
        'POST',
        { generatedAt: this.plan.generatedAt, ...mark },
        '/posted',
      );
      if (!res.ok) return false;
      this.review = setPosted(this.review, mark);
      this.onChange();
      return true;
    } catch {
      return false;
    }
  }

  private isSent(id: string): boolean {
    return this.review.comments.some((c) => c.id === id && c.sync);
  }

  /** A draft made before its comments were sent: those stay as sent. */
  private withoutSent(draft: Draft): Draft {
    const keep = (id: string) => (id === SUMMARY_ID ? !this.review.bodySync : !this.isSent(id));
    return { ...draft, unsaved: draft.unsaved.filter(keep), deleted: draft.deleted.filter(keep) };
  }

  /** Saves what is waiting, so a post sends what the page shows. False if it could not. */
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.unsaved.size + this.deleted.size > 0) await this.save();
    return this.status === 'saved' && this.unsaved.size + this.deleted.size === 0;
  }

  /** What the dialog shows; asks GitHub through the server, which holds the token. */
  async postStatus(): Promise<PostStatus | PostFailure> {
    return this.host<PostStatus>('GET');
  }

  /** Posts with this token from now on, if GitHub accepts it; the server keeps it in memory. */
  async useToken(token: string, name: string): Promise<PostStatus | PostFailure> {
    return this.host<PostStatus>('POST', { token, name }, '/token');
  }

  /** Back to the login Bowi finds on its own. */
  async forgetToken(): Promise<void> {
    await this.host<unknown>('DELETE', undefined, '/token');
  }

  /** Sends to GitHub and takes over what the server recorded. */
  async post(request: PostRequest): Promise<PostResult | PostFailure> {
    const answer = await this.host<PostResult>('POST', {
      generatedAt: this.plan.generatedAt,
      ...request,
    });
    if ('review' in answer) {
      this.review = answer.review;
      this.onChange();
    }
    return answer;
  }

  private async host<T>(
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    path = '',
  ): Promise<T | PostFailure> {
    try {
      const server = this.server!;
      const res = await fetch(`${server.base}/api/github${path}`, {
        method,
        headers: {
          'X-Bowi-Token': server.token,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 409) {
        this.stale(await errorOf(res));
        return { kind: 'other', message: this.message! };
      }
      const data = (await res.json().catch(() => ({}))) as {
        kind?: PostFailure['kind'];
        error?: string;
        hint?: string;
      };
      return {
        kind: data.kind ?? 'other',
        message: data.error ?? `HTTP ${res.status}`,
        ...(data.hint !== undefined && { hint: data.hint }),
      };
    } catch {
      return {
        kind: 'other',
        message: 'bowi serve is not running.',
        hint: 'Start it again and open the link it prints. Nothing was posted.',
      };
    }
  }

  /** Saves drafts from this browser into the served plan. */
  private apply(draft: Draft): void {
    const local = new Map(draft.review.comments.map((c) => [c.id, c]));
    const drop = new Set(draft.deleted);
    const comments = this.review.comments
      .filter((c) => !drop.has(c.id))
      .map((c) => (draft.unsaved.includes(c.id) ? (local.get(c.id) ?? c) : c));
    for (const id of draft.unsaved) {
      const c = local.get(id);
      if (c && !comments.some((x) => x.id === id)) comments.push(c);
    }
    const body = draft.unsaved.includes(SUMMARY_ID) ? draft.review.body : this.review.body;
    for (const id of draft.deleted) this.deleted.add(id);
    this.change({ body, comments }, draft.unsaved, 0);
  }

  private change(review: Review, touched: string[], delay: number): void {
    this.review = review;
    for (const id of touched) this.unsaved.add(id);
    if (this.mode === 'file') {
      this.persistDraft();
    } else if (this.status !== 'stale') {
      this.schedule(delay);
    }
    this.onChange();
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), delay);
  }

  private async save(): Promise<void> {
    if (this.saving) {
      this.again = true;
      return;
    }
    this.saving = true;
    this.status = 'saving';
    this.onChange();
    const sent = new Set(this.unsaved);
    const sentDeleted = new Set(this.deleted);
    try {
      const res = await this.call('PUT', {
        generatedAt: this.plan.generatedAt,
        review: this.review,
      });
      if (res.status === 409) {
        this.saving = false;
        return this.stale(await errorOf(res));
      }
      if (!res.ok) throw new Error(await errorOf(res));
      for (const id of sent) this.unsaved.delete(id);
      for (const id of sentDeleted) this.deleted.delete(id);
      this.status = 'saved';
      this.message = undefined;
      if (this.unsaved.size + this.deleted.size === 0) removeDraft(this.key);
    } catch (e) {
      // Stopped server, sleeping laptop: keep the change in this browser until it can be saved.
      this.status = 'offline';
      this.message = e instanceof Error ? e.message : String(e);
      this.persistDraft();
    }
    this.saving = false;
    if (this.again) {
      this.again = false;
      this.schedule(0);
    }
    this.onChange();
  }

  private stale(message?: string): void {
    this.status = 'stale';
    this.message = message ?? 'The report was written again since this page was opened.';
    this.persistDraft();
    this.onChange();
  }

  private call(method: 'GET' | 'PUT' | 'POST', body?: unknown, path = ''): Promise<Response> {
    const server = this.server!;
    return fetch(`${server.base}/api/review${path}`, {
      method,
      headers: {
        'X-Bowi-Token': server.token,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  private persistDraft(): void {
    if (this.unsaved.size + this.deleted.size === 0) return removeDraft(this.key);
    const draft: Draft = {
      savedAt: this.now(),
      review: this.review,
      unsaved: [...this.unsaved],
      deleted: [...this.deleted],
    };
    try {
      storage()?.setItem(this.key, JSON.stringify(draft));
    } catch {
      // Full or blocked storage: the draft lasts until the page closes.
    }
  }
}

async function errorOf(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function storage(): Storage | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function loadDraft(key: string): Draft | undefined {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return undefined;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (
      typeof d.savedAt !== 'number' ||
      typeof d.review?.body !== 'string' ||
      !Array.isArray(d.review.comments) ||
      !Array.isArray(d.unsaved) ||
      !Array.isArray(d.deleted)
    )
      return undefined;
    return d as Draft;
  } catch {
    return undefined;
  }
}

function removeDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Blocked storage: nothing was saved there either.
  }
}

/** Deletes drafts not touched for DRAFT_TTL_MS, and unreadable ones. */
function pruneDrafts(now: number): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const d = loadDraft(k);
      if (!d || now - d.savedAt > DRAFT_TTL_MS) store.removeItem(k);
    }
  } catch {
    // Storage blocked mid-way.
  }
}
