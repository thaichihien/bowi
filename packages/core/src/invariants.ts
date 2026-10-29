/**
 * Invariants checked on every run. A violation is a bug in Bowi: it fails the run with exit
 * code 3 rather than producing a misleading review.
 */

import { AnalysisError } from './errors.ts';
import type { Group, Hunk } from './types.ts';

/** GRP-4: every hunk is in exactly one step of exactly one group. */
export function assertPartition(groups: Group[], hunks: Hunk[]): void {
  const seen = new Map<string, string>();
  for (const g of groups) {
    for (const s of g.steps) {
      for (const id of s.hunkIds) {
        const prev = seen.get(id);
        if (prev)
          throw new AnalysisError(
            `Hunk ${id} is in both ${prev} and ${s.id} (partition invariant)`,
          );
        seen.set(id, s.id);
      }
    }
  }
  const missing = hunks.filter((h) => !seen.has(h.id)).map((h) => h.id);
  if (missing.length)
    throw new AnalysisError(`Hunks not in any group: ${missing.join(', ')} (partition invariant)`);
  const known = new Set(hunks.map((h) => h.id));
  const unknown = [...seen.keys()].filter((id) => !known.has(id));
  if (unknown.length)
    throw new AnalysisError(`Groups reference unknown hunks: ${unknown.join(', ')}`);
}
