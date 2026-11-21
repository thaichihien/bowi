/**
 * Stage 9: review hints (HINT-1, HINT-2): reading aids attached to a group, step and hunk.
 *
 * Input: the finished analysis, the hint rules and the detected plugins. Output: ReviewHint[]
 * in reading order. Rules point at a hunk, symbol or file; this stage adds the step and group
 * that hunk is read in. Hints never change groups, steps or the exit code.
 */

import { compareStrings } from '../determinism.ts';
import { addedDependencies, isLineManifest } from '../manifests.ts';
import type { FrameworkPlugin, HintDraft, HintInput, HintRule, NewDependency } from '../plugin.ts';
import type { Stage } from '../stage.ts';
import type { ReviewHint } from '../types.ts';

export interface HintsStageInput extends Omit<HintInput, 'newDependencies'> {
  rules: HintRule[];
  plugins: FrameworkPlugin[];
  /** Direct dependencies added according to lockfiles (parse stage), by file ID. */
  lockfileDependencies: Map<string, NewDependency[]>;
  /** Head text of each changed `package.json`, by file ID (to read version specs). */
  manifests: Map<string, string>;
}

export interface HintsStageOutput {
  hints: ReviewHint[];
}

const DEPENDENCY_SECTIONS: Record<string, boolean> = {
  dependencies: false,
  optionalDependencies: false,
  peerDependencies: false,
  devDependencies: true,
};

export const hintsStage: Stage<HintsStageInput, HintsStageOutput> = async (input) => {
  const hintInput: HintInput = {
    files: input.files,
    hunks: input.hunks,
    symbols: input.symbols,
    sources: input.sources,
    lineSymbols: input.lineSymbols,
    edges: input.edges,
    groups: input.groups,
    outsideRefs: input.outsideRefs,
    outsideRefCounts: input.outsideRefCounts,
    newDependencies: newDependencies(input),
  };
  const drafts: HintDraft[] = [
    ...input.rules.flatMap((r) => r.run(hintInput)),
    ...input.plugins.flatMap((p) => p.hints?.(hintInput) ?? []),
  ];

  // Where each hunk is read: group, step, and position for ordering.
  const placeOfHunk = new Map<string, { groupId: string; stepId: string; rank: number }>();
  let rank = 0;
  for (const g of input.groups) {
    for (const s of g.steps) {
      for (const id of s.hunkIds)
        placeOfHunk.set(id, { groupId: g.id, stepId: s.id, rank: rank++ });
    }
  }
  const symbolById = new Map(input.symbols.map((s) => [s.id, s]));
  const firstHunkOfFile = new Map<string, string>();
  for (const h of input.hunks)
    if (!firstHunkOfFile.has(h.fileId)) firstHunkOfFile.set(h.fileId, h.id);

  const placed: { hint: Omit<ReviewHint, 'id'>; rank: number }[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const hunkId =
      d.hunkId ??
      (d.symbolId ? symbolById.get(d.symbolId)?.hunkIds[0] : undefined) ??
      (d.fileId ? firstHunkOfFile.get(d.fileId) : undefined);
    const place = hunkId ? placeOfHunk.get(hunkId) : undefined;
    if (!hunkId || !place) continue;
    const key = `${d.ruleId}\u0000${d.message}\u0000${place.stepId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target: ReviewHint['target'] = { groupId: place.groupId, stepId: place.stepId, hunkId };
    if (d.symbolId) target.symbolId = d.symbolId;
    placed.push({
      hint: { ruleId: d.ruleId, severity: d.severity, message: d.message, target },
      rank: place.rank,
    });
  }
  placed.sort(
    (a, b) =>
      a.rank - b.rank ||
      compareStrings(a.hint.ruleId, b.hint.ruleId) ||
      compareStrings(a.hint.message, b.hint.message),
  );
  return { hints: placed.map((p, i) => ({ id: `hint${i + 1}`, ...p.hint })) };
};

/**
 * Dependencies the PR adds: `package.json` keys under a dependency section, and lockfile root
 * entries for names no changed `package.json` adds (the lockfile is noise; package.json is
 * where a reviewer reads it).
 */
function newDependencies(input: HintsStageInput): Map<string, NewDependency[]> {
  const out = new Map<string, NewDependency[]>();
  const fromManifest = new Set<string>();
  const fileById = new Map(input.files.map((f) => [f.id, f]));
  for (const s of input.symbols) {
    const file = fileById.get(s.fileId)!;
    if (s.change !== 'added' || !/(^|\/)package\.json$/.test(file.path)) continue;
    const [section = '', ...rest] = s.qualifiedName.split('.');
    const dev = DEPENDENCY_SECTIONS[section];
    if (dev === undefined) continue;
    // A new section is one symbol; its entries are in the parsed file.
    const names = rest.length
      ? [rest.join('.')]
      : (input.sources
          .get(s.fileId)
          ?.new?.symbols.filter(
            (x) => x.parent !== null && x.qualifiedName.startsWith(`${section}.`),
          )
          .map((x) => x.name) ?? []);
    const specs = sectionOf(input.manifests.get(s.fileId), section);
    for (const name of names) {
      fromManifest.add(name);
      // Packages of the same repository (`workspace:*`) or a local folder are not third-party code.
      if (/^(workspace|file|link|portal):/.test(specs[name] ?? '')) continue;
      out.set(s.fileId, [...(out.get(s.fileId) ?? []), { name, dev }]);
    }
  }
  for (const [fileId, deps] of input.lockfileDependencies) {
    const rest = deps.filter((d) => !fromManifest.has(d.name));
    if (rest.length) out.set(fileId, rest);
  }
  // Python and Go manifests, read line by line (M15).
  for (const file of input.files) {
    const text = input.manifests.get(file.id);
    if (text === undefined || !isLineManifest(file.path)) continue;
    const deps = addedDependencies(
      file.path,
      text,
      input.hunks.filter((h) => h.fileId === file.id),
    );
    if (deps.length) out.set(file.id, deps);
  }
  return out;
}

function sectionOf(text: string | undefined, section: string): Record<string, string> {
  try {
    const value = (JSON.parse(text ?? '{}') as Record<string, unknown>)[section];
    return typeof value === 'object' && value !== null ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}
