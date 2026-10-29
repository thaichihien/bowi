/**
 * Stage 5: map hunks to symbols and assign layers (SYM-1..4).
 *
 * Input: files, classified hunks, parsed sources and moves. Output: files with `layer`, hunks
 * with `symbolIds` and a symbol-based `header`, and the ChangedSymbol list.
 *
 * - Each changed line maps to its innermost enclosing symbol on its own side (old for `del`,
 *   new for `add`). If an enclosing symbol is itself new (or gone), the line maps to the
 *   outermost such symbol, so a new class is one symbol rather than one per method.
 * - Code lines outside any symbol (imports, top-level statements), and every hunk of a file
 *   without a grammar, map to the file's pseudo-symbol (SYM-3). Blank lines map to nothing.
 * - Generated and formatting-only hunks map to no symbol; move hunks map to the moved symbol.
 * - Old and new symbols with the same qualified name in the same file are one ChangedSymbol.
 *   One whose fingerprint did not change (only reformatted) is dropped.
 */

import type { ParsedSource, SourceSymbol } from '@bowi/lang';
import { compareStrings } from '../determinism.ts';
import { createLayerResolver } from '../layers.ts';
import type { Stage } from '../stage.ts';
import type { ChangedSymbol, FileChange, Hunk } from '../types.ts';
import type { MovePair } from './noise.ts';
import type { FileSources } from './parse.ts';

export interface SymbolStageInput {
  files: FileChange[];
  hunks: Hunk[];
  sources: Map<string, FileSources>;
  moves: MovePair[];
}

export interface SymbolStageOutput {
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  /** For each hunk, the symbol ID owning each line (by index into `lines`); null if none. */
  lineSymbols: Map<string, (string | null)[]>;
}

const FILE_SYMBOL = '<file>';

interface Entry {
  fileId: string;
  qualifiedName: string;
  old?: SourceSymbol;
  new?: SourceSymbol;
  moved?: MovePair;
  hunkIds: Set<string>;
}

export const symbolStage: Stage<SymbolStageInput, SymbolStageOutput> = async (input, ctx) => {
  const layerOf = createLayerResolver(ctx.config.layers);
  const files = input.files.map((f): FileChange => ({ ...f, layer: layerOf(f.path) }));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const hunks = input.hunks.map((h): Hunk => ({ ...h, symbolIds: [] }));
  const entries = new Map<string, Entry>();
  const lineSymbols = new Map<string, (string | null)[]>(
    hunks.map((h) => [h.id, h.lines.map(() => null)]),
  );

  const touch = (fileId: string, qualifiedName: string, hunk: Hunk): Entry => {
    const id = symbolId(fileId, qualifiedName);
    let e = entries.get(id);
    if (!e) {
      e = { fileId, qualifiedName, hunkIds: new Set() };
      entries.set(id, e);
    }
    e.hunkIds.add(hunk.id);
    if (!hunk.symbolIds.includes(id)) hunk.symbolIds.push(id);
    return e;
  };

  const movesByHunk = new Map<string, MovePair[]>();
  for (const m of input.moves) {
    for (const id of [m.from.hunkId, m.to.hunkId])
      movesByHunk.set(id, [...(movesByHunk.get(id) ?? []), m]);
  }

  for (const hunk of hunks) {
    if (hunk.kind === 'generated' || hunk.kind === 'format') continue;

    if (hunk.kind === 'move') {
      for (const m of movesByHunk.get(hunk.id) ?? []) {
        const e = touch(m.to.fileId, m.to.symbol.qualifiedName, hunk);
        const owners = lineSymbols.get(hunk.id)!;
        hunk.lines.forEach((l, i) => {
          if (l.kind !== 'context' && owners[i] === null)
            owners[i] = symbolId(m.to.fileId, m.to.symbol.qualifiedName);
        });
        e.new = m.to.symbol;
        e.old = m.from.symbol;
        e.moved = m;
      }
      continue;
    }

    const src = input.sources.get(hunk.fileId);
    let mapped = false;
    if (src) {
      for (const [index, line] of hunk.lines.entries()) {
        // Blank lines carry no meaning; a blank line added between two methods must not make
        // the class count as changed.
        if (line.kind === 'context' || line.text.trim() === '') continue;
        const side = line.kind === 'del' ? 'old' : 'new';
        const parsed = src[side];
        const other = src[side === 'old' ? 'new' : 'old'];
        const n = (line.kind === 'del' ? line.oldNo : line.newNo)!;
        if (!parsed) continue;
        const symbol = enclosing(parsed, other, n);
        if (symbol) {
          const e = touch(hunk.fileId, symbol.qualifiedName, hunk);
          e[side] = symbol;
          lineSymbols.get(hunk.id)![index] = symbolId(hunk.fileId, symbol.qualifiedName);
          mapped = true;
        } else if (parsed.isCodeLine(n)) {
          touch(hunk.fileId, FILE_SYMBOL, hunk);
          lineSymbols.get(hunk.id)![index] = symbolId(hunk.fileId, FILE_SYMBOL);
          mapped = true;
        }
      }
    }
    if (!mapped) {
      touch(hunk.fileId, FILE_SYMBOL, hunk);
      const owners = lineSymbols.get(hunk.id)!;
      hunk.lines.forEach((l, i) => {
        if (l.kind !== 'context') owners[i] = symbolId(hunk.fileId, FILE_SYMBOL);
      });
    }
  }

  // Fill in the other side of each symbol, then detect renames among one-sided symbols.
  for (const e of entries.values()) {
    if (e.qualifiedName === FILE_SYMBOL || e.moved) continue;
    const src = input.sources.get(e.fileId);
    e.old ??= src?.old?.symbols.find((s) => s.qualifiedName === e.qualifiedName);
    e.new ??= src?.new?.symbols.find((s) => s.qualifiedName === e.qualifiedName);
  }
  // A symbol whose old and new versions have equal fingerprints was only reformatted, even if
  // it shares a hunk with real changes. It is not a changed symbol; a hunk left without symbols
  // falls back to the file pseudo-symbol.
  for (const [id, e] of entries) {
    if (e.moved || !e.old || !e.new || e.old.fingerprint !== e.new.fingerprint) continue;
    entries.delete(id);
    for (const h of hunks) {
      if (!h.symbolIds.includes(id)) continue;
      h.symbolIds = h.symbolIds.filter((x) => x !== id);
      if (h.symbolIds.length === 0) touch(h.fileId, FILE_SYMBOL, h);
    }
  }

  const renamedFrom = new Map<Entry, Entry>();
  const oldOnly = [...entries.values()].filter((e) => e.old && !e.new && !e.moved);
  for (const e of entries.values()) {
    if (!e.new || e.old || e.moved) continue;
    const match = oldOnly.find(
      (o) =>
        o.fileId === e.fileId &&
        !renamedFrom.has(o) &&
        o.old!.shapeFingerprint === e.new!.shapeFingerprint,
    );
    if (match) renamedFrom.set(match, e);
  }
  for (const [from, to] of renamedFrom) {
    to.old = from.old!;
    for (const id of from.hunkIds) to.hunkIds.add(id);
    const fromId = symbolId(from.fileId, from.qualifiedName);
    const toId = symbolId(to.fileId, to.qualifiedName);
    entries.delete(fromId);
    for (const h of hunks) {
      if (!h.symbolIds.includes(fromId)) continue;
      h.symbolIds = h.symbolIds.filter((id) => id !== fromId);
      if (!h.symbolIds.includes(toId)) h.symbolIds.push(toId);
    }
  }

  const hunkOrder = new Map(hunks.map((h, i) => [h.id, i]));
  const startLine = new Map<string, number>();
  const symbols: ChangedSymbol[] = [...entries.entries()].map(([id, e]) => {
    startLine.set(id, (e.new ?? e.old)?.startLine ?? 0);
    const file = fileById.get(e.fileId)!;
    const sym = e.new ?? e.old;
    const changed: ChangedSymbol = {
      id,
      name: e.qualifiedName === FILE_SYMBOL ? baseName(file.path) : sym!.name,
      qualifiedName: e.qualifiedName === FILE_SYMBOL ? file.path : e.qualifiedName,
      kind: e.qualifiedName === FILE_SYMBOL ? 'file' : sym!.kind,
      fileId: e.fileId,
      change: changeOf(e, file, renamedFrom),
      layer: file.layer,
      hunkIds: [...e.hunkIds].sort((a, b) => hunkOrder.get(a)! - hunkOrder.get(b)!),
    };
    if (e.old && e.qualifiedName !== FILE_SYMBOL) changed.oldSignature = e.old.signature;
    if (e.new && e.qualifiedName !== FILE_SYMBOL) changed.newSignature = e.new.signature;
    return changed;
  });
  // Reading order: by first hunk, then by position in the file.
  symbols.sort(
    (a, b) =>
      hunkOrder.get(a.hunkIds[0]!)! - hunkOrder.get(b.hunkIds[0]!)! ||
      startLine.get(a.id)! - startLine.get(b.id)! ||
      compareStrings(a.qualifiedName, b.qualifiedName),
  );

  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  for (const h of hunks) {
    h.symbolIds.sort(
      (a, b) => symbols.indexOf(symbolById.get(a)!) - symbols.indexOf(symbolById.get(b)!),
    );
    const first = symbolById.get(h.symbolIds[0] ?? '');
    if (first && first.kind !== 'file') h.header = displayName(first);
  }

  // Line owners follow renames; lines of dropped (reformatted-only) symbols have no owner.
  const renamedIds = new Map(
    [...renamedFrom].map(([from, to]) => [
      symbolId(from.fileId, from.qualifiedName),
      symbolId(to.fileId, to.qualifiedName),
    ]),
  );
  for (const owners of lineSymbols.values()) {
    owners.forEach((id, i) => {
      if (id === null) return;
      const final = renamedIds.get(id) ?? id;
      owners[i] = symbolById.has(final) ? final : null;
    });
  }

  return { files, hunks, symbols, lineSymbols };
};

export function symbolId(fileId: string, qualifiedName: string): string {
  return `${fileId}#${qualifiedName}`;
}

/**
 * Innermost symbol containing `line`, lifted to the outermost enclosing symbol that does not
 * exist on the other side (a new class maps to the class, not to each of its new methods).
 */
function enclosing(
  parsed: ParsedSource,
  other: ParsedSource | undefined,
  line: number,
): SourceSymbol | undefined {
  let innermost = -1;
  parsed.symbols.forEach((s, i) => {
    if (s.startLine <= line && line <= s.endLine) innermost = i; // later = deeper (position order)
  });
  if (innermost === -1) return undefined;
  const otherNames = new Set(other?.symbols.map((s) => s.qualifiedName));
  let chosen = innermost;
  for (let i: number | null = innermost; i !== null; i = parsed.symbols[i]!.parent) {
    if (!otherNames.has(parsed.symbols[i]!.qualifiedName)) chosen = i;
  }
  return parsed.symbols[chosen];
}

function changeOf(
  e: Entry,
  file: FileChange,
  renamedFrom: Map<Entry, Entry>,
): ChangedSymbol['change'] {
  if (e.moved) return 'moved';
  if (e.qualifiedName === FILE_SYMBOL) {
    return file.status === 'added' ? 'added' : file.status === 'deleted' ? 'deleted' : 'body';
  }
  if ([...renamedFrom.values()].includes(e)) return 'renamed';
  if (!e.old) return 'added';
  if (!e.new) return 'deleted';
  return e.old.signature === e.new.signature ? 'body' : 'signature';
}

function displayName(s: ChangedSymbol): string {
  switch (s.kind) {
    case 'function':
    case 'method':
      return s.name.endsWith(')') ? s.name : `${s.name}()`;
    case 'class':
    case 'interface':
    case 'type':
      return `${s.kind} ${s.name}`;
    default:
      return s.name;
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
