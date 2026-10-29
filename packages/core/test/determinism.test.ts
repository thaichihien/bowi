import { describe, expect, it } from 'vitest';
import { compareStrings, comparablePlanJson, sortBy } from '../src/determinism.ts';
import type { ReviewPlan } from '../src/types.ts';

describe('compareStrings', () => {
  it('orders by code unit, not locale', () => {
    expect(['b', 'B', 'a', 'Z', 'ä'].sort(compareStrings)).toEqual(['B', 'Z', 'a', 'b', 'ä']);
  });
});

describe('sortBy', () => {
  it('sorts by keys in order and is stable', () => {
    const items = [
      { layer: 2, path: 'b', n: 1 },
      { layer: 1, path: 'z', n: 2 },
      { layer: 2, path: 'a', n: 3 },
      { layer: 2, path: 'a', n: 4 },
    ];
    expect(
      sortBy(
        items,
        (i) => i.layer,
        (i) => i.path,
      ).map((i) => i.n),
    ).toEqual([2, 3, 4, 1]);
  });

  it('does not mutate its input', () => {
    const items = [3, 1, 2];
    sortBy(items, (n) => n);
    expect(items).toEqual([3, 1, 2]);
  });
});

describe('comparablePlanJson', () => {
  it('ignores generatedAt and timings only', () => {
    const plan = (generatedAt: string, ms: number, title: string) =>
      ({
        schemaVersion: 1,
        generatedAt,
        source: { title },
        meta: { warnings: [], timingsMs: { diff: ms } },
      }) as unknown as ReviewPlan;
    expect(comparablePlanJson(plan('2026-01-01', 5, 'x'))).toBe(
      comparablePlanJson(plan('2026-02-02', 9, 'x')),
    );
    expect(comparablePlanJson(plan('2026-01-01', 5, 'x'))).not.toBe(
      comparablePlanJson(plan('2026-01-01', 5, 'y')),
    );
  });
});
