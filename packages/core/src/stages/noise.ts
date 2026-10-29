/**
 * Stage 4: noise classification (NOISE-1..4, NOISE-7).
 *
 * Input: files (with `generated`), hunks and parsed sources. Output: hunks with `kind` set to
 * `generated`, `format`, `move` or `logic`, and `move` details on moved hunks. Nothing is
 * removed: every hunk stays in the plan (NOISE-7).
 *
 * - generated: every hunk of a generated file.
 * - format: the code on the hunk's changed lines has the same structural fingerprint on both
 *   sides (whitespace, `;`, `,`, quote style and comment layout ignored; comment text counts),
 *   or only blank lines changed. Files without a grammar only count blank-line changes.
 * - move: a symbol whose lines are all deleted matches a symbol whose lines are all added,
 *   exactly (fingerprint) or with line similarity ≥ grouping.moveSimilarity. Lines that differ
 *   are listed in `changedLineIndexes` and are never treated as noise.
 */

import type { ParsedSource, SourceSymbol } from '@bowi/lang';
import { compareStrings } from '../determinism.ts';
import type { Stage } from '../stage.ts';
import type { DiffLine, FileChange, Hunk } from '../types.ts';
import { matchLines } from '../util/lcs.ts';
import type { FileSources } from './parse.ts';

export interface NoiseStageInput {
  files: FileChange[];
  hunks: Hunk[];
  sources: Map<string, FileSources>;
}

/** A matched move: one removed symbol and the added symbol it became. */
export interface MovePair {
  from: { fileId: string; hunkId: string; symbol: SourceSymbol };
  to: { fileId: string; hunkId: string; symbol: SourceSymbol };
  similarity: number;
}

export interface NoiseStageOutput {
  hunks: Hunk[];
  /** Moves whose two halves both became `move` hunks. */
  moves: MovePair[];
}

/** Fuzzy (non-exact) move matches need at least this many non-blank lines on each side. */
const MIN_FUZZY_MOVE_LINES = 3;

export const noiseStage: Stage<NoiseStageInput, NoiseStageOutput> = async (
  { files, hunks, sources },
  ctx,
) => {
  const fileById = new Map(files.map((f) => [f.id, f]));
  const out = hunks.map((h): Hunk => ({ ...h }));

  for (const h of out) {
    const file = fileById.get(h.fileId)!;
    if (file.generated) h.kind = 'generated';
    else if (isFormatOnly(h, file, sources.get(h.fileId))) h.kind = 'format';
  }

  const moves = detectMoves(out, files, sources, ctx.config.grouping.moveSimilarity);
  return { hunks: out, moves };
};

function isFormatOnly(h: Hunk, file: FileChange, src: FileSources | undefined): boolean {
  const dels = h.lines.filter((l) => l.kind === 'del');
  const adds = h.lines.filter((l) => l.kind === 'add');
  if (dels.length + adds.length === 0) return false;

  if (!src?.old || !src.new) {
    // Tier 0, or an added/deleted file: only blank-line changes are formatting. An added or
    // deleted file is never formatting-only, even if it is blank.
    if (file.status === 'added' || file.status === 'deleted') return false;
    return [...dels, ...adds].every((l) => l.text.trim() === '');
  }

  const oldCode = dels.map((l) => l.oldNo!).filter((n) => src.old!.isContentLine(n));
  const newCode = adds.map((l) => l.newNo!).filter((n) => src.new!.isContentLine(n));
  if (oldCode.length === 0 && newCode.length === 0) return true;
  if (oldCode.length === 0 || newCode.length === 0) return false;
  return (
    src.old.coverFingerprint(Math.min(...oldCode), Math.max(...oldCode)) ===
    src.new.coverFingerprint(Math.min(...newCode), Math.max(...newCode))
  );
}

interface Region {
  fileId: string;
  hunk: Hunk;
  symbol: SourceSymbol;
  /** Indexes into hunk.lines covered by the symbol, and their trimmed non-blank text. */
  indexes: number[];
  text: string[];
  textIndexes: number[];
}

function detectMoves(
  hunks: Hunk[],
  files: FileChange[],
  sources: Map<string, FileSources>,
  threshold: number,
): MovePair[] {
  const removed: Region[] = [];
  const added: Region[] = [];
  const logicByFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    if (h.kind !== 'logic') continue;
    const list = logicByFile.get(h.fileId) ?? [];
    list.push(h);
    logicByFile.set(h.fileId, list);
  }

  for (const f of files) {
    const src = sources.get(f.id);
    const fileHunks = logicByFile.get(f.id);
    if (!src || !fileHunks || f.language === 'json') continue;
    if (src.old) removed.push(...regions(f.id, fileHunks, src.old, 'del'));
    if (src.new) added.push(...regions(f.id, fileHunks, src.new, 'add'));
  }

  // Score every candidate pair, then take the best ones greedily (deterministic order).
  const candidates: { r: Region; a: Region; similarity: number; exact: boolean }[] = [];
  for (const r of removed) {
    for (const a of added) {
      if (r.symbol.fingerprint === a.symbol.fingerprint) {
        candidates.push({ r, a, similarity: 1, exact: true });
        continue;
      }
      if (r.text.length < MIN_FUZZY_MOVE_LINES || a.text.length < MIN_FUZZY_MOVE_LINES) continue;
      const similarity = matchLines(r.text, a.text).similarity;
      if (similarity >= threshold) candidates.push({ r, a, similarity, exact: false });
    }
  }
  const key = (x: Region) => `${x.hunk.id}\u0000${String(x.symbol.startLine).padStart(9, '0')}`;
  candidates.sort(
    (x, y) =>
      Number(y.exact) - Number(x.exact) ||
      y.similarity - x.similarity ||
      compareStrings(key(x.r), key(y.r)) ||
      compareStrings(key(x.a), key(y.a)),
  );
  const usedR = new Set<Region>();
  const usedA = new Set<Region>();
  const pairs: { r: Region; a: Region; similarity: number; exact: boolean }[] = [];
  for (const c of candidates) {
    if (usedR.has(c.r) || usedA.has(c.a)) continue;
    usedR.add(c.r);
    usedA.add(c.a);
    pairs.push(c);
  }

  // A hunk becomes a move only if all its changed, non-blank lines are covered by matched
  // regions, and the same holds for every partner hunk. Otherwise both halves stay logic.
  const regionsByHunk = new Map<Hunk, Region[]>();
  for (const p of pairs) {
    for (const region of [p.r, p.a])
      regionsByHunk.set(region.hunk, [...(regionsByHunk.get(region.hunk) ?? []), region]);
  }
  const covered = (h: Hunk) => {
    const inRegions = new Set((regionsByHunk.get(h) ?? []).flatMap((r) => r.indexes));
    return h.lines.every(
      (l, i) => l.kind === 'context' || l.text.trim() === '' || inRegions.has(i),
    );
  };
  const accepted = pairs.filter((p) => covered(p.r.hunk) && covered(p.a.hunk));
  const rejectedHunks = new Set(
    pairs.filter((p) => !accepted.includes(p)).flatMap((p) => [p.r.hunk, p.a.hunk]),
  );
  const finalPairs = accepted.filter(
    (p) => !rejectedHunks.has(p.r.hunk) && !rejectedHunks.has(p.a.hunk),
  );

  const changed = new Map<Hunk, number[]>();
  for (const p of finalPairs) {
    const diff = p.exact ? { unmatchedA: [], unmatchedB: [] } : matchLines(p.r.text, p.a.text);
    changed.set(p.r.hunk, [
      ...(changed.get(p.r.hunk) ?? []),
      ...diff.unmatchedA.map((i) => p.r.textIndexes[i]!),
    ]);
    changed.set(p.a.hunk, [
      ...(changed.get(p.a.hunk) ?? []),
      ...diff.unmatchedB.map((j) => p.a.textIndexes[j]!),
    ]);
  }
  for (const p of finalPairs) {
    for (const [self, other] of [
      [p.r, p.a],
      [p.a, p.r],
    ] as const) {
      // A hunk holding several moved symbols describes its first move; changed lines cover all.
      if (self.hunk.kind === 'move') continue;
      self.hunk.kind = 'move';
      self.hunk.move = {
        fromFileId: p.r.fileId,
        fromStart: p.r.symbol.startLine,
        similarity: round(p.similarity),
        changedLineIndexes: [...new Set(changed.get(self.hunk) ?? [])].sort((x, y) => x - y),
        pairHunkId: other.hunk.id,
      };
    }
  }

  return finalPairs.map((p) => ({
    from: { fileId: p.r.fileId, hunkId: p.r.hunk.id, symbol: p.r.symbol },
    to: { fileId: p.a.fileId, hunkId: p.a.hunk.id, symbol: p.a.symbol },
    similarity: round(p.similarity),
  }));
}

/**
 * Outermost symbols whose every line is a `del` (or `add`) line of one hunk: candidates for
 * having been moved.
 */
function regions(fileId: string, hunks: Hunk[], src: ParsedSource, side: 'del' | 'add'): Region[] {
  const lineNo = (l: DiffLine) => (side === 'del' ? l.oldNo : l.newNo);
  const out: Region[] = [];
  const taken = new Set<number>();
  src.symbols.forEach((symbol, index) => {
    if (symbol.parent !== null && taken.has(symbol.parent)) {
      taken.add(index);
      return;
    }
    for (const hunk of hunks) {
      const indexes: number[] = [];
      hunk.lines.forEach((l, i) => {
        const n = lineNo(l);
        if (l.kind === side && n !== undefined && n >= symbol.startLine && n <= symbol.endLine)
          indexes.push(i);
      });
      if (indexes.length !== symbol.endLine - symbol.startLine + 1) continue;
      const textIndexes = indexes.filter((i) => hunk.lines[i]!.text.trim() !== '');
      out.push({
        fileId,
        hunk,
        symbol,
        indexes,
        text: textIndexes.map((i) => hunk.lines[i]!.text.trim()),
        textIndexes,
      });
      taken.add(index);
      return;
    }
  });
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
