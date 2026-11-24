/**
 * GitHub source (CLI-1, SRC-2..7): a pull request URL becomes the same Snapshot as --local.
 *
 * 1. The REST API gives the PR's metadata, head SHA, and (compare endpoint) its merge base.
 * 2. Code comes from git (`remote.ts`, shared with GitLab): the head and merge-base commits by
 *    SHA, shallow and without blobs, into a cache repository per GitHub repository.
 * 3. A token (GITHUB_TOKEN, else `gh auth token`) is optional for public repositories.
 */

import { execFile } from 'node:child_process';
import { repoCacheDir } from '@bowi/cache';
import { SourceError, type Commit, type CommitPerson, type SnapshotMeta } from '@bowi/core';
import {
  authEnv,
  fetchFailed,
  isAuthFailure,
  openRemoteSnapshot,
  type RemoteSnapshot,
} from './remote.ts';

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
  createdAt?: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  commits: Commit[];
  /** Commits in the PR; the API lists at most 250. */
  totalCommits: number;
  linkedIssues: string[];
}

export interface GithubOptions {
  token?: string;
  /** For tests: a fetch implementation and API base URL. */
  fetch?: typeof fetch;
  apiBase?: string;
}

/** The GitHub CLI's token, or why there is none. */
export function ghToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string } | { missing: 'not-installed' | 'not-logged-in' }> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000, env }, (err, stdout) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        return resolve({ missing: 'not-installed' });
      }
      const token = err ? '' : stdout.trim();
      resolve(token ? { token } : { missing: 'not-logged-in' });
    });
  });
}

/** GITHUB_TOKEN, else the token of the GitHub CLI if it is installed and logged in. */
export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const gh = await ghToken(env);
  return 'token' in gh ? gh.token : undefined;
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
      const list: Commit[] = [];
      for (let page = 1; list.length < Math.min(pr.commits, MAX_COMMITS); page++) {
        const batch = await api<CommitJson[]>(
          `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits?per_page=100&page=${page}`,
        );
        if (batch.length === 0) break;
        list.push(...batch.map(toCommit));
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
    totalCommits: pr.commits,
    linkedIssues: linkedIssues(pr.body ?? ''),
  };
  if (pr.user?.login) info.author = pr.user.login;
  if (pr.created_at) info.createdAt = pr.created_at;
  return info;
}

function toCommit(c: CommitJson): Commit {
  const [subject = '', ...rest] = c.commit.message.split('\n');
  const author: CommitPerson = { name: c.commit.author?.name ?? c.author?.login ?? 'unknown' };
  if (c.author?.login) author.login = c.author.login;
  const committer: CommitPerson = { name: c.commit.committer?.name ?? author.name };
  if (c.committer?.login) committer.login = c.committer.login;
  const out: Commit = {
    sha: c.sha,
    subject,
    author,
    authoredAt: c.commit.author?.date ?? '',
    committedAt: c.commit.committer?.date ?? c.commit.author?.date ?? '',
  };
  const body = rest.join('\n').trim();
  if (body) out.body = body;
  if (committer.name !== author.name || committer.login !== author.login) out.committer = committer;
  return out;
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

export type GithubSnapshot = RemoteSnapshot;

export function openGithubSnapshot(
  info: PullRequestInfo,
  options: GithubSnapshotOptions,
): Promise<GithubSnapshot> {
  const { owner, repo } = info.ref;
  const url = options.remoteUrl ?? `https://github.com/${owner}/${repo}.git`;
  const env = authEnv(url, options.token, 'x-access-token');
  const meta: SnapshotMeta = {
    kind: 'github',
    repo: `${owner}/${repo}`,
    prNumber: info.ref.number,
    url: `https://github.com/${owner}/${repo}/pull/${info.ref.number}`,
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
  if (info.createdAt) meta.createdAt = info.createdAt;
  if (info.totalCommits > info.commits.length) meta.totalCommits = info.totalCommits;
  if (info.linkedIssues.length) meta.linkedIssues = info.linkedIssues;

  return openRemoteSnapshot({
    dir: repoCacheDir(options.cacheDir, 'github.com', owner, repo),
    url,
    env,
    meta,
    totalCommits: info.totalCommits,
    headRef: `refs/pull/${info.ref.number}/head`,
    fetchError: (e) =>
      isAuthFailure(e)
        ? new SourceError(
            `git could not access ${owner}/${repo}.`,
            env.GIT_CONFIG_COUNT
              ? 'The token may lack access to this repository (it needs read access to contents).'
              : 'Set GITHUB_TOKEN or run `gh auth login`.',
          )
        : fetchFailed(e, `${owner}/${repo}`),
  });
}

interface PullJson {
  title: string;
  body: string | null;
  user?: { login: string };
  created_at?: string;
  commits: number;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; label?: string; repo?: { full_name: string } | null };
}
interface CompareJson {
  merge_base_commit: { sha: string };
}
interface CommitJson {
  sha: string;
  commit: {
    message: string;
    author?: { name: string; date: string } | null;
    committer?: { name: string; date: string } | null;
  };
  author?: { login: string } | null;
  committer?: { login: string } | null;
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
