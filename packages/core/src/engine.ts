/**
 * Analysis engine: runs the stages in order and assembles the ReviewPlan (§11.1).
 *
 * Input: a Snapshot from any source. Output: the plan. Runs stages 2–5 (diff, parse, noise,
 * symbols); later milestones add graph, grouping and enrichment here.
 */

import { performance } from 'node:perf_hooks';
import type { Snapshot } from './snapshot.ts';
import type { StageContext } from './stage.ts';
import { diffStage } from './stages/diff.ts';
import { noiseStage } from './stages/noise.ts';
import { disposeSources, parseStage } from './stages/parse.ts';
import { symbolStage } from './stages/symbols.ts';
import type { Hunk, ReviewPlan } from './types.ts';

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

  const diff = await run(
    'diff',
    () => diffStage(snapshot, stageCtx),
    (o) => `${o.files.length} files, ${o.hunks.length} hunks`,
  );

  const parsed = await run(
    'parse',
    () => parseStage({ snapshot, files: diff.files }, stageCtx),
    (o) => {
      const languages = [
        ...new Set(o.files.filter((f) => f.parseStatus === 'ok').map((f) => f.language!)),
      ].sort();
      return `${o.parsedVersions} file versions${languages.length ? ` (${languages.join(', ')})` : ''}`;
    },
  );
  const { sources } = parsed;

  try {
    const noise = await run(
      'noise',
      () => noiseStage({ files: parsed.files, hunks: diff.hunks, sources }, stageCtx),
      (o) => {
        const filesWith = (kind: Hunk['kind']) =>
          new Set(o.hunks.filter((h) => h.kind === kind).map((h) => h.fileId)).size;
        return `${filesWith('generated')} generated · ${filesWith('format')} formatting-only · ${o.moves.length} move${o.moves.length === 1 ? '' : 's'}`;
      },
    );

    const { files, hunks, symbols } = await run(
      'symbols',
      () =>
        symbolStage(
          { files: parsed.files, hunks: noise.hunks, sources, moves: noise.moves },
          stageCtx,
        ),
      (o) => `${o.symbols.length} changed`,
    );

    return assemble({ files, hunks, symbols });
  } finally {
    disposeSources(sources);
  }

  function assemble({
    files,
    hunks,
    symbols,
  }: Pick<ReviewPlan, 'files' | 'hunks' | 'symbols'>): ReviewPlan {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions;
      deletions += f.deletions;
    }
    let reviewLines = 0;
    let noiseLines = 0;
    for (const h of hunks) {
      const changed = h.lines.filter((l) => l.kind !== 'context').length;
      if (h.kind === 'logic') reviewLines += changed;
      else if (h.kind === 'move') {
        const edited = h.move?.changedLineIndexes.length ?? 0;
        reviewLines += edited;
        noiseLines += changed - edited;
      } else noiseLines += changed;
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
        reviewLines,
        noiseLines,
      },
      files,
      hunks,
      symbols,
      edges: [],
      groups: [],
      outsideRefs: [],
      hints: [],
      meta: {
        ai: { enabled: false },
        languages: [
          ...new Set(files.filter((f) => f.parseStatus === 'ok').map((f) => f.language!)),
        ].sort(),
        plugins: [],
        warnings,
        timingsMs,
      },
    };
  }
}
