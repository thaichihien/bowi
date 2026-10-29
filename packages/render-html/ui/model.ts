/**
 * View model: lookups and reading order derived from the plan. Pure; no DOM.
 */

import type { ChangedSymbol, FileChange, Group, Hunk, ReviewPlan, Step } from '@bowi/core/types';

export type ReadingMode = 'dependency' | 'tests-first';

export interface FlatStep {
  groupIndex: number;
  step: Step;
}

export const KIND_LABELS: Record<Group['kind'], string> = {
  feature: 'Feature',
  refactor: 'Refactor',
  move: 'Moved code',
  fix: 'Fix',
  test: 'Tests',
  config: 'Config',
  docs: 'Docs',
  noise: 'Noise',
  mixed: 'Mixed',
};

export class Model {
  readonly plan: ReviewPlan;
  readonly files = new Map<string, FileChange>();
  readonly hunks = new Map<string, Hunk>();
  readonly symbols = new Map<string, ChangedSymbol>();

  constructor(plan: ReviewPlan) {
    this.plan = plan;
    for (const f of plan.files) this.files.set(f.id, f);
    for (const h of plan.hunks) this.hunks.set(h.id, h);
    for (const s of plan.symbols) this.symbols.set(s.id, s);
  }

  stepsOf(group: Group, mode: ReadingMode): Step[] {
    if (mode === 'dependency') return group.steps;
    const byId = new Map(group.steps.map((s) => [s.id, s]));
    return group.testsFirstStepOrder.map((id) => byId.get(id)!).filter(Boolean);
  }

  flat(mode: ReadingMode): FlatStep[] {
    return this.plan.groups.flatMap((g, groupIndex) =>
      this.stepsOf(g, mode).map((step) => ({ groupIndex, step })),
    );
  }

  hunksOf(step: Step): Hunk[] {
    return step.hunkIds.map((id) => this.hunks.get(id)!);
  }

  /** Consecutive hunks of the same file, in step order. */
  fileBlocks(step: Step): { file: FileChange; hunks: Hunk[] }[] {
    const blocks: { file: FileChange; hunks: Hunk[] }[] = [];
    for (const h of this.hunksOf(step)) {
      const last = blocks.at(-1);
      if (last && last.file.id === h.fileId) last.hunks.push(h);
      else blocks.push({ file: this.files.get(h.fileId)!, hunks: [h] });
    }
    return blocks;
  }

  groupFiles(group: Group): Set<string> {
    return new Set(group.steps.flatMap((s) => s.hunkIds.map((id) => this.hunks.get(id)!.fileId)));
  }

  groupSymbols(group: Group): ChangedSymbol[] {
    const ids = new Set(
      group.steps.flatMap((s) => s.hunkIds.flatMap((id) => this.hunks.get(id)!.symbolIds)),
    );
    return [...ids].map((id) => this.symbols.get(id)!).filter(Boolean);
  }

  /** "register() and verifyEmail()", or file names for steps without named symbols. */
  stepSubtitle(step: Step): string {
    const names = [...new Set(this.hunksOf(step).flatMap((h) => h.symbolIds))]
      .map((id) => this.symbols.get(id))
      .filter((s): s is ChangedSymbol => !!s && s.kind !== 'file')
      .map(displayName);
    const items = names.length
      ? names
      : [...new Set(this.hunksOf(step).map((h) => baseName(this.files.get(h.fileId)!.path)))];
    if (items.length <= 2) return items.join(' and ');
    return `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`;
  }

  /** Summary lines of a noise group that concern `path` ("path: text" → "text"). */
  summaryFor(group: Group, path: string): string[] {
    const prefix = `${path}: `;
    return (group.summary ?? '')
      .split('\n')
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length));
  }
}

export function displayName(s: ChangedSymbol): string {
  if ((s.kind === 'function' || s.kind === 'method') && !s.name.endsWith(')')) return `${s.name}()`;
  if (s.kind === 'file') return baseName(s.qualifiedName);
  return s.name;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const CHANGE_LABELS: Record<ChangedSymbol['change'], string> = {
  added: 'new',
  deleted: 'removed',
  signature: 'signature changed',
  body: 'body changed',
  renamed: 'renamed',
  moved: 'moved',
};
const CHANGE_RANK: ChangedSymbol['change'][] = [
  'signature',
  'renamed',
  'added',
  'deleted',
  'moved',
  'body',
];

/** Tag for a file in a step: file status first, then the most notable symbol change. */
export function fileTag(file: FileChange, symbols: ChangedSymbol[]): string | undefined {
  if (file.status === 'added') return 'New file';
  if (file.status === 'deleted') return 'Deleted file';
  if (file.status === 'renamed') return `Renamed from ${file.oldPath}`;
  const named = symbols.filter((s) => s.kind !== 'file');
  const top = CHANGE_RANK.find((c) => named.some((s) => s.change === c));
  return top ? CHANGE_LABELS[top] : undefined;
}

export function changeLabel(s: ChangedSymbol): string {
  return CHANGE_LABELS[s.change];
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
