/**
 * Determinism helpers (GRP-12, NFR-2).
 *
 * Output order must never depend on locale, hash-map iteration of unsorted input, or time.
 * Use these instead of `localeCompare` or ad-hoc sorting.
 */

import type { ReviewPlan } from './types.ts';

/** Locale-independent string order (UTF-16 code units), safe for stable output. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns a new array sorted by one or more keys, compared in order. Stable. */
export function sortBy<T>(items: readonly T[], ...keys: ((item: T) => string | number)[]): T[] {
  return [...items].sort((x, y) => {
    for (const key of keys) {
      const a = key(x);
      const b = key(y);
      const c =
        typeof a === 'number' && typeof b === 'number'
          ? a - b
          : compareStrings(String(a), String(b));
      if (c !== 0) return c;
    }
    return 0;
  });
}

/**
 * Serializes a plan for determinism comparison: `generatedAt` and `meta.timingsMs` are the only
 * fields allowed to differ between two runs on the same input.
 */
export function comparablePlanJson(plan: ReviewPlan): string {
  const { generatedAt: _generatedAt, ...rest } = plan;
  return JSON.stringify({ ...rest, meta: { ...rest.meta, timingsMs: {} } }, null, 2);
}
