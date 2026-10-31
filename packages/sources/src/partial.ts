/**
 * Partial (blobless, shallow) cache repositories: create one, fetch commits and trees without
 * file contents, and download just the file contents a task needs in one batch. Used by the
 * GitHub source and the grouping benchmark.
 */

import { mkdir } from 'node:fs/promises';
import { git, gitText } from './git.ts';

export const FETCH_COMMON = [
  'fetch',
  '--quiet',
  '--no-tags',
  '--no-write-fetch-head',
  '--recurse-submodules=no',
  '--filter=blob:none',
];

/** `git fetch` without tags, submodules, FETCH_HEAD or file contents. */
export async function fetchQuiet(
  dir: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<void> {
  await git([...FETCH_COMMON, ...args], { cwd: dir, env });
}

/**
 * Downloads those of `oids` that the cache lacks, in one fetch. Missing objects are listed with
 * `rev-list --missing=print`, which never triggers git's one-object-at-a-time lazy fetching.
 */
export async function prefetchBlobs(
  dir: string,
  env: NodeJS.ProcessEnv,
  commits: string[],
  oids: string[],
): Promise<void> {
  const wanted = new Set(oids.filter((o) => !/^0+$/.test(o)));
  if (wanted.size === 0) return;
  const listed = await gitText(
    ['rev-list', '--objects', '--missing=print', '--no-walk', ...commits.filter(Boolean), '--'],
    { cwd: dir, env },
  );
  const missing = [
    ...new Set(
      listed
        .split('\n')
        .filter((l) => l.startsWith('?'))
        .map((l) => l.slice(1).trim())
        .filter((o) => wanted.has(o)),
    ),
  ];
  if (missing.length === 0) return;
  await git(['-c', 'fetch.negotiationAlgorithm=noop', ...FETCH_COMMON, '--stdin', 'origin'], {
    cwd: dir,
    env,
    input: `${missing.join('\n')}\n`,
  });
}

/** Creates a bare repository with `origin` at `url`, unless one exists at `dir`. */
export async function ensureBareRepo(
  dir: string,
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const exists =
    (
      await git(['rev-parse', '--git-dir'], { cwd: dir, env, okCodes: [128] }).catch(
        () => undefined,
      )
    )?.code === 0;
  if (exists) return;
  await mkdir(dir, { recursive: true });
  await git(['init', '--quiet', '--bare'], { cwd: dir, env });
  await git(['remote', 'add', 'origin', url], { cwd: dir, env });
}
