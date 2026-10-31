/**
 * Baseline groupings a reviewer gets without Bowi (§12.3): a hunk's group from its file path.
 *
 * - one-group: GitHub's alphabetical file list, everything in one group.
 * - top-folder: by the first folder of the path (`src`, `packages`, …; root files together).
 * - folder: by the file's own folder, a stronger baseline for repositories that keep all code
 *   under one top folder.
 */

export const BASELINES = {
  'one-group': () => 'all',
  'top-folder': (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '.'),
  folder: (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'),
} satisfies Record<string, (path: string) => string>;

export type BaselineName = keyof typeof BASELINES;
export const BASELINE_NAMES = Object.keys(BASELINES) as BaselineName[];
