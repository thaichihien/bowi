/**
 * Stage 5b: commit history for the weak grouping signals (GRAPH-6, GRAPH-7).
 *
 * Input: snapshot, files and hunks. Output: which commit of the PR last changed each line of
 * the head version of the changed files (only when the PR has more than one commit), and the
 * paths changed by each recent commit of the base history. Sources that cannot provide history
 * give empty results; the graph then has no `same-commit` / `co-change` edges.
 */

import type { Snapshot } from '../snapshot.ts';
import type { Stage } from '../stage.ts';
import type { FileChange, Hunk } from '../types.ts';

/** Commits of base history read for co-change (GRAPH-7 default). */
export const CO_CHANGE_COMMITS = 300;

export interface HistoryStageInput {
  snapshot: Snapshot;
  files: FileChange[];
  hunks: Hunk[];
}

export interface HistoryStageOutput {
  /** For blamed files, the PR commit of each head line (index = line − 1), by file ID. */
  lineCommits: Map<string, (string | null)[]>;
  /** Paths changed per commit of base history, newest first. */
  baseCommits: string[][];
}

export const historyStage: Stage<HistoryStageInput, HistoryStageOutput> = async (
  { snapshot, files, hunks },
  ctx,
) => {
  const logicFiles = files.filter(
    (f) => !f.generated && hunks.some((h) => h.fileId === f.id && h.kind === 'logic'),
  );
  const lineCommits = new Map<string, (string | null)[]>();
  const commits = new Set(snapshot.meta.commits.map((c) => c.sha));

  if (snapshot.blame && commits.size > 1) {
    const blamed = logicFiles.filter(
      (f) =>
        f.status !== 'deleted' &&
        hunks.some((h) => h.fileId === f.id && h.lines.some((l) => l.kind === 'add')),
    );
    try {
      const byPath = blamed.length
        ? await snapshot.blame(blamed.map((f) => f.path))
        : new Map<string, (string | null)[]>();
      for (const f of blamed) {
        const lines = byPath.get(f.path);
        if (lines)
          lineCommits.set(
            f.id,
            lines.map((sha) => (sha && commits.has(sha) ? sha : null)),
          );
      }
    } catch (e) {
      ctx.warn(
        `Could not read the history of the changed files (${e instanceof Error ? e.message : String(e)}); same-commit links skipped`,
      );
    }
  }

  let baseCommits: string[][] = [];
  if (snapshot.baseHistory && logicFiles.length > 1) {
    try {
      baseCommits = await snapshot.baseHistory(CO_CHANGE_COMMITS);
    } catch (e) {
      ctx.warn(
        `Could not read the base branch history (${e instanceof Error ? e.message : String(e)}); co-change links skipped`,
      );
    }
  }
  return { lineCommits, baseCommits };
};
