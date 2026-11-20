/**
 * Rule-based description of a logic group (GRP-5, GRP-6, GRP-10, GRP-11): reasons, confidence,
 * title and kind. No AI involved.
 */

import { compareStrings } from '../determinism.ts';
import { show } from '../stages/graph.ts';
import type { ChangedSymbol, ChangeEdge, Group, Hunk, ReviewPlan } from '../types.ts';
import type { Cluster } from './cluster.ts';

const MAX_REASONS = 6;
/** Edges into one symbol from this many symbols are summarized in one reason. */
const FAN_IN_SUMMARY = 3;
const REASON_TYPES: ChangeEdge['type'][] = [
  'calls',
  'uses-type',
  'tests',
  'framework',
  'docs-mentions',
  'shared-literal',
];
const STRUCTURAL = new Set<ChangeEdge['type']>(['calls', 'uses-type', 'tests', 'framework']);

export interface GroupFacts {
  cluster: Cluster;
  symbols: ChangedSymbol[];
  hunks: Hunk[];
  /** Edges with both ends in the group. */
  edges: ChangeEdge[];
  threshold: number;
  /** Layers of the group's files; a file that only has comment edits here counts as docs. */
  fileLayers: Set<string>;
  /** Logic hunks that change only comment text. */
  commentOnly?: Set<string>;
}

/** The strongest edges as sentences: the best edge of each type first, then by weight. */
export function reasonsFor(f: GroupFacts, fileOf: (fileId: string) => string): string[] {
  const ranked = [...f.edges]
    .filter((e) => e.type !== 'same-symbol')
    .sort(
      (a, b) => b.weight - a.weight || REASON_TYPES.indexOf(a.type) - REASON_TYPES.indexOf(b.type),
    );
  // One reason per pair of symbols: a framework edge and a shared literal often say the same
  // thing about an entity and its migration.
  const pairKey = (e: ChangeEdge) => [e.from, e.to].sort(compareStrings).join('\u0000');
  const pairs = new Set<string>();
  const picked: ChangeEdge[] = [];
  const pick = (e: ChangeEdge) => {
    if (picked.includes(e) || pairs.has(pairKey(e))) return;
    picked.push(e);
    pairs.add(pairKey(e));
  };
  for (const type of REASON_TYPES) {
    const best = ranked.find((e) => e.type === type && !pairs.has(pairKey(e)));
    if (best) pick(best);
  }
  for (const e of ranked) {
    if (picked.length >= MAX_REASONS) break;
    pick(e);
  }
  const byId = new Map(f.symbols.map((s) => [s.id, s]));

  // Many edges of one type into one symbol read better as one sentence:
  // "`Logger.log()` is called by 20 changed symbols, e.g. `Module01Service.run01()`".
  const fanIn = new Map<string, ChangeEdge[]>();
  for (const e of ranked) {
    if (e.type === 'shared-literal' || e.type === 'docs-mentions') continue;
    const key = `${e.type}\u0000${e.to}`;
    fanIn.set(key, [...(fanIn.get(key) ?? []), e]);
  }
  const summarized = new Set<ChangeEdge>();
  const reasons: string[] = [];
  for (const e of picked) {
    if (reasons.length >= MAX_REASONS) break;
    if (summarized.has(e)) continue;
    const same = fanIn.get(`${e.type}\u0000${e.to}`) ?? [];
    if (same.length >= FAN_IN_SUMMARY) {
      same.forEach((x) => summarized.add(x));
      const verb =
        e.type === 'calls' ? 'is called by' : e.type === 'tests' ? 'is tested by' : 'is used by';
      reasons.push(
        `${show(byId.get(e.to)!)} ${verb} ${same.length} changed symbols, e.g. ${show(byId.get(same[0]!.from)!)}`,
      );
      continue;
    }
    reasons.push(e.evidence.text);
  }
  for (const e of ranked) {
    if (reasons.length >= MAX_REASONS) break;
    if (!summarized.has(e) && !picked.includes(e) && !pairs.has(pairKey(e))) {
      reasons.push(e.evidence.text);
      pairs.add(pairKey(e));
    }
  }

  for (const a of f.cluster.attached) {
    if (a.how !== 'directory' || reasons.length >= MAX_REASONS + 2) continue;
    const s = byId.get(a.symbolIds[0]!)!;
    const path = fileOf(s.fileId);
    reasons.push(
      `${show(s)} has no detected link; it is in the same folder as other changes here (${path.slice(0, path.lastIndexOf('/') + 1) || './'})`,
    );
  }
  if (f.cluster.origin === 'other')
    reasons.push('No relation to other changes was detected; listed by path.');
  return reasons;
}

export function confidenceFor(f: GroupFacts): Group['confidence'] {
  if (f.cluster.origin === 'other') return f.symbols.length <= 1 ? 'high' : 'low';
  // Linked only through down-weighted (hub) edges: related, but less certain.
  if (f.cluster.origin === 'weak') return 'medium';
  const strong = f.edges.filter((e) => e.weight >= f.threshold && e.type !== 'same-symbol');
  const mean = strong.length ? strong.reduce((n, e) => n + e.weight, 0) / strong.length : 0;
  const byFolder = f.cluster.attached.some((a) => a.how === 'directory');
  return mean >= 0.7 && !byFolder ? 'high' : 'medium';
}

export function kindFor(f: GroupFacts): Group['kind'] {
  const layers = f.fileLayers;
  if (layers.size === 1) {
    const [only] = layers;
    if (only === 'test' || only === 'docs' || only === 'config') return only;
  }
  // Tests with the docs that describe them are still tests.
  if (layers.size === 2 && layers.has('test') && layers.has('docs')) return 'test';
  const named = f.symbols.filter((s) => s.kind !== 'file');
  if (named.length === 0) return 'mixed';
  const count = (...changes: ChangedSymbol['change'][]) =>
    named.filter((s) => changes.includes(s.change)).length;
  if (count('added') / named.length >= 0.5) return 'feature';
  if (count('renamed', 'signature', 'moved') / named.length >= 0.5) return 'refactor';
  // A signature change or rename plus the call sites that follow it.
  const changedApi = new Set(
    named.filter((s) => s.change === 'signature' || s.change === 'renamed').map((s) => s.id),
  );
  const followers = named.filter((s) => !changedApi.has(s.id));
  if (
    changedApi.size > 0 &&
    followers.every(
      (s) =>
        s.change === 'body' &&
        f.edges.some((e) => e.from === s.id && changedApi.has(e.to) && STRUCTURAL.has(e.type)),
    )
  ) {
    return 'refactor';
  }
  const changedLines = f.hunks.reduce(
    (n, h) => n + h.lines.filter((l) => l.kind !== 'context').length,
    0,
  );
  if (count('body', 'deleted') === named.length && changedLines <= 30) return 'fix';
  return 'mixed';
}

/**
 * Title from the new or changed code symbol that best names the group, e.g.
 * "New `AuthService.verifyEmail()` and 9 related changes": code over doc-comment edits, then a
 * symbol used from another file of the group (what the rest calls, not a private helper), then
 * the most connected. A group of tests (and the docs about them) is named after its test files,
 * since a test's name or a helper in it says little about what is tested.
 */
export function ruleTitle(f: GroupFacts, fileOf: (fileId: string) => string): string {
  if (f.cluster.origin === 'other' && f.symbols.length > 1) return 'Other changes';
  const named = f.symbols.filter((s) => s.kind !== 'file');
  // Code names the change best: not tests, and not the docs sections describing it.
  const candidates = named.filter(
    (s) => s.kind !== 'section' && s.layer !== 'test' && s.layer !== 'docs',
  );
  const tests = f.symbols.filter((s) => s.layer === 'test');
  if (candidates.length === 0 && tests.length > 0) {
    const paths = [...new Set(tests.map((s) => fileOf(s.fileId)))].sort(compareStrings);
    const others = named.filter((s) => s.layer !== 'test').length;
    const what = paths.length === 1 ? `Tests in \`${paths[0]}\`` : `Tests in ${paths.length} files`;
    return `${what}${others ? ` and ${others} related change${others === 1 ? '' : 's'}` : ''}`;
  }
  const pool = candidates.length ? candidates : named;
  if (pool.length === 0) {
    const paths = [...new Set(f.symbols.map((s) => fileOf(s.fileId)))];
    return paths.length === 1 ? `Changes in \`${paths[0]}\`` : `Changes in ${paths.length} files`;
  }
  const byId = new Map(f.symbols.map((s) => [s.id, s]));
  const degree = new Map<string, number>();
  const usedElsewhere = new Set<string>();
  for (const e of f.edges) {
    if (!STRUCTURAL.has(e.type)) continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.weight);
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.weight);
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from && to && from.fileId !== to.fileId && from.layer !== 'test') usedElsewhere.add(to.id);
  }
  const commentOnly = f.commentOnly ?? new Set<string>();
  const docsOnly = (s: ChangedSymbol) =>
    s.hunkIds.length > 0 && s.hunkIds.every((id) => commentOnly.has(id));
  const preference: Record<ChangedSymbol['change'], number> = {
    added: 0,
    signature: 1,
    renamed: 2,
    body: 3,
    moved: 4,
    deleted: 5,
  };
  const main = [...pool].sort(
    (a, b) =>
      Number(docsOnly(a)) - Number(docsOnly(b)) ||
      Number(usedElsewhere.has(b.id)) - Number(usedElsewhere.has(a.id)) ||
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      preference[a.change] - preference[b.change],
  )[0]!;
  const verb: Record<ChangedSymbol['change'], string> = {
    added: 'New',
    signature: 'Changed signature of',
    renamed: 'Renamed',
    body: 'Changes to',
    moved: 'Moved',
    deleted: 'Removed',
  };
  const others = f.symbols.filter((s) => s.kind !== 'file' && s.id !== main.id).length;
  const how = docsOnly(main) && main.change === 'body' ? 'Docs of' : verb[main.change];
  return `${how} ${show(main)}${others ? ` and ${others} related change${others === 1 ? '' : 's'}` : ''}`;
}

/** PR title for a lone logic group, or the commit subject when the PR has one commit. */
export function sourceTitle(source: ReviewPlan['source'], logicGroups: number): string | undefined {
  if (logicGroups !== 1) return undefined;
  if (source.title) return source.title;
  if (source.commits.length === 1) return source.commits[0]!.subject;
  return undefined;
}
