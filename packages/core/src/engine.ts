/**
 * Analysis engine: runs the stages in order and assembles the ReviewPlan (§11.1).
 *
 * Input: a Snapshot from any source. Output: the plan. Milestone M1 runs stage 2 (diff/hunks);
 * later milestones add parsing, noise, symbols, graph, grouping and enrichment here.
 */

import { performance } from 'node:perf_hooks';
import type { Snapshot } from './snapshot.ts';
import type { StageContext } from './stage.ts';
import { diffStage } from './stages/diff.ts';
import type { ReviewPlan } from './types.ts';

export interface StageReport {
  stage: string;
  summary: string;
  ms: number;
}

export interface AnalyzeOptions {
  toolVersion: string;
  /** Called after each stage, for progress output (CLI-6). */
  onStage?: (report: StageReport) => void;
}

export async function analyze(
  snapshot: Snapshot,
  ctx: StageContext,
  options: AnalyzeOptions,
): Promise<ReviewPlan> {
  const warnings: string[] = [];
  const stageCtx: StageContext = {
    ...ctx,
    warn: (message) => {
      warnings.push(message);
      ctx.warn(message);
    },
  };
  const timingsMs: Record<string, number> = {};

  async function run<T>(stage: string, fn: () => Promise<T>, summarize: (out: T) => string) {
    const start = performance.now();
    const out = await fn();
    const ms = Math.round(performance.now() - start);
    timingsMs[stage] = ms;
    options.onStage?.({ stage, summary: summarize(out), ms });
    return out;
  }

  const { files, hunks } = await run(
    'diff',
    () => diffStage(snapshot, stageCtx),
    (o) => `${o.files.length} files, ${o.hunks.length} hunks`,
  );

  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }

  return {
    schemaVersion: 1,
    generatedAt: ctx.now().toISOString(),
    tool: { name: 'bowi', version: options.toolVersion },
    source: snapshot.meta,
    stats: {
      files: files.length,
      hunks: hunks.length,
      additions,
      deletions,
      // Until noise classification (M2) every hunk counts as logic.
      reviewLines: additions + deletions,
      noiseLines: 0,
    },
    files,
    hunks,
    symbols: [],
    edges: [],
    groups: [],
    outsideRefs: [],
    hints: [],
    meta: {
      ai: { enabled: false },
      languages: [],
      plugins: [],
      warnings,
      timingsMs,
    },
  };
}
