/**
 * Analysis engine: runs the stages in order and assembles the ReviewPlan (§11.1).
 *
 * Input: a Snapshot from any source, plus the framework plugins and hint rules to use. Output:
 * the plan. Stages: diff, parse, (plugin detection), noise, symbols, history, graph, groups,
 * AI enrichment (only with an enricher), outside references, hints.
 */

import { performance } from 'node:perf_hooks';
import type { AiEnricher } from './ai.ts';
import type { FrameworkPlugin, HintRule } from './plugin.ts';
import type { Snapshot } from './snapshot.ts';
import { isLineManifest } from './manifests.ts';
import type { StageContext } from './stage.ts';
import { aiStage } from './stages/ai.ts';
import { diffStage } from './stages/diff.ts';
import { graphStage } from './stages/graph.ts';
import { groupStage } from './stages/group.ts';
import { hintsStage } from './stages/hints.ts';
import { historyStage } from './stages/history.ts';
import { noiseStage } from './stages/noise.ts';
import { disposeSources, parseStage } from './stages/parse.ts';
import { refsStage } from './stages/refs.ts';
import { symbolStage } from './stages/symbols.ts';
import type { Hunk, Layer, ReviewPlan } from './types.ts';

export interface StageReport {
  stage: string;
  summary: string;
  ms: number;
}

export interface AnalyzeOptions {
  toolVersion: string;
  /** Called before and after each stage, for progress output (CLI-6). */
  onStageStart?: (stage: string) => void;
  onStage?: (report: StageReport) => void;
  /** Framework plugins to try (PLG-1); those whose detect() succeeds are used. */
  plugins?: FrameworkPlugin[];
  /** Review hint rules (HINT-2). */
  hintRules?: HintRule[];
  /** AI enrichment (AI-1): only when the user turned it on. */
  ai?: { enricher: AiEnricher; concurrency?: number; timeoutMs?: number };
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
    options.onStageStart?.(stage);
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
    const plugins: FrameworkPlugin[] = [];
    for (const p of options.plugins ?? []) {
      if (
        await p.detect({ files: parsed.files, readFile: (v, path) => snapshot.readFile(v, path) })
      )
        plugins.push(p);
    }
    const pluginLayers = new Map<string, Layer>();
    for (const f of parsed.files) {
      for (const p of plugins) {
        const layer = p.layerOf?.(f, sources.get(f.id));
        if (layer) {
          pluginLayers.set(f.path, layer);
          break;
        }
      }
    }

    const noise = await run(
      'noise',
      () => noiseStage({ files: parsed.files, hunks: diff.hunks, sources }, stageCtx),
      (o) => {
        const filesWith = (kind: Hunk['kind']) =>
          new Set(o.hunks.filter((h) => h.kind === kind).map((h) => h.fileId)).size;
        return `${filesWith('generated')} generated · ${filesWith('format')} formatting-only · ${o.moves.length} move${o.moves.length === 1 ? '' : 's'}`;
      },
    );

    const { files, hunks, symbols, lineSymbols } = await run(
      'symbols',
      () =>
        symbolStage(
          { files: parsed.files, hunks: noise.hunks, sources, moves: noise.moves, pluginLayers },
          stageCtx,
        ),
      (o) =>
        `${o.symbols.length} changed${plugins.length ? ` · layers from ${plugins.map((p) => p.id).join(', ')}` : ''}`,
    );

    const history = await run(
      'history',
      () => historyStage({ snapshot, files, hunks }, stageCtx),
      (o) =>
        `${o.lineCommits.size} file${o.lineCommits.size === 1 ? '' : 's'} blamed · ${o.baseCommits.length} base commits`,
    );

    const { edges } = await run(
      'graph',
      () =>
        graphStage(
          {
            files,
            hunks,
            symbols,
            sources,
            lineSymbols,
            history,
            commits: snapshot.meta.commits,
            plugins,
          },
          stageCtx,
        ),
      (o) =>
        `${new Set(o.edges.flatMap((e) => [e.from, e.to])).size} nodes · ${o.edges.length} edges`,
    );

    const grouped = await run(
      'group',
      () =>
        groupStage(
          {
            source: snapshot.meta,
            files,
            hunks,
            symbols,
            edges,
            generatedReasons: parsed.generatedReasons,
            generatedNotes: parsed.generatedNotes,
            commentOnly: noise.commentOnly,
          },
          stageCtx,
        ),
      (o) =>
        `${o.groups.length} (confidence: ${o.groups.map((g) => (g.kind === 'noise' || g.kind === 'move' ? 'n/a' : g.confidence)).join(', ')})`,
    );

    const ai = options.ai;
    const enriched = ai
      ? await run(
          'ai',
          () =>
            aiStage(
              {
                source: snapshot.meta,
                files,
                hunks,
                symbols,
                edges,
                groups: grouped.groups,
                enricher: ai.enricher,
                ...(ai.concurrency !== undefined && { concurrency: ai.concurrency }),
                ...(ai.timeoutMs !== undefined && { timeoutMs: ai.timeoutMs }),
              },
              stageCtx,
            ),
          (o) =>
            [
              `${o.titled} of ${o.groups.filter((g) => g.kind !== 'noise' && g.kind !== 'move').length} groups titled`,
              o.overview ? 'overview' : '',
              o.suggested ? `${o.suggested} move${o.suggested === 1 ? '' : 's'} suggested` : '',
              o.cached ? `${o.cached} from cache` : '',
            ]
              .filter(Boolean)
              .join(' · '),
        )
      : undefined;
    const groups = enriched?.groups ?? grouped.groups;

    const refs = await run(
      'refs',
      () => refsStage({ snapshot, files, hunks, symbols, sources }, stageCtx),
      (o) =>
        `${o.outsideRefs.length} unchanged caller${o.outsideRefs.length === 1 ? '' : 's'} of ${o.counts.size} symbol${o.counts.size === 1 ? '' : 's'}`,
    );

    const manifests = new Map<string, string>();
    for (const f of files) {
      if (f.status === 'deleted') continue;
      if (!/(^|\/)package\.json$/.test(f.path) && !isLineManifest(f.path)) continue;
      const text = await snapshot.readFile('new', f.path);
      if (text !== null) manifests.set(f.id, text);
    }
    const { hints } = await run(
      'hints',
      () =>
        hintsStage(
          {
            files,
            hunks,
            symbols,
            sources,
            lineSymbols,
            edges,
            groups,
            outsideRefs: refs.outsideRefs,
            outsideRefCounts: refs.counts,
            lockfileDependencies: parsed.lockfileDependencies,
            manifests,
            rules: options.hintRules ?? [],
            plugins,
          },
          stageCtx,
        ),
      (o) => `${o.hints.length}`,
    );

    return assemble(
      {
        files,
        hunks,
        symbols,
        edges,
        groups,
        ...(enriched?.overview && { overview: enriched.overview }),
        outsideRefs: refs.outsideRefs,
        hints,
      },
      plugins.map((p) => p.id),
      ai
        ? {
            enabled: true,
            provider: ai.enricher.id,
            ...(enriched?.model && { model: enriched.model }),
            ...(ctx.config.ai.effort && { effort: ctx.config.ai.effort }),
          }
        : { enabled: false },
    );
  } finally {
    disposeSources(sources);
  }

  function assemble(
    {
      files,
      hunks,
      symbols,
      edges,
      groups,
      overview,
      outsideRefs,
      hints,
    }: Pick<
      ReviewPlan,
      'files' | 'hunks' | 'symbols' | 'edges' | 'groups' | 'overview' | 'outsideRefs' | 'hints'
    >,
    pluginIds: string[],
    aiMeta: ReviewPlan['meta']['ai'],
  ): ReviewPlan {
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
      edges,
      groups,
      ...(overview && { overview }),
      outsideRefs,
      hints,
      meta: {
        ai: aiMeta,
        languages: [
          ...new Set(files.filter((f) => f.parseStatus === 'ok').map((f) => f.language!)),
        ].sort(),
        plugins: pluginIds,
        order: ctx.config.order,
        warnings,
        timingsMs,
      },
    };
  }
}
