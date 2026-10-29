/**
 * Clustering of logic symbols into groups (GRP-2, GRP-3).
 *
 * 1. Units: symbols changed in the same hunk are inseparable, so they form one unit.
 * 2. Strong pass: connected components over edges with weight ≥ threshold. A component that is
 *    too large (more than MAX_GROUP_SYMBOLS symbols and more than maxGroupShare of the logic
 *    hunks) is split with Louvain community detection (seeded, deterministic).
 * 3. Weak pass: units left alone are connected through any remaining edge among themselves, so
 *    a hub refactor (a logger signature and its 20 callers, all down-weighted) still forms one
 *    group without absorbing a feature that merely calls the hub.
 * 4. Attach: a unit still alone joins the group it has the strongest edge to, else a group
 *    with code in the same file, else in the same directory, else "Other changes".
 */

import { UndirectedGraph } from 'graphology';
import louvainModule from 'graphology-communities-louvain';
import type { ChangedSymbol, ChangeEdge, FileChange, Hunk } from '../types.ts';

export const MAX_GROUP_SYMBOLS = 25;
const LOUVAIN_SEED = 42;

// The package is CommonJS (`module.exports = louvain`) but its types declare a default export;
// under Node ESM the default import is the function itself.
const louvain = louvainModule as unknown as typeof louvainModule.default;

export type ClusterOrigin = 'strong' | 'weak' | 'other';

export interface Cluster {
  symbolIds: string[];
  origin: ClusterOrigin;
  /** Units that joined by folder or file proximity rather than an edge. */
  attached: { symbolIds: string[]; how: 'edge' | 'file' | 'directory' }[];
}

export interface ClusterInput {
  symbols: ChangedSymbol[]; // logic symbols, in reading order
  edges: ChangeEdge[];
  hunks: Hunk[];
  files: FileChange[];
  threshold: number;
  maxGroupShare: number;
}

export function clusterSymbols(input: ClusterInput): Cluster[] {
  const { symbols, edges, threshold } = input;
  const ids = new Set(symbols.map((s) => s.id));
  const order = new Map(symbols.map((s, i) => [s.id, i]));
  const symbolById = new Map(symbols.map((s) => [s.id, s]));
  const fileById = new Map(input.files.map((f) => [f.id, f]));

  // 1. Units.
  const unitOf = new UnionFind(symbols.map((s) => s.id));
  for (const h of input.hunks) {
    const inHunk = h.symbolIds.filter((id) => ids.has(id));
    for (const id of inHunk.slice(1)) unitOf.union(inHunk[0]!, id);
  }
  const units = unitOf.groups(order);
  const unitIndex = new Map<string, number>();
  units.forEach((u, i) => u.forEach((id) => unitIndex.set(id, i)));

  // Unit-level edges: the strongest edge between two units.
  const unitEdges = new Map<string, number>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const a = unitIndex.get(e.from)!;
    const b = unitIndex.get(e.to)!;
    if (a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    unitEdges.set(key, Math.max(unitEdges.get(key) ?? 0, e.weight));
  }
  const pairs = [...unitEdges.entries()]
    .map(([k, w]) => {
      const [a, b] = k.split(',').map(Number) as [number, number];
      return { a, b, w };
    })
    .sort((x, y) => x.a - y.a || x.b - y.b);

  // 2. Strong pass.
  const strong = new UnionFind(units.map((_, i) => String(i)));
  for (const p of pairs) if (p.w >= threshold) strong.union(String(p.a), String(p.b));
  let components = strong.groups().map((g) => g.map(Number));

  const logicHunks = new Set(input.hunks.filter((h) => h.kind === 'logic').map((h) => h.id)).size;
  const hunkCount = (unitIds: number[]) =>
    new Set(unitIds.flatMap((u) => units[u]!.flatMap((id) => symbolById.get(id)!.hunkIds))).size;
  components = components.flatMap((c) => {
    const symbolCount = c.reduce((n, u) => n + units[u]!.length, 0);
    if (symbolCount <= MAX_GROUP_SYMBOLS || hunkCount(c) <= input.maxGroupShare * logicHunks)
      return [c];
    return splitLouvain(c, pairs);
  });

  const clusters: { units: number[]; origin: ClusterOrigin; attached: Cluster['attached'] }[] = [];
  const alone: number[] = [];
  for (const c of components) {
    if (c.length > 1) clusters.push({ units: c, origin: 'strong', attached: [] });
    else alone.push(c[0]!);
  }

  // 3. Weak pass among units still alone.
  const aloneSet = new Set(alone);
  const weak = new UnionFind(alone.map(String));
  for (const p of pairs)
    if (aloneSet.has(p.a) && aloneSet.has(p.b)) weak.union(String(p.a), String(p.b));
  const singles: number[] = [];
  for (const g of weak.groups().map((x) => x.map(Number))) {
    if (g.length > 1) clusters.push({ units: g, origin: 'weak', attached: [] });
    else singles.push(g[0]!);
  }

  // 4. Attach the rest.
  const clusterOfUnit = new Map<number, number>();
  clusters.forEach((c, i) => c.units.forEach((u) => clusterOfUnit.set(u, i)));
  const filesOf = (u: number) => new Set(units[u]!.map((id) => symbolById.get(id)!.fileId));
  const dirOf = (fileId: string) => {
    const p = fileById.get(fileId)!.path;
    return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  };
  const other: number[] = [];
  for (const u of singles) {
    let target: number | undefined;
    let how: 'edge' | 'file' | 'directory' = 'edge';

    let best = 0;
    for (const p of pairs) {
      const peer = p.a === u ? p.b : p.b === u ? p.a : undefined;
      if (peer === undefined || !clusterOfUnit.has(peer)) continue;
      if (p.w > best) {
        best = p.w;
        target = clusterOfUnit.get(peer);
      }
    }
    if (target === undefined) {
      how = 'file';
      target = pickByOverlap(clusters, units, symbolById, (fileId) => filesOf(u).has(fileId));
    }
    if (target === undefined) {
      how = 'directory';
      const dirs = new Set([...filesOf(u)].map(dirOf));
      target = pickByOverlap(clusters, units, symbolById, (fileId) => dirs.has(dirOf(fileId)));
    }
    if (target === undefined) {
      other.push(u);
      continue;
    }
    clusters[target]!.units.push(u);
    clusters[target]!.attached.push({ symbolIds: units[u]!, how });
  }
  if (other.length > 0) clusters.push({ units: other, origin: 'other', attached: [] });

  return clusters.map((c) => ({
    symbolIds: c.units.flatMap((u) => units[u]!).sort((a, b) => order.get(a)! - order.get(b)!),
    origin: c.origin,
    attached: c.attached,
  }));
}

/** The cluster with the most symbols in files matching `match`, earliest on ties. */
function pickByOverlap(
  clusters: { units: number[] }[],
  units: string[][],
  symbolById: Map<string, ChangedSymbol>,
  match: (fileId: string) => boolean,
): number | undefined {
  let best: number | undefined;
  let bestCount = 0;
  clusters.forEach((c, i) => {
    const n = c.units
      .flatMap((u) => units[u]!)
      .filter((id) => match(symbolById.get(id)!.fileId)).length;
    if (n > bestCount) {
      best = i;
      bestCount = n;
    }
  });
  return best;
}

function splitLouvain(
  component: number[],
  pairs: { a: number; b: number; w: number }[],
): number[][] {
  const members = new Set(component);
  const graph = new UndirectedGraph();
  for (const u of component) graph.addNode(String(u));
  for (const p of pairs) {
    if (members.has(p.a) && members.has(p.b))
      graph.addEdge(String(p.a), String(p.b), { weight: p.w });
  }
  const communities = louvain(graph, { rng: seededRandom(LOUVAIN_SEED), getEdgeWeight: 'weight' });
  const byCommunity = new Map<number, number[]>();
  for (const u of component) {
    const c = communities[String(u)]!;
    byCommunity.set(c, [...(byCommunity.get(c) ?? []), u]);
  }
  return [...byCommunity.values()]
    .map((g) => g.sort((x, y) => x - y))
    .sort((x, y) => x[0]! - y[0]!);
}

/** Park–Miller generator: Louvain visits nodes in random order; a fixed seed keeps output stable. */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly keys: string[];

  constructor(keys: string[]) {
    this.keys = keys;
    for (const k of keys) this.parent.set(k, k);
  }

  find(k: string): string {
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(k, root);
    return root;
  }

  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  /** Groups in order of their first key; members in key order (or by `order` if given). */
  groups(order?: Map<string, number>): string[][] {
    const byRoot = new Map<string, string[]>();
    for (const k of this.keys) {
      const r = this.find(k);
      byRoot.set(r, [...(byRoot.get(r) ?? []), k]);
    }
    const out = [...byRoot.values()];
    if (order) for (const g of out) g.sort((a, b) => order.get(a)! - order.get(b)!);
    return out;
  }
}
