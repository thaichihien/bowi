/**
 * Validates a review that comes from outside the engine: the served page's saves (`bowi serve`)
 * and the `review` of an earlier plan file, which a person may have edited. Kept apart from
 * review.ts so the page does not bundle zod.
 */

import { z } from 'zod';
import type { Review } from './types.ts';

const side = z.enum(['old', 'new']);
const line = z.number().int().positive();
const text = (max: number) => z.string().max(max);

const anchor = z
  .object({
    path: text(4096).min(1),
    headSha: text(64),
    hunkId: text(64).optional(),
    line: line.optional(),
    side: side.optional(),
    startLine: line.optional(),
    startSide: side.optional(),
  })
  .strict()
  .refine((a) => (a.line === undefined) === (a.side === undefined), 'line and side go together')
  .refine(
    (a) => a.startLine === undefined || a.line !== undefined,
    'a range needs its last line too',
  );

const snippetLine = z
  .object({
    kind: z.enum(['context', 'add', 'del']),
    text: text(100_000),
    oldNo: line.optional(),
    newNo: line.optional(),
  })
  .strict();

const sync = z
  .object({
    host: z.literal('github'),
    id: text(256).min(1),
    // Shown as a link in the page, and a plan file may have been edited by hand.
    url: text(2048).regex(/^https:\/\//, 'must be an https address'),
    syncedAt: text(40),
    pending: z.boolean(),
  })
  .strict();

const comment = z
  .object({
    id: text(64).min(1),
    body: text(65_536),
    anchor,
    snippet: z.array(snippetLine).max(10_000),
    createdAt: text(40),
    updatedAt: text(40),
    status: z.enum(['active', 'outdated']),
    sync: sync.optional(),
  })
  .strict();

export const reviewSchema = z
  .object({
    body: text(65_536),
    bodySync: sync.optional(),
    comments: z
      .array(comment)
      .max(10_000)
      .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, 'comment ids repeat'),
  })
  .strict();

/** The review, or a short reason why it is not one. */
export function parseReview(value: unknown): { review: Review } | { error: string } {
  const r = reviewSchema.safeParse(value);
  if (r.success) return { review: r.data as Review };
  const issue = r.error.issues[0]!;
  const where = issue.path.length ? ` at ${issue.path.join('.')}` : '';
  return { error: `${issue.message}${where}` };
}
