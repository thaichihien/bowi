/**
 * Stage 6: the change graph (GRAPH-1..10).
 *
 * Input: files, hunks, changed symbols, parsed sources and line owners. Output: ChangeEdge[]
 * between changed symbols, each with a weight and a one-sentence evidence.
 *
 * - calls / uses-type: a changed symbol calls, instantiates, references the type of, or uses a
 *   changed field of another changed symbol that its file can see (same file or imported).
 * - tests: the same, from a symbol in a test file; plus `x.spec.ts` ↔ `x.ts` by name. Test code
 *   that uses a changed test helper, fixture or test entity gets a calls / uses-type edge to it.
 * - same-symbol: two symbols changed in one hunk (they cannot be separated).
 * - shared-literal / docs-mentions: the same distinctive literal in changed lines of different
 *   files, or a docs change naming a changed symbol.
 * - same-commit: symbols in different files whose added lines come from the same commit of the
 *   PR (only with more than one commit; a commit touching most of the PR's files is skipped).
 * - co-change: files that often changed together in the base branch's recent history.
 * - framework: edges from framework plugins (NestJS injection, queues, entity columns).
 * - Hub down-weighting: edges touching a symbol with many structural neighbours are weakened,
 *   so a shared logger or base type does not pull unrelated changes together.
 */

import type { ParsedSource, Reference } from '@bowi/lang';
import { compareStrings } from '../determinism.ts';
import { createImportResolver } from '../graph/imports.ts';
import { literalsIn } from '../graph/literals.ts';
import { DEFAULT_FAMILY, familyOf } from '../languages/index.ts';
import type { FrameworkPlugin } from '../plugin.ts';
import type { Stage } from '../stage.ts';
import type { ChangedSymbol, ChangeEdge, Commit, FileChange, Hunk } from '../types.ts';
import type { HistoryStageOutput } from './history.ts';
import type { FileSources } from './parse.ts';

export interface GraphStageInput {
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  sources: Map<string, FileSources>;
  lineSymbols: Map<string, (string | null)[]>;
  /** Blame and base history (GRAPH-6, GRAPH-7); none means no history edges. */
  history?: HistoryStageOutput;
  commits?: Commit[];
  plugins?: FrameworkPlugin[];
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
/** co-change: commits that touch more files than this are bulk changes and say nothing. */
const MAX_COMMIT_FILES = 30;
/** co-change: files must have changed together this often, in at least this share of commits. */
const MIN_CO_CHANGES = 3;
const MIN_CO_CHANGE_SHARE = 0.5;
const MIN_DOCS_NAME_LENGTH = 5;
const REF_PRIORITY: Reference['kind'][] = ['call', 'new', 'type', 'member', 'key', 'name'];
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

  // Which changed files each file imports (old and new versions). In a language with packages
  // (Go), an import brings in every changed file of the package, and files of one package see
  // each other.
  const resolve = createImportResolver(files);
  const packageOf = (f: FileChange) => familyOf(f.language)?.packageOf?.(f.path);
  const filesOfPackage = new Map<string, string[]>();
  for (const f of files) {
    const p = packageOf(f);
    if (p !== undefined) filesOfPackage.set(p, [...(filesOfPackage.get(p) ?? []), f.id]);
  }
  const imported = new Map<string, Set<string>>();
  for (const f of files) {
    const src = sources.get(f.id);
    const set = new Set<string>();
    for (const v of [src?.old, src?.new]) {
      for (const imp of v?.imports ?? []) {
        const id = resolve(v === src?.old ? (f.oldPath ?? f.path) : f.path, imp.source);
        if (!id) continue;
        set.add(id);
        const p = packageOf(fileById.get(id)!);
        for (const other of p !== undefined ? (filesOfPackage.get(p) ?? []) : []) set.add(other);
      }
    }
    imported.set(f.id, set);
  }
  const samePackage = (a: string, b: string) => {
    const p = packageOf(fileById.get(a)!);
    return p !== undefined && p === packageOf(fileById.get(b)!);
  };
  const visible = (from: ChangedSymbol, to: ChangedSymbol) =>
    from.fileId === to.fileId ||
    (imported.get(from.fileId)?.has(to.fileId) ?? false) ||
    samePackage(from.fileId, to.fileId);

  // Call and type targets by name, and changed fields by name.
  // Test helpers, fixtures and test entities are targets too, for test code only: a new test
  // belongs with the entity or helper it imports. Application code never depends on tests.
  const targets = new Map<string, ChangedSymbol[]>();
  for (const s of logic) {
    if (s.kind === 'file') continue;
    targets.set(s.name, [...(targets.get(s.name) ?? []), s]);
  }
  const fieldOwners = changedFields(logic, code, hunkById);

  for (const s of logic) {
    const c = code.get(s.id);
    // Strongest kind of use first, so an edge's evidence says "calls" when there is a call.
    const refs = (
      c
        ? c.source.references.filter((r) => c.lines(r.line))
        : refsOnOwnedLines(s, hunkById, lineSymbols, sources)
    )
      .filter((r) => r.kind !== 'declaration')
      .sort(
        (x, y) => REF_PRIORITY.indexOf(x.kind) - REF_PRIORITY.indexOf(y.kind) || x.line - y.line,
      );
    const isTest = s.layer === 'test';
    for (const ref of refs) {
      for (const t of targets.get(ref.name) ?? []) {
        if (t.id === s.id || !visible(s, t) || isAncestor(t, s)) continue;
        if (t.layer === 'test' && !isTest) continue;
        const type = isTest && t.layer !== 'test' ? 'tests' : edgeTypeFor(ref, t);
        if (type)
          edges.add(s, t, type, evidence(type, s, t, ref), { fileId: s.fileId, line: ref.line });
      }
      // Fields are reached as `obj.field`, `{ field: x }` or `{ field }`; a bare identifier is a
      // local variable that happens to share the name.
      if ((ref.kind === 'member' || ref.kind === 'key') && !COMMON_MEMBERS.has(ref.name)) {
        for (const owner of fieldOwners.get(ref.name) ?? []) {
          if (owner.id === s.id || !visible(s, owner) || isAncestor(owner, s)) continue;
          if (owner.layer === 'test' && !isTest) continue;
          const type = isTest && owner.layer !== 'test' ? 'tests' : 'uses-type';
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
  if (input.history) {
    sameCommit(logic, hunkById, lineSymbols, input.history, input.commits ?? [], edges);
    coChange(logic, fileById, input.history.baseCommits, edges);
  }
  const byId = new Map(symbols.map((s) => [s.id, s]));
  for (const plugin of input.plugins ?? []) {
    for (const e of plugin.extraEdges?.({ files, hunks, symbols, sources, lineSymbols }) ?? []) {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (from && to && from.id !== to.id) edges.add(from, to, 'framework', e.text, ...e.locations);
    }
  }

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
        if (l.kind === 'add' && c.source.isContentLine(l.newNo!)) changed.add(l.newNo!);
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

/**
 * `x.spec.ts` / `x.test.ts` tests `x.ts`, even without a call we can resolve. How a test file is
 * named is the test file's language family's rule.
 */
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
    const family = familyOf(fileById.get(s.fileId)!.language) ?? DEFAULT_FAMILY;
    const subject = family.testSubject(stem(path));
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
    const { importLine } = familyOf(fileById.get(h.fileId)!.language) ?? DEFAULT_FAMILY;
    h.lines.forEach((l, i) => {
      if (l.kind === 'context') return;
      const owner = byId.get(owners[i] ?? h.symbolIds[0] ?? '');
      if (!owner || !logicIds.has(owner.id)) return;
      const line = (l.kind === 'add' ? l.newNo : l.oldNo)!;
      if (owner.layer === 'docs' && l.kind === 'add') docsLines.push({ owner, text: l.text, line });
      for (const lit of literalsIn(l.text, importLine)) {
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

/**
 * Symbols whose added lines come from the same commit, linked across files: each file's first
 * such symbol to the first one of the commit (a star, not a clique).
 */
function sameCommit(
  logic: ChangedSymbol[],
  hunkById: Map<string, Hunk>,
  lineSymbols: Map<string, (string | null)[]>,
  history: HistoryStageOutput,
  commits: Commit[],
  edges: EdgeSet,
) {
  const logicIds = new Set(logic.map((s) => s.id));
  const byId = new Map(logic.map((s) => [s.id, s]));
  // commit → owner symbol → first location
  const owners = new Map<string, Map<string, { fileId: string; line: number }>>();
  for (const s of logic) {
    const blame = history.lineCommits.get(s.fileId);
    if (!blame) continue;
    for (const id of s.hunkIds) {
      const h = hunkById.get(id)!;
      const lineOwners = lineSymbols.get(id) ?? [];
      h.lines.forEach((l, i) => {
        if (l.kind !== 'add' || lineOwners[i] !== s.id || !logicIds.has(s.id)) return;
        const sha = blame[l.newNo! - 1];
        if (!sha) return;
        const m = owners.get(sha) ?? new Map();
        if (!m.has(s.id)) m.set(s.id, { fileId: s.fileId, line: l.newNo! });
        owners.set(sha, m);
      });
    }
  }
  const logicFiles = new Set(logic.map((s) => s.fileId)).size;
  const maxFiles = Math.max(3, Math.ceil(logicFiles * 0.5));
  const order = new Map(logic.map((s, i) => [s.id, i]));
  for (const commit of commits) {
    const m = owners.get(commit.sha);
    if (!m) continue;
    const firstPerFile = new Map<string, [string, { fileId: string; line: number }]>();
    for (const entry of [...m.entries()].sort((a, b) => order.get(a[0])! - order.get(b[0])!)) {
      if (!firstPerFile.has(entry[1].fileId)) firstPerFile.set(entry[1].fileId, entry);
    }
    if (firstPerFile.size < 2 || firstPerFile.size > maxFiles) continue;
    const [hub, ...others] = [...firstPerFile.values()];
    const a = byId.get(hub![0])!;
    for (const [id, loc] of others) {
      const b = byId.get(id)!;
      edges.add(
        a,
        b,
        'same-commit',
        `${show(a)} and ${show(b)} were changed in the same commit, ${commit.sha.slice(0, 7)} “${commit.subject}”`,
        hub![1],
        loc,
      );
    }
  }
}

/** Files that often changed together in the base history (GRAPH-7), via their first symbols. */
function coChange(
  logic: ChangedSymbol[],
  fileById: Map<string, FileChange>,
  baseCommits: string[][],
  edges: EdgeSet,
) {
  const firstOfFile = new Map<string, ChangedSymbol>();
  for (const s of logic) {
    if (!firstOfFile.has(s.fileId) && !fileById.get(s.fileId)!.generated)
      firstOfFile.set(s.fileId, s);
  }
  const fileIds = [...firstOfFile.keys()];
  if (fileIds.length < 2) return;
  const fileOfPath = new Map<string, string>();
  for (const id of fileIds) {
    const f = fileById.get(id)!;
    fileOfPath.set(f.path, id);
    if (f.oldPath) fileOfPath.set(f.oldPath, id);
  }
  const counts = new Map<string, number>();
  const together = new Map<string, number>();
  const used = baseCommits.filter((paths) => paths.length <= MAX_COMMIT_FILES);
  for (const paths of used) {
    const ids = [...new Set(paths.flatMap((p) => fileOfPath.get(p) ?? []))].sort(compareStrings);
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}\u0000${ids[j]}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }
  for (const [key, n] of [...together.entries()].sort((x, y) => compareStrings(x[0], y[0]))) {
    const [a, b] = key.split('\u0000') as [string, string];
    if (n < MIN_CO_CHANGES || n / Math.min(counts.get(a)!, counts.get(b)!) < MIN_CO_CHANGE_SHARE)
      continue;
    const from = firstOfFile.get(a)!;
    const to = firstOfFile.get(b)!;
    edges.add(
      from,
      to,
      'co-change',
      `${fileById.get(a)!.path} and ${fileById.get(b)!.path} changed together in ${n} of the last ${used.length} commits`,
    );
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

const UNDIRECTED = new Set<ChangeEdge['type']>([
  'same-symbol',
  'shared-literal',
  'same-commit',
  'co-change',
]);

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
    if (UNDIRECTED.has(type) && this.order.get(from.id)! > this.order.get(to.id)!) {
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
