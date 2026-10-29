/**
 * GitHub source (CLI-1, SRC-2..7): a pull request URL becomes the same Snapshot as --local.
 *
 * 1. The REST API gives the PR's metadata, head SHA, and (compare endpoint) its merge base.
 * 2. Code comes from git, never from the PR files API (it truncates large diffs, SRC-5): a bare
 *    cache repository per GitHub repository fetches just the head and merge-base commits by SHA,
 *    shallow and without blobs; `git diff` then downloads only the blobs it needs. A later run
 *    of the same PR finds both commits locally and fetches nothing.
 * 3. A token (GITHUB_TOKEN, else `gh auth token`) is optional for public repositories. It reaches
 *    git through environment config, never the command line, so other processes cannot see it.
 */

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { repoCacheDir, withLock } from '@bowi/cache';
import { SourceError, type FileVersion, type Snapshot, type SnapshotMeta } from '@bowi/core';
import { DIFF_FLAGS, git, GitError, readBlob } from './git.ts';

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** `https://github.com/<owner>/<repo>/pull/<n>`, optionally followed by `/files`, `#…`, `?…`. */
export function parsePullRequestUrl(url: string): PullRequestRef | undefined {
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:\/[a-z]*)?\/?(?:[?#].*)?$/.exec(
      url.trim(),
    );
  if (!m) return undefined;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ''), number: Number(m[3]) };
}

export interface PullRequestInfo {
  ref: PullRequestRef;
  title: string;
  description: string;
  author?: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  commits: { sha: string; subject: string }[];
  linkedIssues: string[];
}

export interface GithubOptions {
  token?: string;
  /** For tests: a fetch implementation and API base URL. */
  fetch?: typeof fetch;
  apiBase?: string;
}

/** GITHUB_TOKEN, else the token of the GitHub CLI if it is installed and logged in. */
export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}

const MAX_COMMITS = 250;

export async function fetchPullRequest(
  ref: PullRequestRef,
  options: GithubOptions = {},
): Promise<PullRequestInfo> {
  const api = createApi(ref, options);
  const pr = await api<PullJson>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  // Both need only the PR's SHAs: ask in parallel.
  const [compare, commits] = await Promise.all([
    api<CompareJson>(
      `/repos/${ref.owner}/${ref.repo}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
    ),
    (async () => {
      const list: { sha: string; subject: string }[] = [];
      for (let page = 1; list.length < Math.min(pr.commits, MAX_COMMITS); page++) {
        const batch = await api<CommitJson[]>(
          `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits?per_page=100&page=${page}`,
        );
        if (batch.length === 0) break;
        list.push(
          ...batch.map((c) => ({ sha: c.sha, subject: c.commit.message.split('\n')[0] ?? '' })),
        );
      }
      return list;
    })(),
  ]);
  const info: PullRequestInfo = {
    ref,
    title: pr.title,
    description: pr.body ?? '',
    baseRef: pr.base.ref,
    headRef:
      pr.head.label && pr.head.repo?.full_name !== `${ref.owner}/${ref.repo}`
        ? pr.head.label
        : pr.head.ref,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    mergeBaseSha: compare.merge_base_commit.sha,
    commits: commits.slice(0, MAX_COMMITS),
    linkedIssues: linkedIssues(pr.body ?? ''),
  };
  if (pr.user?.login) info.author = pr.user.login;
  return info;
}

/** `Fixes #12`, `closes owner/repo#5` and similar closing keywords in the description. */
export function linkedIssues(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+)/gi,
  )) {
    found.add(m[1]!);
  }
  return [...found];
}

export interface GithubSnapshotOptions {
  cacheDir: string;
  token?: string;
  /** For tests: clone from here instead of https://github.com/<owner>/<repo>.git. */
  remoteUrl?: string;
}

export interface GithubSnapshot extends Snapshot {
  /** True when both commits were already in the cache and nothing was downloaded. */
  fromCache: boolean;
}

export async function openGithubSnapshot(
  info: PullRequestInfo,
  options: GithubSnapshotOptions,
): Promise<GithubSnapshot> {
  const { owner, repo } = info.ref;
  const dir = repoCacheDir(options.cacheDir, 'github.com', owner, repo);
  const url = options.remoteUrl ?? `https://github.com/${owner}/${repo}.git`;
  // Lazy blob downloads during `git diff` and `cat-file` need the same credentials.
  const env = authEnv(url, options.token);

  const fromCache = await withLock(dir, async () => {
    await ensureRepo(dir, url, env);
    const have = async (sha: string) =>
      (await git(['cat-file', '-e', `${sha}^{commit}`], { cwd: dir, env, okCodes: [1, 128] }))
        .code === 0;
    if ((await have(info.headSha)) && (await have(info.mergeBaseSha))) return true;
    await fetchCommits(dir, info, env);
    return false;
  });

  const diff = (
    await git(['diff', ...DIFF_FLAGS, info.mergeBaseSha, info.headSha, '--'], { cwd: dir, env })
  ).stdout;
  const meta: SnapshotMeta = {
    kind: 'github',
    repo: `${owner}/${repo}`,
    prNumber: info.ref.number,
    title: info.title,
    description: info.description,
    baseRef: info.baseRef,
    headRef: info.headRef,
    baseSha: info.baseSha,
    headSha: info.headSha,
    mergeBaseSha: info.mergeBaseSha,
    commits: info.commits,
  };
  if (info.author) meta.author = info.author;
  if (info.linkedIssues.length) meta.linkedIssues = info.linkedIssues;

  return {
    meta,
    fromCache,
    readDiff: async () => diff,
    readFile: (version: FileVersion, path: string) =>
      readBlob(dir, version === 'old' ? info.mergeBaseSha : info.headSha, path, env),
  };
}

async function ensureRepo(dir: string, url: string, env: NodeJS.ProcessEnv): Promise<void> {
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

/**
 * Fetches head and merge base by SHA, shallow and without blobs, under refs/bowi/ so that
 * `git gc` keeps them. If the server refuses SHA fetches, falls back to the PR ref and the base
 * branch with full (blobless) history.
 */
async function fetchCommits(
  dir: string,
  info: PullRequestInfo,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const n = info.ref.number;
  const common = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--filter=blob:none'];
  try {
    await git(
      [
        ...common,
        '--depth=1',
        'origin',
        `${info.headSha}:refs/bowi/pr/${n}/head`,
        `${info.mergeBaseSha}:refs/bowi/pr/${n}/merge-base`,
      ],
      {
        cwd: dir,
        env,
      },
    );
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    try {
      await git(
        [
          ...common,
          'origin',
          `refs/pull/${n}/head:refs/bowi/pr/${n}/head`,
          `refs/heads/${info.baseRef}:refs/bowi/pr/${n}/base`,
        ],
        {
          cwd: dir,
          env,
        },
      );
    } catch (e2) {
      if (!(e2 instanceof GitError)) throw e2;
      throw fetchError(e2, info, env);
    }
  }
}

function fetchError(e: GitError, info: PullRequestInfo, env: NodeJS.ProcessEnv): SourceError {
  const { owner, repo } = info.ref;
  if (
    /Authentication failed|could not read Username|terminal prompts disabled|403|401/i.test(
      e.stderr,
    )
  ) {
    return new SourceError(
      `git could not access ${owner}/${repo}.`,
      env.GIT_CONFIG_COUNT
        ? 'The token may lack access to this repository (it needs read access to contents).'
        : 'Set GITHUB_TOKEN or run `gh auth login`.',
    );
  }
  return new SourceError(
    `Fetching ${owner}/${repo} failed: ${e.stderr.trim().split('\n').at(-1) ?? e.message}`,
    'Check your network connection and try again.',
  );
}

/** git config through the environment: an Authorization header for GitHub, if there is a token. */
function authEnv(url: string, token: string | undefined): NodeJS.ProcessEnv {
  if (!token || !url.startsWith('https://')) return {};
  const origin = new URL(url).origin;
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

interface PullJson {
  title: string;
  body: string | null;
  user?: { login: string };
  commits: number;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; label?: string; repo?: { full_name: string } | null };
}
interface CompareJson {
  merge_base_commit: { sha: string };
}
interface CommitJson {
  sha: string;
  commit: { message: string };
}

function createApi(ref: PullRequestRef, options: GithubOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.apiBase ?? 'https://api.github.com';
  const label = `${ref.owner}/${ref.repo}#${ref.number}`;
  return async <T>(path: string): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'bowi',
          ...(options.token && { Authorization: `Bearer ${options.token}` }),
        },
      });
    } catch (e) {
      throw new SourceError(
        `Could not reach the GitHub API (${e instanceof Error ? e.message : String(e)}).`,
        'Check your network connection and try again.',
      );
    }
    if (res.ok) return (await res.json()) as T;
    if (res.status === 404) {
      throw new SourceError(
        `Pull request ${label} was not found.`,
        options.token
          ? 'Check the URL, and that your token can read this repository.'
          : 'If the repository is private, set GITHUB_TOKEN or run `gh auth login`.',
      );
    }
    if (res.status === 401)
      throw new SourceError(
        'GitHub rejected the token (401).',
        'Check GITHUB_TOKEN, or run `gh auth login` again.',
      );
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'later';
        throw new SourceError(
          `GitHub API rate limit reached; it resets at ${when}.`,
          options.token
            ? 'Wait for the reset and try again.'
            : 'Set GITHUB_TOKEN or run `gh auth login` for a higher limit.',
        );
      }
      throw new SourceError(
        `GitHub refused access to ${label} (${res.status}).`,
        'Check that your token can read this repository.',
      );
    }
    throw new SourceError(`GitHub API error ${res.status} for ${label}.`, 'Try again later.');
  };
}
