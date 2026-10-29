/**
 * Steps within a group (GRP-7, GRP-9).
 *
 * One step per layer, in layer order; `schema` and `data` share one "Data shape" step. Within a
 * step, files are ordered so that what a file uses comes before it (topological order over the
 * graph's edges; cycles are condensed with Tarjan's algorithm and kept together), ties by path.
 * Hunks of one file stay together, in file order.
 */

import { compareStrings } from '../determinism.ts';
import type { ChangeEdge, FileChange, Hunk, Layer, Step } from '../types.ts';

export const LAYER_ORDER: Layer[] = [
  'schema',
  'data',
  'domain',
  'service',
  'api',
  'ui',
  'unknown',
  'config',
  'test',
  'docs',
];

const LAYER_TITLES: Record<Layer, string> = {
  schema: 'Data shape',
  data: 'Data shape',
  domain: 'Domain',
  service: 'Services',
  api: 'API',
  ui: 'UI',
  unknown: 'Other code',
  config: 'Configuration',
  test: 'Tests',
  docs: 'Docs',
};

/** Edge types that mean "from uses to", so `to` should be read first. */
const DEPENDENCY_TYPES = new Set<ChangeEdge['type']>(['calls', 'uses-type', 'tests', 'framework']);

const stepKey = (layer: Layer): Layer => (layer === 'schema' ? 'data' : layer);

export function buildSteps(
  groupId: string,
  hunks: Hunk[],
  fileById: Map<string, FileChange>,
  edges: ChangeEdge[],
): { steps: Step[]; testsFirstStepOrder: string[] } {
  const byKey = new Map<Layer, Hunk[]>();
  for (const h of hunks) {
    const key = stepKey(fileById.get(h.fileId)!.layer);
    byKey.set(key, [...(byKey.get(key) ?? []), h]);
  }

  // File dependency graph from symbol edges.
  const fileOfSymbol = new Map<string, string>();
  for (const h of hunks) for (const id of h.symbolIds) fileOfSymbol.set(id, h.fileId);
  const dependsOn = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!DEPENDENCY_TYPES.has(e.type)) continue;
    const from = fileOfSymbol.get(e.from);
    const to = fileOfSymbol.get(e.to);
    if (!from || !to || from === to) continue;
    dependsOn.set(from, (dependsOn.get(from) ?? new Set()).add(to));
  }

  const steps: Step[] = [];
  for (const key of LAYER_ORDER) {
    const stepHunks = byKey.get(key);
    if (!stepHunks) continue;
    const layers = new Set(stepHunks.map((h) => fileById.get(h.fileId)!.layer));
    const fileIds = [...new Set(stepHunks.map((h) => h.fileId))];
    const orderedFiles = orderFiles(fileIds, fileById, dependsOn);
    const position = new Map(stepHunks.map((h, i) => [h.id, i]));
    const hunkIds = orderedFiles.flatMap((fileId) =>
      stepHunks
        .filter((h) => h.fileId === fileId)
        .sort((a, b) => position.get(a.id)! - position.get(b.id)!)
        .map((h) => h.id),
    );
    steps.push({
      id: `${groupId}:${key}`,
      title: stepTitle(
        key,
        orderedFiles.map((id) => fileById.get(id)!.path),
      ),
      layer: layers.has('schema') ? 'schema' : key,
      hunkIds,
    });
  }

  const tests = steps.filter((s) => s.layer === 'test').map((s) => s.id);
  return {
    steps,
    testsFirstStepOrder: [...tests, ...steps.map((s) => s.id).filter((id) => !tests.includes(id))],
  };
}

function stepTitle(key: Layer, paths: string[]): string {
  // Named after the file only when one code file makes up the step.
  if (
    key === 'data' ||
    key === 'test' ||
    key === 'docs' ||
    key === 'config' ||
    paths.length !== 1
  ) {
    return LAYER_TITLES[key];
  }
  // One file: "src/auth/auth.controller.ts" → "Auth controller".
  const base = paths[0]!.slice(paths[0]!.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const words = base
    .split(/[.\-_]+/)
    .filter(Boolean)
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Topological order (dependencies first) with cycles condensed; ties by path. */
export function orderFiles(
  fileIds: string[],
  fileById: Map<string, FileChange>,
  dependsOn: Map<string, Set<string>>,
): string[] {
  const nodes = [...fileIds].sort((a, b) =>
    compareStrings(fileById.get(a)!.path, fileById.get(b)!.path),
  );
  const inStep = new Set(nodes);
  const deps = (n: string) => [...(dependsOn.get(n) ?? [])].filter((d) => inStep.has(d));
  return topoOrder(nodes, deps);
}

/**
 * Generic: orders `nodes` (given in tie-break order) so that `deps(n)` come before `n`.
 * Strongly connected components are kept together, members in tie-break order.
 */
export function topoOrder<T>(nodes: T[], deps: (n: T) => T[]): T[] {
  const sccs = tarjan(nodes, deps);
  const rank = new Map(nodes.map((n, i) => [n, i]));
  const sccOf = new Map<T, number>();
  sccs.forEach((c, i) => c.forEach((n) => sccOf.set(n, i)));
  const sccDeps = sccs.map(
    (c) =>
      new Set(
        c
          .flatMap((n) => deps(n).map((d) => sccOf.get(d)!))
          .filter((d) => !c.some((n) => sccOf.get(n) === d)),
      ),
  );
  const firstRank = sccs.map((c) => Math.min(...c.map((n) => rank.get(n)!)));

  const done = new Set<number>();
  const out: T[] = [];
  while (done.size < sccs.length) {
    // The earliest component whose dependencies are all placed.
    let pick = -1;
    for (let i = 0; i < sccs.length; i++) {
      if (done.has(i) || [...sccDeps[i]!].some((d) => !done.has(d))) continue;
      if (pick === -1 || firstRank[i]! < firstRank[pick]!) pick = i;
    }
    done.add(pick);
    out.push(...[...sccs[pick]!].sort((a, b) => rank.get(a)! - rank.get(b)!));
  }
  return out;
}

function tarjan<T>(nodes: T[], deps: (n: T) => T[]): T[][] {
  let index = 0;
  const idx = new Map<T, number>();
  const low = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const out: T[][] = [];
  const visit = (v: T) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of deps(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: T[] = [];
      let w: T;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out;
}
