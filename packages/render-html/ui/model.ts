/**
 * View model: lookups and reading order derived from the plan. Pure; no DOM.
 */

import { readingOrder } from '@bowi/core/paths';
import type {
  ChangedSymbol,
  DiffLine,
  FileChange,
  Group,
  Hunk,
  ReviewPlan,
  Step,
} from '@bowi/core/types';

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

/** File cards with more changed lines than this start closed (Review and Changes tabs). */
export const LARGE_FILE_LINES = 300;

const AI_PROVIDERS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  'openai-compatible': 'OpenAI-compatible API',
};

/** Credit for AI-written text: "Written by claude-sonnet-5-5 · low effort · via Claude Code". */
export function writtenBy(ai: ReviewPlan['meta']['ai']): string {
  const provider = ai.provider && (AI_PROVIDERS[ai.provider] ?? ai.provider);
  return [
    `Written by ${ai.model ?? 'AI'}`,
    ai.effort && `${ai.effort} effort`,
    provider && `via ${provider}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Icon of a step in the sidebar: its layer, or what kind of noise or move it holds. */
export type StepIcon =
  | 'data'
  | 'util'
  | 'domain'
  | 'service'
  | 'api'
  | 'ui'
  | 'config'
  | 'test'
  | 'docs'
  | 'file'
  | 'move'
  | 'generated'
  | 'format';

const LAYER_ICONS: Record<Step['layer'], StepIcon> = {
  schema: 'data',
  data: 'data',
  util: 'util',
  domain: 'domain',
  service: 'service',
  api: 'api',
  ui: 'ui',
  config: 'config',
  test: 'test',
  docs: 'docs',
  unknown: 'file',
};

export class Model {
  readonly plan: ReviewPlan;
  readonly files = new Map<string, FileChange>();
  readonly hunks = new Map<string, Hunk>();
  readonly symbols = new Map<string, ChangedSymbol>();
  private readonly byFile = new Map<string, Hunk[]>();

  constructor(plan: ReviewPlan) {
    this.plan = plan;
    for (const f of plan.files) this.files.set(f.id, f);
    for (const h of plan.hunks) {
      this.hunks.set(h.id, h);
      this.byFile.set(h.fileId, [...(this.byFile.get(h.fileId) ?? []), h]);
    }
    for (const s of plan.symbols) this.symbols.set(s.id, s);
  }

  /** A file's hunks in file order. */
  hunksOfFile(fileId: string): Hunk[] {
    return this.byFile.get(fileId) ?? [];
  }

  stepIcon(group: Group, step: Step): StepIcon {
    if (group.kind === 'move') return 'move';
    const hunks = this.hunksOf(step);
    if (hunks.length && hunks.every((h) => h.kind !== 'logic')) {
      const kind = hunks[0]!.kind;
      return kind === 'format' ? 'format' : kind === 'move' ? 'move' : 'generated';
    }
    return LAYER_ICONS[step.layer];
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

  /**
   * Files of a step shown as diffs in the Review tab, which can be marked viewed. Moved code and
   * collapsed noise have no file cards, so their steps have none.
   */
  viewableFiles(group: Group, step: Step): string[] {
    if (group.kind === 'move' || this.hunksOf(step).every((h) => h.kind !== 'logic')) return [];
    return [...new Set(this.fileBlocks(step).map((b) => b.file.id))];
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

/**
 * A long name cut in the middle, so its start and its extension stay visible: `a` shrinks with
 * an ellipsis and `b` (the end) is always shown. A path keeps its whole file name when that is
 * short; a bare name keeps its last characters ("1730_add_e…rified.ts").
 */
export function midSplit(text: string): { a: string; b: string } {
  const slash = text.lastIndexOf('/');
  const name = text.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.length - dot : 0;
  const keep = Math.min(
    text.length,
    slash >= 0 && name.length <= 24 ? name.length : Math.max(8, ext + 6),
  );
  return { a: text.slice(0, text.length - keep), b: text.slice(text.length - keep) };
}

/** One stop of the focus tour (M20): a file, at the first step that has it. */
export interface TourStop {
  file: FileChange;
  /** None for a file without a diff (a rename, a binary file), which is in no step. */
  step?: FlatStep;
  /** The step's place in the reading order. */
  position: number;
}

/**
 * Every file once, in reading order: step by step, each file at the first step it belongs to.
 * Files without a diff are in no step; they come last, in GitHub's order, so the tour covers the
 * whole pull request.
 */
export function tourStops(model: Model, flat: FlatStep[]): TourStop[] {
  const seen = new Set<string>();
  const stops: TourStop[] = [];
  flat.forEach((step, position) => {
    for (const { file } of model.fileBlocks(step.step)) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      stops.push({ file, step, position });
    }
  });
  for (const file of githubOrder(model.plan.files)) {
    if (!seen.has(file.id)) stops.push({ file, position: flat.length });
  }
  return stops;
}

/**
 * The steps the tour finishes at each stop: a step is gone through once the tour has passed its
 * last file, so going on from that stop marks it reviewed.
 */
export function tourFinishes(model: Model, flat: FlatStep[], stops: TourStop[]): FlatStep[][] {
  const at = new Map(stops.map((s, i) => [s.file.id, i]));
  const finishes: FlatStep[][] = stops.map(() => []);
  for (const f of flat) {
    const last = Math.max(...model.fileBlocks(f.step).map((b) => at.get(b.file.id) ?? -1));
    if (last >= 0) finishes[last]!.push(f);
  }
  return finishes;
}

/** A step or group title without its code marks, for labels. */
export const plainTitle = (title: string) => title.replace(/`/g, '');

/** Rule-based description of a group when there is no AI intent (the Review tab's group card). */
export function describeGroup(model: Model, group: Group): string {
  if (group.kind === 'noise') {
    return 'Changes you usually do not need to read line by line. They are collapsed here, never removed: every step can show its raw diff.';
  }
  if (group.kind === 'move') {
    return 'Code moved between places. Lines that changed during the move are highlighted; everything else is identical.';
  }
  const named = model.groupSymbols(group).filter((s) => s.kind !== 'file');
  const count = (c: string) => named.filter((s) => s.change === c).length;
  const parts = [
    [count('added'), 'new'],
    [count('signature') + count('renamed'), 'with a changed signature or name'],
    [count('body'), 'changed inside'],
    [count('deleted'), 'removed'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`);
  const files = model.groupFiles(group).size;
  return parts.length
    ? `Symbols: ${parts.join(', ')}; across ${files} file${files === 1 ? '' : 's'}.`
    : `Changes across ${files} file${files === 1 ? '' : 's'} without parsed symbols.`;
}

/**
 * The focus tour's sentence about a group: the group card's for code, what moved where for moved
 * code, and a short one for noise.
 */
export function tourNote(model: Model, group: Group): string {
  if (group.intent) return group.intent;
  if (group.kind === 'noise') return 'Changes you usually do not need to read line by line.';
  if (group.kind !== 'move') return describeGroup(model, group);
  const moves = group.steps.flatMap((step) => {
    const to = model.hunksOf(step).find((h) => h.move && h.newLines > 0);
    if (!to?.move) return [];
    const from = baseName(model.files.get(to.move.fromFileId)?.path ?? '');
    const here = baseName(model.files.get(to.fileId)!.path);
    const changed = to.move.changedLineIndexes.length;
    const where = from === here ? `within ${here}` : `from ${from} to ${here}`;
    const how = changed
      ? `, with ${changed} line${changed === 1 ? '' : 's'} changed on the way`
      : ', unchanged';
    return [`${model.stepSubtitle(step)} moves ${where}${how}`];
  });
  return moves.length ? `${moves.join('; ')}.` : describeGroup(model, group);
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

/** Added plus deleted lines. */
export function changedLines(hunks: Hunk[]): number {
  return hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind !== 'context').length, 0);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** GitHub's file order: at every folder level, subfolders come before files, then by name. */
export function comparePaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; ; i++) {
    const aDir = i < as.length - 1;
    const bDir = i < bs.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    if (as[i] !== bs[i] || !aDir) return compare(as[i] ?? '', bs[i] ?? '');
  }
}

/** GitHub's file order, except that a migration's up file comes right before its down file. */
export function githubOrder<T extends { path: string }>(files: readonly T[]): T[] {
  const byPath = readingOrder(
    files.map((f) => f.path),
    comparePaths,
  );
  return [...files].sort((a, b) => byPath(a.path, b.path));
}

/** GitHub's five squares next to "+12 −3": green for additions, red for deletions. */
export function diffBlocks(additions: number, deletions: number): ('add' | 'del' | 'none')[] {
  const total = additions + deletions;
  const blocks: ('add' | 'del' | 'none')[] = [];
  if (total === 0) return ['none', 'none', 'none', 'none', 'none'];
  const scale = total < 5 ? 1 : 5 / total;
  let add = Math.round(additions * scale);
  let del = Math.round(deletions * scale);
  if (additions > 0 && add === 0) add = 1;
  if (deletions > 0 && del === 0) del = 1;
  while (add + del > 5) {
    if (add >= del) add--;
    else del--;
  }
  for (let i = 0; i < 5; i++) blocks.push(i < add ? 'add' : i < add + del ? 'del' : 'none');
  return blocks;
}

/** One row of the split layout: the old line on the left, the new one on the right. */
export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
  /** Indexes of `left` and `right` in the hunk's lines (comments are anchored by them). */
  leftIndex?: number;
  rightIndex?: number;
}

/**
 * Pairs a hunk's lines for the split layout: context on both sides; a run of deletions is
 * matched line by line with the additions that follow it, the shorter side left empty.
 */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line, leftIndex: i, rightIndex: i });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (lines[i]?.kind === 'del') dels.push(i++);
    while (lines[i]?.kind === 'add') adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const row: SplitRow = {};
      if (dels[k] !== undefined) Object.assign(row, { left: lines[dels[k]!], leftIndex: dels[k] });
      if (adds[k] !== undefined)
        Object.assign(row, { right: lines[adds[k]!], rightIndex: adds[k] });
      rows.push(row);
    }
  }
  return rows;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "2 days ago", "yesterday", "just now"; computed when the page is viewed, never stored. */
export function relativeTime(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds)) return '';
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** "Jan 5, 2026, 10:00 AM GMT+7" in the viewer's time zone (or `timeZone`). */
export function formatTimestamp(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const options = { dateStyle: 'medium', timeStyle: 'short', ...(timeZone && { timeZone }) };
  const text = new Intl.DateTimeFormat('en-US', options as Intl.DateTimeFormatOptions).format(date);
  return `${text} ${timeZoneName(date, timeZone)}`;
}

function timeZoneName(date: Date, timeZone?: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', ...(timeZone && { timeZone }) })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

/** "Jan 5, 2026": the day a commit belongs to, in the viewer's time zone (or `timeZone`). */
export function dayLabel(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    ...(timeZone && { timeZone }),
  }).format(date);
}

/** "Bowi Fixtures" → "BF", "octocat" → "O". */
export function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0]?.[0] ?? '?')).toUpperCase();
}
