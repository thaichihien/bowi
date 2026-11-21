/**
 * One benchmark case (§12.3 steps 2–4): run Bowi on the squashed PR, label each hunk with its
 * original commit, and score Bowi's groups and the baselines with the Adjusted Rand Index.
 *
 * Scores are over every labeled hunk ("all"), and again over code hunks only ("code": logic and
 * moved code, without generated and formatting-only hunks, which Bowi deliberately collects into
 * one noise group whatever commit they came from).
 */

import {
  analyze,
  createStageContext,
  DEFAULT_CONFIG,
  type FrameworkPlugin,
  type ReviewPlan,
  type Snapshot,
} from '@bowi/core';
import { adjustedRandIndex } from './ari.ts';
import { BASELINE_NAMES, BASELINES } from './baselines.ts';
import { labelHunks, type HunkLabels } from './labels.ts';
import type { BenchCase } from './select.ts';

export type Grouping = 'bowi' | keyof typeof BASELINES;
export const GROUPINGS: Grouping[] = ['bowi', ...BASELINE_NAMES];

export interface CaseResult {
  id: string;
  commits: number;
  files: number;
  /** Labeled hunks scored. */
  hunks: number;
  mixed: number;
  groups: number;
  language: string;
  all: Record<Grouping, number>;
  code: Record<Grouping, number>;
  plugins: string[];
}

/** Bowi's plan for the squashed case, and the original commit of each hunk. */
export async function analyzeCase(
  dir: string,
  c: BenchCase,
  snapshot: Snapshot,
  plugins: FrameworkPlugin[],
): Promise<{ plan: ReviewPlan; labels: HunkLabels }> {
  // Outside references do not change groups; skip the search.
  const config = { ...DEFAULT_CONFIG, outsideRefs: { maxPerSymbol: 0 } };
  const plan = await analyze(snapshot, createStageContext(config, { now: () => new Date(0) }), {
    toolVersion: 'bench',
    plugins,
  });
  return { plan, labels: await labelHunks(dir, c, plan) };
}

export async function evaluateCase(
  dir: string,
  c: BenchCase,
  snapshot: Snapshot,
  plugins: FrameworkPlugin[],
): Promise<CaseResult> {
  const { plan, labels } = await analyzeCase(dir, c, snapshot, plugins);
  return {
    id: c.id,
    commits: c.commits.length,
    files: plan.files.length,
    hunks: labels.byHunk.size,
    mixed: labels.mixed,
    groups: plan.groups.length,
    language: languageOf(plan),
    all: score(plan, labels.byHunk, () => true),
    code: score(plan, labels.byHunk, (kind) => kind === 'logic' || kind === 'move'),
    plugins: plan.meta.plugins,
  };
}

function score(
  plan: ReviewPlan,
  truth: Map<string, string>,
  keep: (kind: ReviewPlan['hunks'][number]['kind']) => boolean,
): Record<Grouping, number> {
  const groupOf = new Map<string, string>();
  for (const g of plan.groups)
    for (const s of g.steps) for (const h of s.hunkIds) groupOf.set(h, g.id);
  const pathOf = new Map(plan.files.map((f) => [f.id, f.path]));
  const hunks = plan.hunks.filter((h) => truth.has(h.id) && keep(h.kind));
  const expected = hunks.map((h) => truth.get(h.id)!);
  const out = {} as Record<Grouping, number>;
  out.bowi = adjustedRandIndex(
    expected,
    hunks.map((h) => groupOf.get(h.id)!),
  );
  for (const name of BASELINE_NAMES) {
    out[name] = adjustedRandIndex(
      expected,
      hunks.map((h) => BASELINES[name](pathOf.get(h.fileId)!)),
    );
  }
  return out;
}

function languageOf(plan: ReviewPlan): string {
  // Python and Go (M15) when most changed code files are theirs: a Django app may touch some
  // JavaScript, a TypeScript project a script.
  const count = (l: string) => plan.files.filter((f) => f.language === l).length;
  const scriptFiles = plan.files.filter((f) =>
    ['typescript', 'tsx', 'javascript', 'vue', 'svelte', 'astro'].includes(f.language ?? ''),
  ).length;
  if (count('python') > scriptFiles && count('python') >= count('go')) return 'Python';
  if (count('go') > scriptFiles) return 'Go';
  // Java, Kotlin and C# (M16) likewise; Java and Kotlin by whichever has more files.
  const [top] = (
    [
      ['Java', count('java')],
      ['Kotlin', count('kotlin')],
      ['C#', count('csharp')],
    ] as [string, number][]
  ).sort((a, b) => b[1] - a[1]);
  if (top![1] > scriptFiles) return top![0];
  const languages = new Set(plan.files.map((f) => f.language));
  // Vue, Svelte and Astro components: their scripts are parsed as TypeScript (M14).
  const scripts = ['typescript', 'tsx', 'vue', 'svelte', 'astro'];
  if (scripts.some((l) => languages.has(l as never))) return 'TypeScript';
  if (languages.has('javascript')) return 'JavaScript';
  return 'Other';
}
