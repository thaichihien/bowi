import { describe, expect, it } from 'vitest';
import { comparablePlanJson } from '../src/determinism.ts';
import {
  anchorFor,
  anchorLabel,
  carryReview,
  reviewMarkdown,
  rowsOf,
  snippetOf,
} from '../src/review.ts';
import { parseReview } from '../src/review-schema.ts';
import type { DiffLine, Hunk, Review, ReviewComment, ReviewPlan } from '../src/types.ts';

const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
  kind: 'context',
  text,
  oldNo,
  newNo,
});
const add = (newNo: number, text: string): DiffLine => ({ kind: 'add', text, newNo });
const del = (oldNo: number, text: string): DiffLine => ({ kind: 'del', text, oldNo });

function hunk(id: string, fileId: string, lines: DiffLine[]): Hunk {
  return {
    id,
    fileId,
    header: '',
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: 0,
    lines,
    kind: 'logic',
    symbolIds: [],
  };
}

function plan(headSha: string, hunks: Hunk[], files = [{ id: 'f1', path: 'src/a.ts' }]) {
  return {
    source: { headSha },
    files: files.map((f) => ({ status: 'modified', ...f })),
    hunks,
  } as unknown as ReviewPlan;
}

const first = hunk('f1:h0', 'f1', [
  ctx(1, 1, 'import x;'),
  del(2, 'old();'),
  add(2, 'const token = make();'),
  add(3, 'save(token);'),
  ctx(3, 4, 'return;'),
]);

function comment(h: Hunk, from: number, to: number, extra: Partial<ReviewComment> = {}) {
  return {
    id: `c-${from}-${to}`,
    body: 'Why?',
    anchor: anchorFor('src/a.ts', 'aaaaaaa', h, { index: from }, { index: to }),
    snippet: snippetOf(h, from, to),
    createdAt: '2026-11-05T10:00:00Z',
    updatedAt: '2026-11-05T10:00:00Z',
    status: 'active',
    ...extra,
  } as ReviewComment;
}

describe('anchors', () => {
  it('anchors a range on the sides of its first and last rows, like GitHub', () => {
    expect(anchorFor('src/a.ts', 'aaa', first, { index: 3 }, { index: 1 })).toEqual({
      path: 'src/a.ts',
      headSha: 'aaa',
      hunkId: 'f1:h0',
      line: 3,
      side: 'new',
      startLine: 2,
      startSide: 'old',
    });
    // A context line is on the new side, unless picked in the old column of the split layout.
    expect(anchorFor('p', 'h', first, { index: 4 }, { index: 4 })).toMatchObject({
      line: 4,
      side: 'new',
    });
    expect(
      anchorFor('p', 'h', first, { index: 4, column: 'old' }, { index: 4, column: 'old' }),
    ).toMatchObject({ line: 3, side: 'old' });
  });

  it('finds the rows of an anchor and labels it for people', () => {
    const c = comment(first, 2, 3);
    expect(rowsOf(first, c.anchor)).toEqual([2, 3]);
    expect(anchorLabel(c.anchor)).toBe('Lines 2–3');
    expect(anchorLabel(comment(first, 1, 1).anchor)).toBe('Old line 2');
    expect(anchorLabel(comment(first, 1, 2).anchor)).toBe('Old line 2 to line 2');
    expect(anchorLabel({ path: 'src/a.ts', headSha: 'h' })).toBe('File comment');
  });
});

describe('carryReview', () => {
  const review: Review = {
    body: 'Summary',
    comments: [
      comment(first, 2, 3),
      comment(first, 1, 1),
      { ...comment(first, 0, 0), id: 'file', anchor: { path: 'src/a.ts', headSha: 'aaaaaaa' } },
    ],
  };

  it('keeps comments in place when the lines are unchanged', () => {
    const r = carryReview(review, plan('bbbbbbb', [first]));
    expect([r.kept, r.moved, r.outdated]).toEqual([3, 0, 0]);
    expect(r.review.comments.every((c) => c.anchor.headSha === 'bbbbbbb')).toBe(true);
    expect(r.review.body).toBe('Summary');
  });

  it('moves a comment to where its lines are now, and marks others outdated', () => {
    // Two lines added above: the commented lines moved down; the deleted line is gone.
    const shifted = hunk('f1:h0', 'f1', [
      ctx(1, 1, 'import x;'),
      add(2, 'import y;'),
      add(3, 'import z;'),
      add(4, 'const token = make();'),
      add(5, 'save(token);'),
      ctx(2, 6, 'return;'),
    ]);
    const r = carryReview(review, plan('ccccccc', [shifted]));
    expect([r.kept, r.moved, r.outdated]).toEqual([2, 1, 1]);
    const [range, oldLine, file] = r.review.comments;
    expect(range!.anchor).toMatchObject({ line: 5, startLine: 4, side: 'new' });
    expect(range!.snippet).toEqual(review.comments[0]!.snippet);
    // The outdated comment keeps the anchor and head it was written on.
    expect(oldLine!.status).toBe('outdated');
    expect(oldLine!.anchor).toEqual(review.comments[1]!.anchor);
    expect(file!.status).toBe('active');
  });

  it('follows a renamed file and makes everything outdated when the file is gone', () => {
    const renamed = plan(
      'ddddddd',
      [hunk('f1:h0', 'f1', first.lines)],
      [{ id: 'f1', path: 'src/b.ts', oldPath: 'src/a.ts', status: 'renamed' } as never],
    );
    const r = carryReview(review, renamed);
    expect(r.outdated).toBe(0);
    expect(r.review.comments.map((c) => c.anchor.path)).toEqual([
      'src/b.ts',
      'src/b.ts',
      'src/b.ts',
    ]);
    expect(carryReview(review, plan('e', [], [])).outdated).toBe(3);
  });

  it('never brings an outdated comment back', () => {
    const outdated = { ...comment(first, 2, 3), status: 'outdated' as const };
    const r = carryReview({ body: '', comments: [outdated] }, plan('f', [first]));
    expect(r.review.comments[0]).toEqual(outdated);
  });
});

describe('reviewMarkdown', () => {
  it('writes the summary, each comment with its lines, outdated last', () => {
    const md = reviewMarkdown({
      body: 'Looks good.',
      comments: [
        { ...comment(first, 1, 1), status: 'outdated', body: 'Gone now.' },
        { ...comment(first, 2, 3), body: 'Send first?' },
        {
          ...comment(first, 0, 0),
          anchor: { path: 'src/a.ts', headSha: 'h' },
          snippet: [],
          body: 'Needs a test.',
        },
      ],
    });
    expect(md).toBe(
      [
        'Looks good.',
        '### `src/a.ts`',
        'Needs a test.',
        '### `src/a.ts` lines 2–3',
        '```diff\n+const token = make();\n+save(token);\n```',
        'Send first?',
        '## Outdated',
        '### `src/a.ts` old line 2 (outdated, written on aaaaaaa)',
        '```diff\n-old();\n```',
        'Gone now.',
      ].join('\n\n') + '\n',
    );
    expect(reviewMarkdown({ body: '', comments: [] })).toBe('');
  });

  it('uses a longer fence when the code holds one', () => {
    const h = hunk('f1:h0', 'f1', [add(1, 'const s = "```";')]);
    expect(reviewMarkdown({ body: '', comments: [comment(h, 0, 0)] })).toContain('````diff');
  });
});

describe('parseReview', () => {
  it('accepts a review and names what is wrong with anything else', () => {
    const good = { body: '', comments: [comment(first, 2, 3)] };
    expect(parseReview(good)).toEqual({ review: good });
    expect(parseReview({ body: 1, comments: [] })).toHaveProperty('error');
    const twice = { body: '', comments: [comment(first, 2, 3), comment(first, 2, 3)] };
    expect(parseReview(twice)).toEqual({ error: 'comment ids repeat at comments' });
    const extra = { body: '', comments: [], author: 'me' };
    expect(parseReview(extra)).toHaveProperty('error');
  });
});

describe('comparablePlanJson', () => {
  it('leaves the reviewer’s comments out', () => {
    const p = { ...plan('a', [first]), meta: { timingsMs: {} } } as unknown as ReviewPlan;
    expect(comparablePlanJson({ ...p, review: { body: 'x', comments: [] } })).toBe(
      comparablePlanJson(p),
    );
  });
});
