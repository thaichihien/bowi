/**
 * The benchmark report (§12.3 step 5): a table per repository, then a summary per language with
 * a verdict. A language counts as supported when Bowi clearly beats grouping by folder:
 * its mean ARI is at least SUPPORT_MARGIN above the better folder baseline, and it scores at
 * least as well as that baseline in two thirds of the cases or more.
 */

import { GROUPINGS, type CaseResult, type Grouping } from './evaluate.ts';

export const SUPPORT_MARGIN = 0.1;
const FOLDER_BASELINES: Grouping[] = ['top-folder', 'folder'];

export interface RepoResults {
  repo: string;
  cases: CaseResult[];
}

const fmt = (x: number) => (Number.isNaN(x) ? '   –' : x.toFixed(2).padStart(5));
const mean = (xs: number[]) => {
  const ok = xs.filter((x) => !Number.isNaN(x));
  return ok.length ? ok.reduce((s, x) => s + x, 0) / ok.length : NaN;
};

export function formatReport(results: RepoResults[]): string {
  const out: string[] = [
    'Bowi grouping benchmark (requirement.md §12.3)',
    'Adjusted Rand Index over hunks: 1 = groups match the original commits, 0 = chance level.',
    '"all" scores every hunk; "code" leaves out generated and formatting-only hunks.',
    '',
  ];
  const header = `  ${'case'.padEnd(26)}${'commits'.padStart(8)}${'files'.padStart(7)}${'hunks'.padStart(7)}${'mixed'.padStart(7)}  ${GROUPINGS.map((g) => g.padStart(12)).join('')}${'bowi code'.padStart(11)}`;
  for (const r of results) {
    out.push(`${r.repo} · ${r.cases.length} cases`, header);
    for (const c of r.cases) {
      out.push(
        `  ${c.id.padEnd(26)}${String(c.commits).padStart(8)}${String(c.files).padStart(7)}${String(c.hunks).padStart(7)}${String(c.mixed).padStart(7)}  ${GROUPINGS.map((g) => fmt(c.all[g]).padStart(12)).join('')}${fmt(c.code.bowi).padStart(11)}`,
      );
    }
    out.push(
      `  ${'mean'.padEnd(26)}${''.padStart(29)}  ${GROUPINGS.map((g) => fmt(mean(r.cases.map((c) => c.all[g]))).padStart(12)).join('')}${fmt(mean(r.cases.map((c) => c.code.bowi))).padStart(11)}`,
      '',
    );
  }

  out.push('Summary by language');
  const byLanguage = new Map<string, CaseResult[]>();
  for (const c of results.flatMap((r) => r.cases))
    byLanguage.set(c.language, [...(byLanguage.get(c.language) ?? []), c]);
  for (const [language, cases] of [...byLanguage].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const v = verdict(cases);
    out.push(
      `  ${language}: ${cases.length} cases · ${GROUPINGS.map((g) => `${g} ${fmt(mean(cases.map((c) => c.all[g]))).trim()}`).join(' · ')}`,
      `    ${v.supported ? 'Supported' : 'Not supported yet'}: Bowi ${v.margin >= 0 ? '+' : ''}${v.margin.toFixed(2)} over ${v.baseline}, at least as good in ${v.atLeast} of ${cases.length} cases (needs +${SUPPORT_MARGIN.toFixed(2)} and two thirds).`,
    );
  }
  return out.join('\n');
}

export function verdict(cases: CaseResult[]): {
  supported: boolean;
  baseline: Grouping;
  margin: number;
  atLeast: number;
} {
  const best = FOLDER_BASELINES.map((g) => ({ g, m: mean(cases.map((c) => c.all[g])) })).sort(
    (a, b) => b.m - a.m,
  )[0]!;
  const margin = mean(cases.map((c) => c.all.bowi)) - best.m;
  const atLeast = cases.filter((c) => c.all.bowi >= c.all[best.g]).length;
  return {
    supported: margin >= SUPPORT_MARGIN && atLeast * 3 >= cases.length * 2,
    baseline: best.g,
    margin,
    atLeast,
  };
}
