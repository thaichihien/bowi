/**
 * Benchmark repositories: a blobless cache repository per GitHub repository (under the Bowi
 * cache folder, `bench/`), fetched like the GitHub source does: commits and trees first, then
 * only the file versions a case needs, in one batch.
 */

import { join } from 'node:path';
import { defaultCacheDir, repoCacheDir, withLock } from '@bowi/cache';
import { CO_CHANGE_COMMITS, type Snapshot } from '@bowi/core';
import {
  DIFF_FLAGS,
  ensureBareRepo,
  fetchQuiet,
  git,
  gitText,
  historyArgs,
  parseHistory,
  prefetchBlobs,
  readBlob,
} from '@bowi/sources';
import type { BenchCase } from './select.ts';

export interface BenchRepo {
  owner: string;
  repo: string;
}

/** Commits read from the main branch when selecting cases. */
export const SELECT_DEPTH = 400;

export function benchCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultCacheDir(env), 'bench');
}

export async function openBenchRepo(r: BenchRepo, cacheDir: string): Promise<string> {
  const dir = repoCacheDir(cacheDir, 'github.com', r.owner, r.repo);
  await withLock(dir, () => ensureBareRepo(dir, `https://github.com/${r.owner}/${r.repo}.git`, {}));
  return dir;
}

/** The default branch's recent first-parent history (commits and trees only). */
export async function fetchMainLine(dir: string): Promise<string> {
  const head = await gitText(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: dir });
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(head)?.[1];
  if (!branch) throw new Error(`cannot find the default branch of ${dir}`);
  await withLock(dir, () =>
    fetchQuiet(dir, {}, [
      `--depth=${SELECT_DEPTH}`,
      'origin',
      `refs/heads/${branch}:refs/bench/main`,
    ]),
  );
  return 'refs/bench/main';
}

/**
 * Makes a case runnable offline: its commits, CO_CHANGE_COMMITS commits of history before the
 * base, and every version of the files it changes.
 */
export async function prepareCase(dir: string, c: BenchCase): Promise<void> {
  const head = c.commits.at(-1)!.sha;
  await withLock(dir, async () => {
    const have = async (sha: string) =>
      (await git(['cat-file', '-e', `${sha}^{commit}`], { cwd: dir, okCodes: [1, 128] })).code ===
      0;
    const history = (await have(c.base))
      ? Number(
          await gitText(['rev-list', '--count', `--max-count=${CO_CHANGE_COMMITS}`, c.base], {
            cwd: dir,
          }),
        )
      : 0;
    if (!(await have(head)) || history < CO_CHANGE_COMMITS) {
      await fetchQuiet(dir, {}, [
        `--depth=${c.commits.length + CO_CHANGE_COMMITS + 1}`,
        'origin',
        `${head}:refs/bench/${c.id}`,
      ]);
    }
    const raw = await gitText(
      ['log', '--format=', '--raw', '--no-abbrev', '--no-renames', `${c.base}..${head}`],
      { cwd: dir },
    );
    const oids = [...raw.matchAll(/^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) /gm)].flatMap((m) => [
      m[1]!,
      m[2]!,
    ]);
    await prefetchBlobs(dir, {}, [c.base, ...c.commits.map((x) => x.sha)], oids);
  });
}

/**
 * The case squashed into one synthetic pull request: base → last commit. Its single commit
 * hides the real commit boundaries from Bowi (no `same-commit` links), which are what the
 * benchmark scores against. No blame and no grep: outside references do not affect groups.
 */
export function caseSnapshot(dir: string, repo: string, c: BenchCase): Snapshot {
  const head = c.commits.at(-1)!.sha;
  return {
    meta: {
      kind: 'local',
      repo,
      baseRef: c.base.slice(0, 7),
      headRef: c.id,
      baseSha: c.base,
      headSha: head,
      mergeBaseSha: c.base,
      commits: [
        {
          sha: head,
          subject: 'Synthetic pull request',
          author: { name: 'bench' },
          authoredAt: '2026-01-01T00:00:00Z',
          committedAt: '2026-01-01T00:00:00Z',
        },
      ],
    },
    readDiff: async () =>
      (await git(['diff', ...DIFF_FLAGS, c.base, head, '--'], { cwd: dir })).stdout,
    readFile: (version, path) => readBlob(dir, version === 'old' ? c.base : head, path),
    baseHistory: async (limit) =>
      parseHistory(await gitText(historyArgs(c.base, limit), { cwd: dir })),
  };
}
