/**
 * Review progress kept in the browser (UI-12): reviewed steps and viewed files, so a reload or a
 * second look at the same report picks up where the reviewer stopped.
 *
 * Entries are keyed by repository, PR (or branch) and a digest of the diff, so progress never
 * carries over to code that changed since. Each entry records when it was last saved; opening any
 * report deletes entries older than a week (owner's request: keep disk use bounded). Storage can
 * be missing or throw (private windows, blocked site data), so every access is guarded and the
 * page works without it.
 */

import type { ReviewPlan } from '@bowi/core/types';

export interface Progress {
  /** Step IDs marked reviewed. */
  reviewed: Set<string>;
  /** `viewedKey(stepId, fileId)` of files marked viewed, per step. */
  viewed: Set<string>;
  /** Steps marked reviewed because all their files were viewed (unviewing one unmarks them). */
  auto: Set<string>;
}

interface Stored {
  savedAt: number;
  reviewed: string[];
  viewed: string[];
  auto: string[];
}

export const PROGRESS_PREFIX = 'bowi:progress:';
export const PROGRESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const emptyProgress = (): Progress => ({
  reviewed: new Set(),
  viewed: new Set(),
  auto: new Set(),
});

export const viewedKey = (stepId: string, fileId: string) => `${stepId} ${fileId}`;

/** Marks or unmarks a step by hand; a hand-made choice is never undone by the Viewed rule. */
export function markStep(p: Progress, stepId: string, on: boolean): Progress {
  const reviewed = new Set(p.reviewed);
  const auto = new Set(p.auto);
  if (on) reviewed.add(stepId);
  else reviewed.delete(stepId);
  auto.delete(stepId);
  return { reviewed, viewed: p.viewed, auto };
}

/**
 * Toggles a file of a step as viewed (UI-23). Viewing the step's last file marks the step
 * reviewed; unviewing a file unmarks a step only if that rule had marked it.
 */
export function toggleViewed(
  p: Progress,
  stepId: string,
  fileId: string,
  stepFiles: string[],
): Progress {
  const viewed = new Set(p.viewed);
  const key = viewedKey(stepId, fileId);
  if (viewed.has(key)) viewed.delete(key);
  else viewed.add(key);
  const reviewed = new Set(p.reviewed);
  const auto = new Set(p.auto);
  const all = stepFiles.length > 0 && stepFiles.every((f) => viewed.has(viewedKey(stepId, f)));
  if (all && !reviewed.has(stepId)) {
    reviewed.add(stepId);
    auto.add(stepId);
  } else if (!all && auto.has(stepId)) {
    reviewed.delete(stepId);
    auto.delete(stepId);
  }
  return { reviewed, viewed, auto };
}

/** Storage key of a report: same repository, PR or branch, and diff → same progress. */
export function progressKey(plan: ReviewPlan): string {
  const s = plan.source;
  const target = s.kind === 'github' ? `#${s.prNumber}` : `@${s.headRef}`;
  return `${PROGRESS_PREFIX}${s.repo}${target}:${diffDigest(plan)}`;
}

/** FNV-1a over every file path and diff line: a cheap fingerprint, not a security measure. */
export function diffDigest(plan: ReviewPlan): string {
  let h = 0x811c9dc5;
  const add = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193);
  };
  for (const f of plan.files) add(`${f.status} ${f.oldPath ?? ''} ${f.path}`);
  for (const hunk of plan.hunks) {
    add(hunk.id);
    for (const l of hunk.lines) add(l.kind[0]! + l.text);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function storage(): Storage | undefined {
  try {
    return window.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Deletes Bowi progress entries not saved for a week, and unreadable ones. */
export function pruneProgress(now: number): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PROGRESS_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const entry = parse(store.getItem(key));
      if (!entry || now - entry.savedAt > PROGRESS_TTL_MS) store.removeItem(key);
    }
  } catch {
    // Storage blocked mid-way: nothing to clean up now.
  }
}

export function loadProgress(key: string, now: number): Progress {
  pruneProgress(now);
  const store = storage();
  if (!store) return emptyProgress();
  try {
    const entry = parse(store.getItem(key));
    if (!entry) return emptyProgress();
    return {
      reviewed: new Set(entry.reviewed),
      viewed: new Set(entry.viewed),
      auto: new Set(entry.auto),
    };
  } catch {
    return emptyProgress();
  }
}

/** Saves progress; no progress at all removes the entry. */
export function saveProgress(key: string, progress: Progress, now: number): void {
  const store = storage();
  if (!store) return;
  try {
    if (progress.reviewed.size === 0 && progress.viewed.size === 0) {
      store.removeItem(key);
      return;
    }
    const entry: Stored = {
      savedAt: now,
      reviewed: [...progress.reviewed],
      viewed: [...progress.viewed],
      auto: [...progress.auto],
    };
    store.setItem(key, JSON.stringify(entry));
  } catch {
    // Full or blocked storage: progress lasts until the page closes.
  }
}

function parse(raw: string | null): Stored | undefined {
  if (raw === null) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    const list = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
    if (typeof v.savedAt !== 'number' || !list(v.reviewed) || !list(v.viewed) || !list(v.auto))
      return undefined;
    return v as Stored;
  } catch {
    return undefined;
  }
}
