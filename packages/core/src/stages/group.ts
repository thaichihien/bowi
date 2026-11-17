/**
 * Stage 7: groups and reading order (GRP-1..12).
 *
 * Input: files, hunks, symbols, edges and why files are generated. Output: Group[] in reading
 * order, each with steps in reading order. Every hunk ends up in exactly one step (checked).
 *
 * Order: logic groups (dependencies first, then larger first, "Other changes" last), then
 * "Moved code" (moves with edits), then one noise group (generated, formatting-only, unchanged
 * moves), which also lists files that have no diff to show.
 */

import { compareStrings } from '../determinism.ts';
import { clusterSymbols } from '../group/cluster.ts';
import {
  confidenceFor,
  kindFor,
  reasonsFor,
  ruleTitle,
  sourceTitle,
  type GroupFacts,
} from '../group/describe.ts';
import { buildSteps, LAYER_ORDER, topoOrder } from '../group/steps.ts';
import { assertPartition } from '../invariants.ts';
import type { Stage } from '../stage.ts';
import type {
  ChangedSymbol,
  ChangeEdge,
  FileChange,
  Group,
  Hunk,
  ReviewPlan,
  Step,
} from '../types.ts';
import { show } from './graph.ts';

export interface GroupStageInput {
  source: ReviewPlan['source'];
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  edges: ChangeEdge[];
  generatedReasons: Map<string, string>;
  generatedNotes: Map<string, string[]>;
}

export interface GroupStageOutput {
  groups: Group[];
}

const DEPENDENCY_TYPES = new Set<ChangeEdge['type']>(['calls', 'uses-type', 'tests', 'framework']);

export const groupStage: Stage<GroupStageInput, GroupStageOutput> = async (input, ctx) => {
  const { files, hunks, symbols, edges } = input;
  const fileById = new Map(files.map((f) => [f.id, f]));
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  const fileOf = (id: string) => fileById.get(id)!.path;
  const threshold = ctx.config.grouping.edgeThreshold;

  // Logic groups.
  const logicHunks = hunks.filter((h) => h.kind === 'logic');
  const logicSymbolIds = new Set(logicHunks.flatMap((h) => h.symbolIds));
  const logicSymbols = symbols.filter((s) => logicSymbolIds.has(s.id));
  const clusters = clusterSymbols({
    symbols: logicSymbols,
    edges,
    hunks: logicHunks,
    files,
    threshold,
    maxGroupShare: ctx.config.grouping.maxGroupShare,
  });

  // A hunk belongs to the group of its first symbol; symbols sharing a hunk share a group.
  const clusterOfSymbol = new Map<string, number>();
  clusters.forEach((c, i) => c.symbolIds.forEach((id) => clusterOfSymbol.set(id, i)));
  const hunksOfCluster = clusters.map(() => [] as Hunk[]);
  for (const h of logicHunks) hunksOfCluster[clusterOfSymbol.get(h.symbolIds[0]!)!]!.push(h);

  interface Draft {
    group: Omit<Group, 'id' | 'steps' | 'testsFirstStepOrder' | 'dependsOn'>;
    hunks: Hunk[];
    symbolIds: Set<string>;
    isOther: boolean;
    size: number;
  }
  const drafts: Draft[] = clusters.map((cluster, i) => {
    const groupHunks = hunksOfCluster[i]!;
    const ids = new Set(cluster.symbolIds);
    const facts: GroupFacts = {
      cluster,
      symbols: cluster.symbolIds.map((id) => symbolById.get(id)!),
      hunks: groupHunks,
      edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      threshold,
      fileLayers: new Set(groupHunks.map((h) => fileById.get(h.fileId)!.layer)),
    };
    return {
      group: {
        title: ruleTitle(facts, fileOf),
        titleSource: 'rule',
        kind: kindFor(facts),
        confidence: confidenceFor(facts),
        reasons: reasonsFor(facts, fileOf),
      },
      hunks: groupHunks,
      symbolIds: ids,
      isOther: cluster.origin === 'other' && cluster.symbolIds.length > 1,
      size: groupHunks.reduce((n, h) => n + h.lines.filter((l) => l.kind !== 'context').length, 0),
    };
  });

  /** The earliest layer of a group's code; tests and docs count only in groups of nothing else. */
  const foundation = (groupHunks: Hunk[]) => {
    const ranks = groupHunks.map((h) => LAYER_ORDER.indexOf(fileById.get(h.fileId)!.layer));
    const code = ranks.filter((r) => r < LAYER_ORDER.indexOf('test'));
    return Math.min(...(code.length > 0 ? code : ranks));
  };

  const lone = sourceTitle(input.source, drafts.length);
  if (lone && drafts[0]) drafts[0].group.title = lone;

  // Order logic groups: what a group uses comes first; then foundations first (the earliest layer
  // of its code, as for steps), then larger first; "Other changes" last.
  const groupOfSymbol = new Map<string, number>();
  drafts.forEach((d, i) => d.symbolIds.forEach((id) => groupOfSymbol.set(id, i)));
  const uses = drafts.map(() => new Set<number>());
  for (const e of edges) {
    if (!DEPENDENCY_TYPES.has(e.type)) continue;
    const a = groupOfSymbol.get(e.from);
    const b = groupOfSymbol.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) uses[a]!.add(b);
  }
  const tieOrder = drafts
    .map((d, i) => ({ d, i }))
    .sort(
      (x, y) =>
        Number(x.d.isOther) - Number(y.d.isOther) ||
        foundation(x.d.hunks) - foundation(y.d.hunks) ||
        y.d.size - x.d.size ||
        compareStrings(x.d.hunks[0]?.id ?? '', y.d.hunks[0]?.id ?? ''),
    )
    .map((x) => x.i);
  const logicOrder = topoOrder(tieOrder, (i) =>
    [...uses[i]!].filter((j) => !drafts[j]!.isOther || drafts[i]!.isOther),
  );

  const groups: Group[] = [];
  const idOfDraft = new Map<number, string>();
  logicOrder.forEach((i, n) => idOfDraft.set(i, `g${n + 1}`));
  for (const i of logicOrder) {
    const d = drafts[i]!;
    const id = idOfDraft.get(i)!;
    const { steps, testsFirstStepOrder } = buildSteps(id, d.hunks, fileById, edges);
    groups.push({
      id,
      ...d.group,
      steps,
      testsFirstStepOrder,
      dependsOn: [...uses[i]!].map((j) => idOfDraft.get(j)!).sort(compareStrings),
    });
  }

  // Moved code (moves with edits).
  const moveHunks = hunks.filter((h) => h.kind === 'move');
  const isPure = (h: Hunk) =>
    h.move!.similarity === 1 &&
    h.move!.changedLineIndexes.length === 0 &&
    hunkById.get(h.move!.pairHunkId)!.move!.changedLineIndexes.length === 0;
  const edited = movePairs(
    moveHunks.filter((h) => !isPure(h)),
    hunkById,
  );
  if (edited.length) {
    const id = `g${groups.length + 1}`;
    const steps: Step[] = edited.map(([to, from], n) => ({
      id: `${id}:move${n + 1}`,
      title: `${moveName(to, symbolById)} moved`,
      layer: fileById.get(to.fileId)!.layer,
      hunkIds: [to.id, from.id],
    }));
    const reasons = edited.map(([to, from]) => {
      // A changed line shows on both halves (old and new text); count it once.
      const changed = Math.max(
        to.move!.changedLineIndexes.length,
        from.move!.changedLineIndexes.length,
      );
      return `${moveName(to, symbolById)} moved from ${fileOf(from.fileId)} to ${fileOf(to.fileId)}; ${changed} line${changed === 1 ? '' : 's'} changed on the way`;
    });
    groups.push({
      id,
      title:
        edited.length === 1
          ? `Move ${moveName(edited[0]![0], symbolById)} from ${baseName(fileOf(edited[0]![1].fileId))} to ${baseName(fileOf(edited[0]![0].fileId))}`
          : `Moved code (${edited.length} symbols)`,
      titleSource: 'rule',
      kind: 'move',
      confidence: 'high',
      reasons,
      steps,
      testsFirstStepOrder: steps.map((s) => s.id),
      dependsOn: [],
    });
  }

  // Noise.
  const noiseSteps: { key: string; title: string; hunks: Hunk[] }[] = [
    {
      key: 'generated',
      title: 'Generated files',
      hunks: hunks.filter((h) => h.kind === 'generated'),
    },
    { key: 'format', title: 'Formatting only', hunks: hunks.filter((h) => h.kind === 'format') },
    {
      key: 'moved',
      title: 'Moved without changes',
      hunks: movePairs(moveHunks.filter(isPure), hunkById).flatMap(([to, from]) => [to, from]),
    },
  ].filter((s) => s.hunks.length > 0);
  const noDiff = files.filter((f) => !hunks.some((h) => h.fileId === f.id));
  if (noiseSteps.length || noDiff.length) {
    const id = `g${groups.length + 1}`;
    const steps: Step[] = noiseSteps.map((s) => {
      const layers = new Set(s.hunks.map((h) => fileById.get(h.fileId)!.layer));
      return {
        id: `${id}:${s.key}`,
        title: s.title,
        layer: layers.size === 1 ? [...layers][0]! : 'unknown',
        hunkIds: s.hunks.map((h) => h.id),
      };
    });
    groups.push({
      id,
      title: noiseTitle(
        noiseSteps.map((s) => s.key),
        noDiff.length > 0,
      ),
      titleSource: 'rule',
      kind: 'noise',
      confidence: 'high',
      reasons: [],
      steps,
      testsFirstStepOrder: steps.map((s) => s.id),
      summary: noiseSummary(files, hunks, input.generatedReasons, input.generatedNotes, noDiff),
      dependsOn: [],
    });
  }

  assertPartition(groups, hunks);
  return { groups };
};

/** [destination (added side), origin (removed side)] pairs, by destination path. */
function movePairs(moveHunks: Hunk[], hunkById: Map<string, Hunk>): [Hunk, Hunk][] {
  const pairs: [Hunk, Hunk][] = [];
  const seen = new Set<string>();
  for (const h of moveHunks) {
    if (seen.has(h.id)) continue;
    const other = hunkById.get(h.move!.pairHunkId)!;
    seen.add(h.id);
    seen.add(other.id);
    const hIsOrigin =
      h.fileId === h.move!.fromFileId &&
      h.lines.some((l) => l.kind === 'del') &&
      !h.lines.some((l) => l.kind === 'add');
    pairs.push(hIsOrigin ? [other, h] : [h, other]);
  }
  return pairs;
}

function moveName(to: Hunk, symbolById: Map<string, ChangedSymbol>): string {
  const s = symbolById.get(to.symbolIds[0] ?? '');
  return s ? show(s) : `code at ${to.newStart}`;
}

function noiseTitle(keys: string[], hasNoDiff: boolean): string {
  const parts = [
    keys.includes('generated') ? 'generated files' : '',
    keys.includes('format') ? 'formatting' : '',
    keys.includes('moved') ? 'unchanged moves' : '',
    hasNoDiff && keys.length === 0 ? 'files without a diff' : '',
  ].filter(Boolean);
  const text =
    parts.length > 1
      ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
      : (parts[0] ?? 'Noise');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function noiseSummary(
  files: FileChange[],
  hunks: Hunk[],
  generatedReasons: Map<string, string>,
  generatedNotes: Map<string, string[]>,
  noDiff: FileChange[],
): string {
  const lines: string[] = [];
  for (const f of files) {
    const kinds = new Set(hunks.filter((h) => h.fileId === f.id).map((h) => h.kind));
    const delta = `+${f.additions} −${f.deletions}`;
    if (kinds.has('generated')) {
      lines.push(`${f.path}: generated (${generatedReasons.get(f.id) ?? 'generated'}), ${delta}`);
      for (const note of generatedNotes.get(f.id) ?? []) lines.push(`${f.path}: ${note}`);
    } else if (kinds.has('format'))
      lines.push(
        `${f.path}: formatting only${kinds.size > 1 ? ' in part of the file' : ''}, ${delta}`,
      );
  }
  for (const f of noDiff) {
    const why =
      f.status === 'binary'
        ? 'binary file'
        : f.status === 'mode'
          ? 'file mode changed'
          : f.status === 'renamed'
            ? `renamed from ${f.oldPath} without changes`
            : 'no text changes';
    lines.push(`${f.path}: ${why}`);
  }
  return lines.join('\n');
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
