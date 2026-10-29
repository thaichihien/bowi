/**
 * Snapshot: what a source hands to the engine (SRC-1).
 *
 * The engine only sees this interface, never which source produced it. "old" is the merge base
 * version of a file and "new" is the head version (a commit for GitHub, the working tree for
 * --local).
 */

import type { ReviewPlan } from './types.ts';

export type SnapshotMeta = ReviewPlan['source'];

export type FileVersion = 'old' | 'new';

export interface Snapshot {
  meta: SnapshotMeta;
  /**
   * Unified diff from the merge base to head, produced by git with renames detected, 3 lines of
   * context, `a/` and `b/` prefixes, and unquoted UTF-8 paths (DIFF-1).
   */
  readDiff(): Promise<string>;
  /** File contents at one side of the diff, or null when the file does not exist there. */
  readFile(version: FileVersion, path: string): Promise<string | null>;
}
