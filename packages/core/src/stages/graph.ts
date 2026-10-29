/**
 * Stage 6: the change graph (GRAPH-1..5, GRAPH-8, GRAPH-10).
 *
 * Input: files, hunks, changed symbols, parsed sources and line owners. Output: ChangeEdge[]
 * between changed symbols, each with a weight and a one-sentence evidence.
 *
 * - calls / uses-type: a changed symbol calls, instantiates, references the type of, or uses a
 *   changed field of another changed symbol that its file can see (same file or imported).
 * - tests: the same, from a symbol in a test file; plus `x.spec.ts` ↔ `x.ts` by name.
 * - same-symbol: two symbols changed in one hunk (they cannot be separated).
 * - shared-literal / docs-mentions: the same distinctive literal in changed lines of different
 *   files, or a docs change naming a changed symbol.
 * - Hub down-weighting: edges touching a symbol with many structural neighbours are weakened,
 *   so a shared logger or base type does not pull unrelated changes together.
 */

import type { ParsedSource, Reference } from '@bowi/lang';
import { compareStrings } from '../determinism.ts';
import { createImportResolver } from '../graph/imports.ts';
import { literalsIn } from '../graph/literals.ts';
import type { Stage } from '../stage.ts';
import type { ChangedSymbol, ChangeEdge, FileChange, Hunk } from '../types.ts';
import type { FileSources } from './parse.ts';

export interface GraphStageInput {
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  sources: Map<string, FileSources>;
  lineSymbols: Map<string, (string | null)[]>;
}

export interface GraphStageOutput {
  edges: ChangeEdge[];
}

export const EDGE_WEIGHTS: Record<ChangeEdge['type'], number> = {
  calls: 1,
  'same-symbol': 1,
  'uses-type': 0.9,
  tests: 0.8,
  framework: 0.8,
  'shared-literal': 0.6,
  'docs-mentions': 0.6,
  'same-commit': 0.4,
  'co-change': 0.3,
};

/** Symbols with more structural neighbours than this count as hubs (GRAPH-10). */
export const HUB_DEGREE = 6;
const MIN_DOCS_NAME_LENGTH = 5;
/** Member names too common to link a use to a changed field. */
const COMMON_MEMBERS = new Set([
  'id',
  'name',
  'type',
  'kind',
  'key',
  'keys',
  'value',
  'values',
  'data',
  'items',
  'length',
  'size',
  'path',
  'text',
  'label',
  'title',
  'status',
  'state',
  'options',
  'config',
  'index',
  'count',
  'parent',
  'children',
  'error',
  'message',
  'result',
  'source',
  'target',
  'start',
  'end',
  'line',
  'lines',
]);
const MAX_LOCATIONS = 3;

interface SymbolCode {
  symbol: ChangedSymbol;
  source: ParsedSource;
  /** Lines of the symbol itself, without nested symbols (they are separate nodes). */
  lines: (line: number) => boolean;
}

export const graphStage: Stage<GraphStageInput, GraphStageOutput> = async (input) => {
  const { files, hunks, symbols, sources, lineSymbols } = input;
  const fileById = new Map(files.map((f) => [f.id, f]));
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const order = new Map(symbols.map((s, i) => [s.id, i]));
  const logic = symbols.filter((s) => s.hunkIds.some((id) => hunkById.get(id)!.kind === 'logic'));
  const edges = new EdgeSet(order);

  const nodeNames = new Map<string, Set<string>>();
  for (const s of symbols)
    nodeNames.set(s.fileId, (nodeNames.get(s.fileId) ?? new Set()).add(s.qualifiedName));
  const code = new Map<string, SymbolCode>();
  for (const s of logic) {
    const c = symbolCode(s, sources.get(s.fileId), nodeNames.get(s.fileId)!);
    if (c) code.set(s.id, c);
  }

  // Which changed files each file imports (old and new versions).
  const resolve = createImportResolver(files);
  const imported = new Map<string, Set<string>>();
  for (const f of files) {
    const src = sources.get(f.id);
    const set = new Set<string>();
    for (const v of [src?.old, src?.new]) {
      for (const imp of v?.imports ?? []) {
        const id = resolve(v === src?.old ? (f.oldPath ?? f.path) : f.path, imp.source);
        if (id) set.add(id);
      }
    }
    imported.set(f.id, set);
  }
  const visible = (from: ChangedSymbol, to: ChangedSymbol) =>
    from.fileId === to.fileId || (imported.get(from.fileId)?.has(to.fileId) ?? false);

  // Call and type targets by name, and changed fields by name.
  const targets = new Map<string, ChangedSymbol[]>();
  for (const s of logic) {
    if (s.kind === 'file' || s.layer === 'test') continue;
    targets.set(s.name, [...(targets.get(s.name) ?? []), s]);
  }
  const fieldOwners = changedFields(logic, code, hunkById);

  for (const s of logic) {
    const c = code.get(s.id);
    const refs = c
      ? c.source.references.filter((r) => c.lines(r.line))
      : refsOnOwnedLines(s, hunkById, lineSymbols, sources);
    const isTest = s.layer === 'test';
    for (const ref of refs) {
      for (const t of targets.get(ref.name) ?? []) {
        if (t.id === s.id || !visible(s, t) || isAncestor(t, s)) continue;
        const type = isTest ? 'tests' : edgeTypeFor(ref, t);
        if (type)
          edges.add(s, t, type, evidence(type, s, t, ref), { fileId: s.fileId, line: ref.line });
      }
      // Fields are reached as `obj.field`, `{ field: x }` or `{ field }`; a bare identifier is a
      // local variable that happens to share the name.
      if ((ref.kind === 'member' || ref.kind === 'key') && !COMMON_MEMBERS.has(ref.name)) {
        for (const owner of fieldOwners.get(ref.name) ?? []) {
          if (owner.id === s.id || !visible(s, owner) || isAncestor(owner, s)) continue;
          const type = isTest ? 'tests' : 'uses-type';
          edges.add(s, owner, type, `${show(s)} uses \`${owner.qualifiedName}.${ref.name}\``, {
            fileId: s.fileId,
            line: ref.line,
          });
        }
      }
    }
  }

  testsByFileName(logic, fileById, edges);
  sameHunk(hunks, symbols, edges);
  literalEdges(logic, hunks, fileById, lineSymbols, symbols, edges);

  return { edges: downWeightHubs(edges.list()) };
};

/**
 * The code of a changed symbol: its lines minus nested symbols that are graph nodes of their
 * own. Nested symbols folded into it (the methods of a new class) stay part of it.
 */
function symbolCode(
  s: ChangedSymbol,
  src: FileSources | undefined,
  nodeNames: Set<string>,
): SymbolCode | undefined {
  if (s.kind === 'file' || !src) return undefined;
  const hasNew = s.change !== 'deleted' && src.new;
  const source = hasNew ? src.new! : src.old;
  if (!source) return undefined;
  const index = source.symbols.findIndex((x) => x.qualifiedName === s.qualifiedName);
  if (index === -1) return undefined;
  const sym = source.symbols[index]!;
  const isDescendant = (i: number | null): boolean =>
    i !== null && (i === index || isDescendant(source.symbols[i]!.parent));
  const children = source.symbols.filter(
    (x, i) => i !== index && nodeNames.has(x.qualifiedName) && isDescendant(x.parent),
  );
  return {
    symbol: s,
    source,
    lines: (line) =>
      line >= sym.startLine &&
      line <= sym.endLine &&
      !children.some((ch) => line >= ch.startLine && line <= ch.endLine),
  };
}

/** References on the changed lines a file pseudo-symbol owns (top-level code). */
function refsOnOwnedLines(
  s: ChangedSymbol,
  hunkById: Map<string, Hunk>,
  lineSymbols: Map<string, (string | null)[]>,
  sources: Map<string, FileSources>,
): Reference[] {
  const src = sources.get(s.fileId);
  if (!src) return [];
  const oldLines = new Set<number>();
  const newLines = new Set<number>();
  for (const id of s.hunkIds) {
    const h = hunkById.get(id)!;
    const owners = lineSymbols.get(id) ?? [];
    h.lines.forEach((l, i) => {
      if (owners[i] !== s.id) return;
      if (l.kind === 'del') oldLines.add(l.oldNo!);
      if (l.kind === 'add') newLines.add(l.newNo!);
    });
  }
  return [
    ...(src.new?.references.filter((r) => newLines.has(r.line)) ?? []),
    ...(src.old?.references.filter((r) => oldLines.has(r.line)) ?? []),
  ];
}

/** Fields declared on changed lines of changed classes, interfaces and types, by name. */
function changedFields(
  logic: ChangedSymbol[],
  code: Map<string, SymbolCode>,
  hunkById: Map<string, Hunk>,
): Map<string, ChangedSymbol[]> {
  const out = new Map<string, ChangedSymbol[]>();
  for (const s of logic) {
    if (s.kind !== 'class' && s.kind !== 'interface' && s.kind !== 'type') continue;
    const c = code.get(s.id);
    if (!c) continue;
    const changed = new Set<number>();
    for (const id of s.hunkIds) {
      for (const l of hunkById.get(id)!.lines) {
        if (l.kind === 'add' && c.source.isCodeLine(l.newNo!)) changed.add(l.newNo!);
      }
    }
    for (const f of c.source.fields) {
      if (!changed.has(f.line) || !c.lines(f.line)) continue;
      out.set(f.name, [...(out.get(f.name) ?? []), s]);
    }
  }
  return out;
}

function edgeTypeFor(ref: Reference, target: ChangedSymbol): ChangeEdge['type'] | undefined {
  const isType = target.kind === 'class' || target.kind === 'interface' || target.kind === 'type';
  switch (ref.kind) {
    case 'call':
      return isType ? undefined : 'calls';
    case 'new':
      return 'calls';
    case 'type':
      return isType ? 'uses-type' : undefined;
    case 'name':
      // A function passed by name is effectively called; a constant or type is used.
      return target.kind === 'function' || target.kind === 'method' ? 'calls' : 'uses-type';
    case 'member':
      return target.kind === 'method' ? 'calls' : undefined;
    default:
      return undefined;
  }
}

function evidence(
  type: ChangeEdge['type'],
  from: ChangedSymbol,
  to: ChangedSymbol,
  ref: Reference,
): string {
  switch (type) {
    case 'calls':
      return ref.kind === 'call' || ref.kind === 'new'
        ? `${show(from)} calls ${show(to)}`
        : `${show(from)} uses ${show(to)}`;
    case 'uses-type':
      return `${show(from)} uses ${show(to)}`;
    case 'tests':
      return `${show(from)} tests ${show(to)}`;
    default:
      return `${show(from)} is related to ${show(to)}`;
  }
}

/** `x.spec.ts` / `x.test.ts` tests `x.ts`, even without a call we can resolve. */
function testsByFileName(
  logic: ChangedSymbol[],
  fileById: Map<string, FileChange>,
  edges: EdgeSet,
) {
  const stem = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const firstByStem = new Map<string, ChangedSymbol>();
  for (const s of logic) {
    if (s.layer === 'test' || s.kind === 'file') continue;
    const key = stem(fileById.get(s.fileId)!.path);
    if (!firstByStem.has(key)) firstByStem.set(key, s);
  }
  for (const s of logic) {
    if (s.layer !== 'test' || edges.hasFrom(s.id, 'tests')) continue;
    const path = fileById.get(s.fileId)!.path;
    const subject = stem(path).replace(/\.(spec|test|e2e-spec)$/, '');
    if (subject === stem(path)) continue;
    const t = firstByStem.get(subject);
    if (!t) continue;
    const target = fileById.get(t.fileId)!.path;
    edges.add(
      s,
      t,
      'tests',
      s.kind === 'file'
        ? `${path} is the test file for ${target}`
        : `${show(s)} is in ${path}, the tests for ${target}`,
      {
        fileId: s.fileId,
        line: 0,
      },
    );
  }
}

function sameHunk(hunks: Hunk[], symbols: ChangedSymbol[], edges: EdgeSet) {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  for (const h of hunks) {
    if (h.kind !== 'logic' || h.symbolIds.length < 2) continue;
    const [first, ...rest] = h.symbolIds.map((id) => byId.get(id)!);
    for (const other of rest) {
      edges.add(
        first!,
        other,
        'same-symbol',
        `${show(first!)} and ${show(other)} are changed in the same hunk`,
        {
          fileId: h.fileId,
          line: h.newStart,
        },
      );
    }
  }
}

function literalEdges(
  logic: ChangedSymbol[],
  hunks: Hunk[],
  fileById: Map<string, FileChange>,
  lineSymbols: Map<string, (string | null)[]>,
  symbols: ChangedSymbol[],
  edges: EdgeSet,
) {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const logicIds = new Set(logic.map((s) => s.id));
  // literal → owner symbol → first location
  const occurrences = new Map<string, Map<string, { fileId: string; line: number }>>();
  const docsLines: { owner: ChangedSymbol; text: string; line: number }[] = [];

  for (const h of hunks) {
    if (h.kind !== 'logic') continue;
    const owners = lineSymbols.get(h.id) ?? [];
    h.lines.forEach((l, i) => {
      if (l.kind === 'context') return;
      const owner = byId.get(owners[i] ?? h.symbolIds[0] ?? '');
      if (!owner || !logicIds.has(owner.id)) return;
      const line = (l.kind === 'add' ? l.newNo : l.oldNo)!;
      if (owner.layer === 'docs' && l.kind === 'add') docsLines.push({ owner, text: l.text, line });
      for (const lit of literalsIn(l.text)) {
        const m = occurrences.get(lit) ?? new Map();
        if (!m.has(owner.id)) m.set(owner.id, { fileId: h.fileId, line });
        occurrences.set(lit, m);
      }
    });
  }

  const logicFiles = new Set(logic.map((s) => s.fileId)).size;
  const maxFiles = Math.max(5, Math.ceil(logicFiles * 0.3));
  for (const lit of [...occurrences.keys()].sort(compareStrings)) {
    const owners = [...occurrences.get(lit)!.entries()];
    const filesWith = new Set(owners.map(([, loc]) => loc.fileId));
    if (filesWith.size < 2 || filesWith.size > maxFiles) continue;
    // Link each file's first owner to the first owner of the first file: a star, not a clique.
    const firstPerFile = new Map<string, [string, { fileId: string; line: number }]>();
    for (const o of owners) if (!firstPerFile.has(o[1].fileId)) firstPerFile.set(o[1].fileId, o);
    const [hub, ...others] = [...firstPerFile.values()];
    for (const [id, loc] of others) {
      const a = byId.get(hub![0])!;
      const b = byId.get(id)!;
      const type = a.layer === 'docs' || b.layer === 'docs' ? 'docs-mentions' : 'shared-literal';
      edges.add(a, b, type, `${show(a)} and ${show(b)} both mention \`${lit}\``, hub![1], loc);
    }
  }

  // Docs naming a changed symbol: README mentions `verifyEmail`.
  for (const { owner, text, line } of docsLines) {
    for (const s of logic) {
      if (
        s.kind === 'file' ||
        s.layer === 'docs' ||
        s.layer === 'test' ||
        s.name.length < MIN_DOCS_NAME_LENGTH
      )
        continue;
      if (!new RegExp(`\\b${escapeRegExp(s.name)}\\b`).test(text)) continue;
      edges.add(
        owner,
        s,
        'docs-mentions',
        `${fileById.get(owner.fileId)!.path} mentions ${show(s)}`,
        {
          fileId: owner.fileId,
          line,
        },
      );
    }
  }
}

function downWeightHubs(edges: ChangeEdge[]): ChangeEdge[] {
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.type !== 'calls' && e.type !== 'uses-type' && e.type !== 'tests') continue;
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      const set = neighbours.get(a) ?? new Set();
      set.add(b);
      neighbours.set(a, set);
    }
  }
  const factor = (id: string) => {
    const d = neighbours.get(id)?.size ?? 0;
    return d <= HUB_DEGREE ? 1 : 1 / Math.log2(d / HUB_DEGREE + 1);
  };
  return edges.map((e) =>
    e.type === 'same-symbol'
      ? e
      : { ...e, weight: round(e.weight * Math.min(factor(e.from), factor(e.to))) },
  );
}

/** Edges deduplicated by (from, to, type), in a deterministic order. */
class EdgeSet {
  private readonly edges = new Map<string, ChangeEdge>();
  private readonly order: Map<string, number>;

  constructor(order: Map<string, number>) {
    this.order = order;
  }

  add(
    from: ChangedSymbol,
    to: ChangedSymbol,
    type: ChangeEdge['type'],
    text: string,
    ...locations: { fileId: string; line: number }[]
  ) {
    // Undirected relations are stored with the earlier symbol first.
    if (
      (type === 'same-symbol' || type === 'shared-literal') &&
      this.order.get(from.id)! > this.order.get(to.id)!
    ) {
      [from, to] = [to, from];
    }
    const key = `${from.id}\u0000${to.id}\u0000${type}`;
    const existing = this.edges.get(key);
    if (existing) {
      for (const loc of locations) {
        if (existing.evidence.locations.length >= MAX_LOCATIONS) break;
        if (
          !existing.evidence.locations.some((l) => l.fileId === loc.fileId && l.line === loc.line)
        ) {
          existing.evidence.locations.push(loc);
        }
      }
      return;
    }
    this.edges.set(key, {
      from: from.id,
      to: to.id,
      type,
      weight: EDGE_WEIGHTS[type],
      evidence: { text, locations: locations.filter((l) => l.line > 0).slice(0, MAX_LOCATIONS) },
    });
  }

  hasFrom(id: string, type: ChangeEdge['type']): boolean {
    for (const e of this.edges.values()) if (e.from === id && e.type === type) return true;
    return false;
  }

  list(): ChangeEdge[] {
    const o = this.order;
    return [...this.edges.values()].sort(
      (a, b) =>
        o.get(a.from)! - o.get(b.from)! ||
        o.get(a.to)! - o.get(b.to)! ||
        compareStrings(a.type, b.type),
    );
  }
}

/** Display form used in evidence and reasons: `AuthService.register()`, `User`, `README.md`. */
export function show(s: ChangedSymbol): string {
  if (s.kind === 'file') return `\`${s.qualifiedName}\``;
  if ((s.kind === 'function' || s.kind === 'method') && !s.qualifiedName.endsWith(')'))
    return `\`${s.qualifiedName}()\``;
  return `\`${s.qualifiedName}\``;
}

function isAncestor(maybeParent: ChangedSymbol, s: ChangedSymbol): boolean {
  return (
    maybeParent.fileId === s.fileId && s.qualifiedName.startsWith(`${maybeParent.qualifiedName}.`)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const round = (x: number) => Math.round(x * 1000) / 1000;
