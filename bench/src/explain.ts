/**
 * `bun run bench explain <case>`: why a case scores what it scores. Lists each of Bowi's groups
 * with the original commit (A, B, …) of every hunk, the links that join hunks of different
 * commits (candidates for wrong links), and how each commit is spread over the groups (a commit
 * in several groups means a missing link).
 */

import type { ReviewPlan } from '@bowi/core';
import type { HunkLabels } from './labels.ts';
import type { BenchCase } from './select.ts';

export function formatExplanation(c: BenchCase, plan: ReviewPlan, labels: HunkLabels): string {
  const letter = new Map(c.commits.map((x, i) => [x.sha, String.fromCharCode(65 + i)]));
  const out = [`${c.id}: ${c.commits.length} commits`];
  c.commits.forEach((x) => out.push(`  ${letter.get(x.sha)}  ${x.subject}`));

  const pathOf = new Map(plan.files.map((f) => [f.id, f.path]));
  const hunkById = new Map(plan.hunks.map((h) => [h.id, h]));
  const groupOf = new Map<string, string>();
  for (const g of plan.groups) {
    out.push('', `[${g.id}] ${g.kind}, ${g.confidence}: ${g.title}`);
    for (const s of g.steps) {
      for (const id of s.hunkIds) {
        groupOf.set(id, g.id);
        const h = hunkById.get(id)!;
        const commit = letter.get(labels.byHunk.get(id) ?? '') ?? '?';
        out.push(
          `  ${commit}  ${id.padEnd(9)}${h.kind.padEnd(10)}${pathOf.get(h.fileId)}  ${h.header.slice(0, 50)}`,
        );
      }
    }
  }

  // A symbol's commit: the commit owning most of its hunks.
  const commitOf = (symbolId: string) => {
    const votes = new Map<string, number>();
    for (const id of plan.symbols.find((s) => s.id === symbolId)?.hunkIds ?? []) {
      const sha = labels.byHunk.get(id);
      if (sha) votes.set(sha, (votes.get(sha) ?? 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  out.push('', 'Links between hunks of different commits:');
  for (const e of plan.edges) {
    const a = commitOf(e.from);
    const b = commitOf(e.to);
    if (a && b && a !== b)
      out.push(`  ${letter.get(a)}–${letter.get(b)}  ${e.type} ${e.weight}  ${e.evidence.text}`);
  }

  out.push('', 'Groups of each commit:');
  for (const [sha, l] of letter) {
    const groups = new Map<string, number>();
    for (const [id, owner] of labels.byHunk) {
      if (owner === sha) groups.set(groupOf.get(id)!, (groups.get(groupOf.get(id)!) ?? 0) + 1);
    }
    out.push(`  ${l}  ${[...groups].map(([g, n]) => `${g} ×${n}`).join(', ')}`);
  }
  return out.join('\n');
}
