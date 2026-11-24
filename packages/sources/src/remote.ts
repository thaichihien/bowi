/**
 * The git side of a hosted pull or merge request (SRC-4..7), shared by GitHub and GitLab: a bare,
 * blobless, shallow cache repository per hosted repository, the PR's head and merge base fetched
 * by SHA, and history and search fetched only when asked, in batches.
 *
 * - Code comes from git, never from the host's diff API (it truncates large diffs, SRC-5). `git
 *   diff` downloads only the blobs it needs, and a later run of the same PR fetches nothing.
 * - A token reaches git through environment config, never the command line, so other processes
 *   cannot see it.
 * - Blame deepens the head by the PR's commits, base history deepens the merge base to the commits
 *   it needs (commits and trees, no blobs), and grep downloads the head's source files in one fetch
 *   (never one round trip per file).
 */

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock } from '@bowi/cache';
import { SourceError, type FileVersion, type Snapshot, type SnapshotMeta } from '@bowi/core';
import { DIFF_FLAGS, git, GitError, gitText, readBlob } from './git.ts';
import { ensureBareRepo, fetchQuiet, prefetchBlobs } from './partial.ts';
import {
  BLAME_CONFIG,
  grepArgs,
  historyArgs,
  parseBlame,
  parseGrep,
  parseHistory,
} from './history.ts';

/** Source files grep downloads at most; a larger repository gets no outside references. */
export const MAX_GREP_FILES = 10_000;

export interface RemoteSnapshot extends Snapshot {
  /** True when both commits were already in the cache and nothing was downloaded. */
  fromCache: boolean;
}

export interface RemoteRequest {
  /** The cache repository and its `origin`. */
  dir: string;
  url: string;
  /** Credentials for git (`authEnv`), also for the lazy blob downloads of `git diff`. */
  env: NodeJS.ProcessEnv;
  meta: SnapshotMeta;
  /** Commits in the PR, also those the host did not list. */
  totalCommits: number;
  /**
   * Refs to fetch when the server refuses to fetch by SHA: the PR's head (`refs/pull/<n>/head`,
   * `refs/merge-requests/<n>/head`) and its base branch.
   */
  headRef: string;
  /** Says which repository and what to do when git cannot fetch. */
  fetchError: (e: GitError) => SourceError;
}

export async function openRemoteSnapshot(request: RemoteRequest): Promise<RemoteSnapshot> {
  const { dir, env, meta } = request;
  const { headSha, mergeBaseSha } = meta;

  const fromCache = await withLock(dir, async () => {
    await ensureBareRepo(dir, request.url, env);
    // Not `cat-file -e`: in a partial clone it downloads a missing commit, with its history, from
    // the remote. rev-list with --missing never fetches: `?<sha>` for a missing commit (git
    // before 2.45 stops with an error instead).
    const have = async (sha: string) => {
      const r = await git(['rev-list', '--missing=print', '--no-walk', sha, '--'], {
        cwd: dir,
        env,
        okCodes: [128],
      });
      return r.code === 0 && r.stdout.trim() === sha;
    };
    if ((await have(headSha)) && (await have(mergeBaseSha))) return true;
    await fetchCommits(request);
    return false;
  });

  const diff = (await git(['diff', ...DIFF_FLAGS, mergeBaseSha, headSha, '--'], { cwd: dir, env }))
    .stdout;
  const range = `${mergeBaseSha}..${headSha}`;
  return {
    meta,
    fromCache,
    readDiff: async () => diff,
    readFile: (version: FileVersion, path: string) =>
      readBlob(dir, version === 'old' ? mergeBaseSha : headSha, path, env),

    async blame(paths) {
      const out = new Map<string, (string | null)[]>();
      if (paths.length === 0) return out;
      await withLock(dir, async () => {
        // Every PR commit, and the parent of the oldest, so no PR commit is a shallow boundary.
        const have = Number(await gitText(['rev-list', '--count', range], { cwd: dir, env }));
        if (have < meta.commits.length) {
          await fetchQuiet(dir, env, [`--depth=${request.totalCommits + 1}`, 'origin', headSha]);
        }
        // Each version of these files in the PR's commits, merge base included.
        const raw = await gitText(
          ['log', '--format=', '--raw', '--no-abbrev', '--no-renames', range, '--', ...paths],
          { cwd: dir, env },
        );
        const oids = [...raw.matchAll(/^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) /gm)].flatMap(
          (m) => [m[1]!, m[2]!],
        );
        const commits = (await gitText(['rev-list', range], { cwd: dir, env })).split('\n');
        await prefetchBlobs(dir, env, [...commits, mergeBaseSha], oids);
      });
      for (const path of paths) {
        const r = await git([...BLAME_CONFIG, 'blame', '--porcelain', range, '--', path], {
          cwd: dir,
          env,
          okCodes: [128],
        });
        if (r.code === 0) out.set(path, parseBlame(r.stdout));
      }
      return out;
    },

    async baseHistory(limit) {
      await withLock(dir, async () => {
        const marker = join(dir, 'bowi-history');
        const done = await readFile(marker, 'utf8').catch(() => '');
        if (done.split('\n').includes(`${mergeBaseSha} ${limit}`)) return;
        const have = Number(
          await gitText(['rev-list', '--count', `--max-count=${limit}`, mergeBaseSha], {
            cwd: dir,
            env,
          }),
        );
        if (have < limit) {
          await fetchQuiet(dir, env, [`--depth=${limit}`, 'origin', mergeBaseSha]);
        }
        await appendFile(marker, `${mergeBaseSha} ${limit}\n`);
      });
      return parseHistory(await gitText(historyArgs(mergeBaseSha, limit), { cwd: dir, env }));
    },

    async grep(words, extensions) {
      if (words.length === 0) return [];
      const listing = (
        await git(['ls-tree', '-r', '-z', '--full-tree', headSha], { cwd: dir, env })
      ).stdout;
      const oids: string[] = [];
      for (const entry of listing.split('\0')) {
        const m = /^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
        if (!m || /(^|\/)node_modules\//.test(m[2]!)) continue;
        if (extensions.some((e) => m[2]!.endsWith(e))) oids.push(m[1]!);
      }
      if (oids.length > MAX_GREP_FILES) {
        throw new Error(
          `the repository has ${oids.length} source files, more than the ${MAX_GREP_FILES} Bowi downloads to search`,
        );
      }
      await withLock(dir, () => prefetchBlobs(dir, env, [headSha], oids));
      const r = await git(grepArgs(words, extensions, headSha), { cwd: dir, env, okCodes: [1] });
      return parseGrep(r.stdout, headSha);
    },
  };
}

/**
 * Fetches head and merge base by SHA, shallow and without blobs, under refs/bowi/ so that
 * `git gc` keeps them. If the server refuses SHA fetches, falls back to the PR's head ref and the
 * base branch with full (blobless) history.
 */
async function fetchCommits(request: RemoteRequest): Promise<void> {
  const { dir, env, meta } = request;
  const n = meta.prNumber;
  const common = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--filter=blob:none'];
  try {
    await git(
      [
        ...common,
        '--depth=1',
        'origin',
        `${meta.headSha}:refs/bowi/pr/${n}/head`,
        `${meta.mergeBaseSha}:refs/bowi/pr/${n}/merge-base`,
      ],
      { cwd: dir, env },
    );
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    try {
      await git(
        [
          ...common,
          'origin',
          `${request.headRef}:refs/bowi/pr/${n}/head`,
          `refs/heads/${meta.baseRef}:refs/bowi/pr/${n}/base`,
        ],
        { cwd: dir, env },
      );
    } catch (e2) {
      if (!(e2 instanceof GitError)) throw e2;
      throw request.fetchError(e2);
    }
  }
}

/** Whether git's error says the server wanted credentials it did not get or accept. */
export function isAuthFailure(e: GitError): boolean {
  return /Authentication failed|could not read Username|terminal prompts disabled|403|401/i.test(
    e.stderr,
  );
}

/** The last line of git's error, for a fetch that failed for another reason. */
export function fetchFailed(e: GitError, what: string): SourceError {
  return new SourceError(
    `Fetching ${what} failed: ${e.stderr.trim().split('\n').at(-1) ?? e.message}`,
    'Check your network connection and try again.',
  );
}

/**
 * git config through the environment: an Authorization header for the host, if there is a token.
 * `user` is the name the host expects next to a token (GitHub `x-access-token`, GitLab `oauth2`).
 */
export function authEnv(url: string, token: string | undefined, user: string): NodeJS.ProcessEnv {
  if (!token || !url.startsWith('https://')) return {};
  const origin = new URL(url).origin;
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`${user}:${token}`).toString('base64')}`,
  };
}
