/**
 * Steps within a group (GRP-7, GRP-9).
 *
 * One step per layer; `schema` and `data` share one "Data shape" step. Steps are ordered so that
 * a step comes after the steps whose code it calls or uses, with the layer order only breaking
 * ties: a helper called by a service is read first even when its layer comes later. When steps
 * use each other only because a layer step holds files on both sides of another step (a router
 * used by a new module that `server.js` then calls), those steps are split along the files'
 * order, so each file still comes after what it uses; steps whose files really use each other
 * keep the layer order. Within a step, files are ordered the same way (topological order over the
 * graph's edges; cycles are condensed with Tarjan's algorithm and kept together), ties by path,
 * a migration's up file before its down file (`paths.ts`).
 * Hunks of one file stay together, in file order.
 */

import { readingOrder } from '../paths.ts';
import type { ChangeEdge, FileChange, Hunk, Layer, Step } from '../types.ts';

export const LAYER_ORDER: Layer[] = [
  'schema',
  'data',
  'util',
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
  util: 'Helpers',
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

  const hunksOfFile = new Map<string, Hunk[]>();
  for (const h of hunks) hunksOfFile.set(h.fileId, [...(hunksOfFile.get(h.fileId) ?? []), h]);
  const usedIds = new Set<string>();
  const makeStep = (key: Layer, fileIds: string[], ordered: boolean): Step => {
    const orderedFiles = ordered ? fileIds : orderFiles(fileIds, fileById, dependsOn);
    let id = `${groupId}:${key}`;
    for (let n = 2; usedIds.has(id); n++) id = `${groupId}:${key}-${n}`;
    usedIds.add(id);
    const layers = new Set(orderedFiles.map((f) => fileById.get(f)!.layer));
    return {
      id,
      title: stepTitle(
        key,
        orderedFiles.map((f) => fileById.get(f)!.path),
      ),
      layer: layers.has('schema') ? 'schema' : key,
      hunkIds: orderedFiles.flatMap((f) => hunksOfFile.get(f)!.map((h) => h.id)),
    };
  };

  let layerSteps: Step[] = [];
  for (const key of LAYER_ORDER) {
    const stepHunks = byKey.get(key);
    if (stepHunks)
      layerSteps.push(makeStep(key, [...new Set(stepHunks.map((h) => h.fileId))], false));
  }

  const fileOfHunk = new Map(hunks.map((h) => [h.id, h.fileId]));
  const filesOf = (s: Step) => [...new Set(s.hunkIds.map((id) => fileOfHunk.get(id)!))];
  const depsBetween = (list: Step[]) => {
    const stepOfFile = new Map<string, string>();
    for (const s of list) for (const f of filesOf(s)) stepOfFile.set(f, s.id);
    const stepDeps = new Map<string, Set<string>>();
    for (const [from, tos] of dependsOn) {
      const fromStep = stepOfFile.get(from);
      for (const to of tos) {
        const toStep = stepOfFile.get(to);
        if (!fromStep || !toStep || fromStep === toStep) continue;
        stepDeps.set(fromStep, (stepDeps.get(fromStep) ?? new Set()).add(toStep));
      }
    }
    return stepDeps;
  };

  // Steps that use each other: split them along their files' order when that undoes the cycle.
  const layerRank = (f: string) => LAYER_ORDER.indexOf(stepKey(fileById.get(f)!.layer));
  let stepDeps = depsBetween(layerSteps);
  for (const cycle of tarjan(
    layerSteps.map((s) => s.id),
    (id) => [...(stepDeps.get(id) ?? [])],
  )) {
    if (cycle.length < 2) continue;
    const members = layerSteps.filter((s) => cycle.includes(s.id));
    const pathOf = (f: string) => fileById.get(f)!.path;
    const memberFiles = members.flatMap(filesOf);
    const byPath = readingOrder(memberFiles.map(pathOf));
    const files = memberFiles.sort(
      (a, b) => layerRank(a) - layerRank(b) || byPath(pathOf(a), pathOf(b)),
    );
    const inCycle = new Set(files);
    const order = topoOrder(files, (f) =>
      [...(dependsOn.get(f) ?? [])].filter((d) => inCycle.has(d)),
    );
    const runs: { key: Layer; files: string[] }[] = [];
    for (const f of order) {
      const key = stepKey(fileById.get(f)!.layer);
      const last = runs.at(-1);
      if (last?.key === key) last.files.push(f);
      else runs.push({ key, files: [f] });
    }
    if (runs.length <= members.length) continue;
    for (const s of members) usedIds.delete(s.id);
    const replaced = runs.map((r) => makeStep(r.key, r.files, true));
    const at = layerSteps.findIndex((s) => cycle.includes(s.id));
    layerSteps = [
      ...layerSteps.slice(0, at).filter((s) => !cycle.includes(s.id)),
      ...replaced,
      ...layerSteps.slice(at).filter((s) => !cycle.includes(s.id)),
    ];
  }
  stepDeps = depsBetween(layerSteps);

  // Dependencies between steps (GRP-7); the layer order is the tie-break.
  const byId = new Map(layerSteps.map((s) => [s.id, s]));
  const steps = topoOrder(
    layerSteps.map((s) => s.id),
    (id) => [...(stepDeps.get(id) ?? [])],
  ).map((id) => byId.get(id)!);

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
  const pathOf = (f: string) => fileById.get(f)!.path;
  const byPath = readingOrder(fileIds.map(pathOf));
  const nodes = [...fileIds].sort((a, b) => byPath(pathOf(a), pathOf(b)));
  const inStep = new Set(nodes);
  const deps = (n: string) => [...(dependsOn.get(n) ?? [])].filter((d) => inStep.has(d));
  return topoOrder(nodes, deps);
}

/**
 * Generic: orders `nodes` (given in tie-break order) so that `deps(n)` come before `n`. Nodes are
 * taken in tie-break order, and a node's dependencies not placed yet go right before it, so a
 * node never jumps ahead only because an earlier one is waiting for its dependencies (§15 #56).
 * Strongly connected components are kept together, members in tie-break order.
 */
export function topoOrder<T>(nodes: T[], deps: (n: T) => T[]): T[] {
  const sccs = tarjan(nodes, deps);
  const rank = new Map(nodes.map((n, i) => [n, i]));
  const sccOf = new Map<T, number>();
  sccs.forEach((c, i) => c.forEach((n) => sccOf.set(n, i)));
  const firstRank = sccs.map((c) => Math.min(...c.map((n) => rank.get(n)!)));
  const byRank = (a: number, b: number) => firstRank[a]! - firstRank[b]!;
  const sccDeps = sccs.map((c, i) =>
    [...new Set(c.flatMap((n) => deps(n).map((d) => sccOf.get(d)!)))]
      .filter((d) => d !== i)
      .sort(byRank),
  );

  // The components form a DAG, so marking before recursing cannot skip a dependency.
  const placed = new Set<number>();
  const out: T[] = [];
  const place = (i: number) => {
    if (placed.has(i)) return;
    placed.add(i);
    for (const d of sccDeps[i]!) place(d);
    out.push(...[...sccs[i]!].sort((a, b) => rank.get(a)! - rank.get(b)!));
  };
  for (const i of sccs.map((_, i) => i).sort(byRank)) place(i);
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
