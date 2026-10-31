/**
 * Ground truth for a case (§12.3 step 3): which original commit each hunk of the squashed diff
 * belongs to.
 *
 * - An added line belongs to the commit that wrote it: `git blame base..head` on the head file.
 * - A deleted line belongs to the commit that removed it: `git blame --reverse base..head` on
 *   the base file names the last commit in which the line still existed; the next commit of
 *   the (linear) case removed it.
 * - A hunk belongs to the commit owning most of its changed lines (ties: the earlier commit).
 *   Hunks whose lines come from several commits are counted as "mixed" in the report.
 */

import type { ReviewPlan } from '@bowi/core';
import { BLAME_CONFIG, git } from '@bowi/sources';
import type { BenchCase } from './select.ts';

export interface HunkLabels {
  /** Commit SHA per hunk ID; hunks without changed lines that git can attribute are absent. */
  byHunk: Map<string, string>;
  /** Hunks whose changed lines come from more than one commit. */
  mixed: number;
}

export async function labelHunks(dir: string, c: BenchCase, plan: ReviewPlan): Promise<HunkLabels> {
  const head = c.commits.at(-1)!.sha;
  const order = [c.base, ...c.commits.map((x) => x.sha)];
  const position = new Map(order.map((sha, i) => [sha, i]));
  const blame = async (args: string[], path: string) => {
    const r = await git([...BLAME_CONFIG, 'blame', '--porcelain', ...args, '--', path], {
      cwd: dir,
      okCodes: [128],
    });
    return r.code === 0 ? shaPerLine(r.stdout) : [];
  };

  const byHunk = new Map<string, string>();
  let mixed = 0;
  for (const file of plan.files) {
    const hunks = plan.hunks.filter((h) => h.fileId === file.id);
    if (hunks.length === 0) continue;
    const added = file.status === 'deleted' ? [] : await blame([`${c.base}..${head}`], file.path);
    const removed =
      file.status === 'added'
        ? []
        : await blame(['--reverse', `${c.base}..${head}`], file.oldPath ?? file.path);
    for (const h of hunks) {
      const votes = new Map<string, number>();
      for (const l of h.lines) {
        let sha: string | undefined;
        if (l.kind === 'add') sha = added[l.newNo! - 1];
        else if (l.kind === 'del') {
          const last = removed[l.oldNo! - 1];
          const i = last === undefined ? undefined : position.get(last);
          sha = i === undefined ? undefined : order[i + 1];
        }
        if (sha && position.has(sha) && sha !== c.base) votes.set(sha, (votes.get(sha) ?? 0) + 1);
      }
      if (votes.size === 0) continue;
      if (votes.size > 1) mixed++;
      const [winner] = [...votes.entries()].sort(
        (a, b) => b[1] - a[1] || position.get(a[0])! - position.get(b[0])!,
      )[0]!;
      byHunk.set(h.id, winner);
    }
  }
  return { byHunk, mixed };
}

/** Commit SHA per final line of `git blame --porcelain` output, boundary commits included. */
function shaPerLine(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (m) out[Number(m[2]) - 1] = m[1]!;
  }
  return out;
}
