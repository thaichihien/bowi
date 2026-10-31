/**
 * Snapshot: what a source hands to the engine (SRC-1).
 *
 * The engine only sees this interface, never which source produced it. "old" is the merge base
 * version of a file and "new" is the head version (a commit for GitHub, the working tree for
 * --local).
 *
 * The history and search methods are optional: a snapshot without them gives a plan without
 * `same-commit` / `co-change` edges or outside references.
 */

import type { ReviewPlan } from './types.ts';

export type SnapshotMeta = ReviewPlan['source'];

export type FileVersion = 'old' | 'new';

export interface GrepMatch {
  path: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface Snapshot {
  meta: SnapshotMeta;
  /**
   * Unified diff from the merge base to head, produced by git with renames detected, 3 lines of
   * context, `a/` and `b/` prefixes, and unquoted UTF-8 paths (DIFF-1).
   */
  readDiff(): Promise<string>;
  /** File contents at one side of the diff, or null when the file does not exist there. */
  readFile(version: FileVersion, path: string): Promise<string | null>;
  /**
   * For each line of the head version of each path, the SHA of the commit between the merge base
   * and head that last changed it; null for lines older than the merge base or not committed
   * yet. Paths without history (e.g. untracked files) are left out. For `same-commit` edges
   * (GRAPH-6). One call for all paths, so a source can fetch what it needs at once.
   */
  blame?(paths: string[]): Promise<Map<string, (string | null)[]>>;
  /**
   * Paths changed by each of the last `limit` non-merge commits reachable from the merge base,
   * newest first. For `co-change` edges (GRAPH-7).
   */
  baseHistory?(limit: number): Promise<string[][]>;
  /**
   * Lines of the head version that contain one of `words` as a whole word, in files whose path
   * ends with one of `extensions` (e.g. `.ts`). For outside references (GRAPH-11).
   */
  grep?(words: string[], extensions: string[]): Promise<GrepMatch[]>;
}
