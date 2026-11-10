/**
 * Where a report's comments can be sent (M11, §15 #70): the steps of sending a review, so another
 * host (GitLab, M13) needs no change in the CLI or the page. Bowi only sends: nothing here reads
 * comments back.
 */

import { SourceError } from './errors.ts';
import type { PostFailureKind, PostStatus } from './review.ts';

export interface HostRef {
  id: string;
  url: string;
}

/** A comment on a file, or on lines of it when `line` is set. */
export interface HostComment {
  path: string;
  body: string;
  line?: number;
  side?: 'old' | 'new';
  startLine?: number;
  startSide?: 'old' | 'new';
}

export interface ReviewHost {
  /** Who is logged in, the head now, and any pending review of theirs. */
  status(): Promise<Omit<PostStatus, 'via'> & { pendingId?: string }>;
  /** A new pending review on a commit: only its author sees it. */
  startReview(headSha: string, body?: string): Promise<HostRef>;
  /** Sets the summary of a pending review. */
  setSummary(reviewId: string, body: string): Promise<HostRef>;
  /** Adds a comment to a pending review, or says why the host refused its place. */
  addComment(reviewId: string, comment: HostComment): Promise<HostRef | { refused: string }>;
  /** Makes a pending review public, as a comment: it neither approves nor requests changes. */
  publish(reviewId: string): Promise<void>;
}

/** A host's answer that stops a send. `uncertain`: the last request may have arrived anyway. */
export class HostError extends SourceError {
  readonly kind: PostFailureKind;
  constructor(kind: PostFailureKind, message: string, hint?: string) {
    super(message, hint);
    this.kind = kind;
  }
}
