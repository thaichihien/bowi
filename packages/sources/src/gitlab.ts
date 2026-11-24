/**
 * GitLab source (M13, §15 #88): a merge request URL becomes the same Snapshot as a GitHub pull
 * request.
 *
 * 1. API v4 gives the merge request, with `diff_refs`: GitLab's own merge base (`base_sha`), the
 *    target branch's tip (`start_sha`) and the head. Then its commits and the issues it closes.
 * 2. Code comes from git (`remote.ts`, shared with GitHub), falling back to
 *    `refs/merge-requests/<iid>/head` when the server refuses to fetch by SHA.
 * 3. Any host whose URL has `/-/merge_requests/` is taken as GitLab, its API at `/api/v4`. A token
 *    is optional for public projects. `GITLAB_TOKEN` goes only to gitlab.com, or to the host named
 *    in `GITLAB_HOST` (glab's variable); otherwise the token glab stores for that very host. So a
 *    link to another server never receives a token meant for gitlab.com.
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

export interface MergeRequestRef {
  /** `gitlab.com`, or a self-managed server, with its port if any. */
  host: string;
  /** The project's full path: `group/subgroup/name`. */
  path: string;
  iid: number;
}

/**
 * `https://<host>/<group>/<subgroup…>/<project>/-/merge_requests/<iid>`, optionally followed by a
 * tab (`/diffs`, `/commits`), `?…` or `#…`. GitLab installed under a sub-path of its server is not
 * recognized (the path cannot tell where the server ends and the group starts).
 */
export function parseMergeRequestUrl(url: string): MergeRequestRef | undefined {
  const m =
    /^https:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)\/-\/merge_requests\/(\d+)(?:\/[a-z]*)?\/?(?:[?#].*)?$/.exec(
      url.trim(),
    );
  if (!m) return undefined;
  const path = m[2]!.replace(/\.git$/, '');
  // `.` and `..` are no GitLab path, and must not reach a URL or a cache folder.
  if (path.split('/').some((s) => /^\.+$/.test(s))) return undefined;
  return { host: m[1]!.toLowerCase(), path, iid: Number(m[3]) };
}

export const mergeRequestLabel = (ref: MergeRequestRef) => `${ref.path}!${ref.iid}`;

/** The host part of GITLAB_HOST, which glab accepts with or without `https://`. */
function gitlabHost(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.GITLAB_HOST?.trim();
  if (!value) return undefined;
  return value
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

/** The token glab stores for `host`, or why there is none. */
export function glabToken(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string } | { missing: 'not-installed' | 'not-logged-in' }> {
  // glab reads its environment variables first: without them it answers for this host only.
  const { GITLAB_TOKEN: _t, GITLAB_ACCESS_TOKEN: _a, OAUTH_TOKEN: _o, ...rest } = env;
  return new Promise((resolve) => {
    execFile(
      'glab',
      ['config', 'get', 'token', '--host', host],
      { timeout: 5000, env: rest },
      (err, stdout) => {
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          return resolve({ missing: 'not-installed' });
        }
        const token = err ? '' : stdout.trim();
        resolve(token ? { token } : { missing: 'not-logged-in' });
      },
    );
  });
}

export interface GitlabLogin {
  token: string;
  via: 'glab' | 'GITLAB_TOKEN' | 'token';
}

/** GITLAB_TOKEN when it is meant for `host`, else glab's login on `host`. */
export async function resolveGitlabLogin(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitlabLogin | { missing: 'not-installed' | 'not-logged-in' }> {
  if (env.GITLAB_TOKEN && host === (gitlabHost(env) ?? 'gitlab.com')) {
    return { token: env.GITLAB_TOKEN, via: 'GITLAB_TOKEN' };
  }
  const glab = await glabToken(host, env);
  return 'token' in glab ? { token: glab.token, via: 'glab' } : glab;
}

/** The token for reading a merge request, if there is one. */
export async function resolveGitlabToken(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const login = await resolveGitlabLogin(host, env);
  return 'token' in login ? login.token : undefined;
}

export interface MergeRequestInfo {
  ref: MergeRequestRef;
  url: string;
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
  /** Commits in the merge request; Bowi lists at most 250. */
  totalCommits: number;
  linkedIssues: string[];
}

export interface GitlabOptions {
  token?: string;
  /** For tests: a fetch implementation and API base URL. */
  fetch?: typeof fetch;
  apiBase?: string;
}

const MAX_COMMITS = 250;

export const projectApi = (ref: MergeRequestRef) =>
  `/projects/${encodeURIComponent(ref.path)}/merge_requests/${ref.iid}`;

export async function fetchMergeRequest(
  ref: MergeRequestRef,
  options: GitlabOptions = {},
): Promise<MergeRequestInfo> {
  const api = createApi(ref, options);
  const mr = (await api<MergeRequestJson>(projectApi(ref))).body;
  const refs = mr.diff_refs;
  if (!refs?.base_sha || !refs.head_sha || !refs.start_sha) {
    throw new SourceError(
      `GitLab has no diff for ${mergeRequestLabel(ref)} yet.`,
      'Wait until GitLab has prepared the merge request, then try again.',
    );
  }
  const [commits, linked, sourcePath] = await Promise.all([
    (async () => {
      // Newest first, as GitLab lists them.
      const list: CommitJson[] = [];
      let total = 0;
      for (let page = 1; list.length < MAX_COMMITS; page++) {
        const { body, headers } = await api<CommitJson[]>(
          `${projectApi(ref)}/commits?per_page=100&page=${page}`,
        );
        list.push(...body);
        total = Number(headers.get('x-total')) || list.length;
        if (body.length === 0 || list.length >= total) break;
      }
      return { list: list.slice(0, MAX_COMMITS).reverse().map(toCommit), total };
    })(),
    api<IssueJson[]>(`${projectApi(ref)}/closes_issues?per_page=100`).then(
      ({ body }) =>
        body.map((i) =>
          i.project_id === mr.target_project_id ? `#${i.iid}` : (i.references?.full ?? `#${i.iid}`),
        ),
      // Only a list of links: the review does not depend on it.
      () => [],
    ),
    mr.source_project_id !== undefined && mr.source_project_id !== mr.target_project_id
      ? api<{ path_with_namespace: string }>(`/projects/${mr.source_project_id}`).then(
          ({ body }) => body.path_with_namespace,
          () => undefined,
        )
      : undefined,
  ]);
  const info: MergeRequestInfo = {
    ref,
    url: mr.web_url ?? `https://${ref.host}/${ref.path}/-/merge_requests/${ref.iid}`,
    title: mr.title,
    description: mr.description ?? '',
    baseRef: mr.target_branch,
    headRef: sourcePath ? `${sourcePath}:${mr.source_branch}` : mr.source_branch,
    baseSha: refs.start_sha,
    headSha: refs.head_sha,
    mergeBaseSha: refs.base_sha,
    commits: commits.list,
    totalCommits: Math.max(commits.total, commits.list.length),
    linkedIssues: [...new Set(linked)],
  };
  if (mr.author?.username) info.author = mr.author.username;
  if (mr.created_at) info.createdAt = mr.created_at;
  return info;
}

function toCommit(c: CommitJson): Commit {
  const [subject = '', ...rest] = c.message.split('\n');
  const author: CommitPerson = { name: c.author_name || 'unknown' };
  const out: Commit = {
    sha: c.id,
    subject,
    author,
    authoredAt: c.authored_date ?? '',
    committedAt: c.committed_date ?? c.authored_date ?? '',
  };
  const body = rest.join('\n').trim();
  if (body) out.body = body;
  if (c.committer_name && c.committer_name !== author.name)
    out.committer = { name: c.committer_name };
  return out;
}

export interface GitlabSnapshotOptions {
  cacheDir: string;
  token?: string;
  /** For tests: clone from here instead of https://<host>/<path>.git. */
  remoteUrl?: string;
}

export type GitlabSnapshot = RemoteSnapshot;

export function openGitlabSnapshot(
  info: MergeRequestInfo,
  options: GitlabSnapshotOptions,
): Promise<GitlabSnapshot> {
  const { host, path, iid } = info.ref;
  const url = options.remoteUrl ?? `https://${host}/${path}.git`;
  // GitLab takes any user name with a token; `oauth2` also works for OAuth tokens (glab's).
  const env = authEnv(url, options.token, 'oauth2');
  const meta: SnapshotMeta = {
    kind: 'gitlab',
    repo: path,
    prNumber: iid,
    url: info.url,
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
    dir: repoCacheDir(options.cacheDir, host, ...path.split('/')),
    url,
    env,
    meta,
    totalCommits: info.totalCommits,
    headRef: `refs/merge-requests/${iid}/head`,
    fetchError: (e) => {
      if (!isAuthFailure(e)) return fetchFailed(e, `${host}/${path}`);
      // GitLab says what the token lacks (fine-grained tokens name a permission): pass it on.
      const said = remoteMessage(e.stderr);
      return new SourceError(
        `git could not access ${host}/${path}${said ? `: ${said}` : '.'}`,
        env.GIT_CONFIG_COUNT
          ? 'The token can read the merge request but not its code: it needs the read_repository scope (a fine-grained token: the Code: Download permission on this project).'
          : loginHint(host),
      );
    },
  });
}

/** The server's own words in git's error output (`remote: …` lines), if any. */
export function remoteMessage(stderr: string): string | undefined {
  const lines = [...stderr.matchAll(/^remote: (.+)$/gm)].map((m) => m[1]!.trim()).filter(Boolean);
  return lines.length > 0 ? lines.join(' ') : undefined;
}

/** How to give Bowi a login for `host`. */
export function loginHint(host: string): string {
  return host === 'gitlab.com'
    ? 'Set GITLAB_TOKEN or run `glab auth login`.'
    : `Run \`glab auth login --hostname ${host}\`, or set GITLAB_TOKEN and GITLAB_HOST=${host}.`;
}

interface MergeRequestJson {
  title: string;
  description: string | null;
  web_url?: string;
  author?: { username: string } | null;
  created_at?: string;
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
  diff_refs?: { base_sha: string | null; head_sha: string | null; start_sha: string | null } | null;
}
interface CommitJson {
  id: string;
  message: string;
  author_name?: string;
  authored_date?: string;
  committer_name?: string;
  committed_date?: string;
}
interface IssueJson {
  iid: number;
  project_id?: number;
  references?: { full?: string };
}

/** GET on the API: its JSON and headers, or a SourceError that says what to do. */
function createApi(ref: MergeRequestRef, options: GitlabOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.apiBase ?? `https://${ref.host}/api/v4`;
  const label = mergeRequestLabel(ref);
  return async <T>(path: string): Promise<{ body: T; headers: Headers }> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'bowi',
          ...(options.token && { Authorization: `Bearer ${options.token}` }),
        },
      });
    } catch (e) {
      throw new SourceError(
        `Could not reach the GitLab API at ${ref.host} (${e instanceof Error ? e.message : String(e)}).`,
        'Check the URL and your network connection, and try again.',
      );
    }
    if (res.ok) return { body: (await res.json()) as T, headers: res.headers };
    if (res.status === 404) {
      throw new SourceError(
        `Merge request ${label} was not found on ${ref.host}.`,
        options.token
          ? 'Check the URL, and that your token can read this project.'
          : `If the project is private: ${loginHint(ref.host)}`,
      );
    }
    if (res.status === 401) {
      throw new SourceError(
        `GitLab (${ref.host}) rejected the token (401).`,
        `It may have expired. ${loginHint(ref.host)}`,
      );
    }
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'later';
      throw new SourceError(
        `GitLab API rate limit reached; it resets at ${when}.`,
        options.token
          ? 'Wait for the reset and try again.'
          : `For a higher limit: ${loginHint(ref.host)}`,
      );
    }
    if (res.status === 403) {
      throw new SourceError(
        `GitLab refused access to ${label} (403).`,
        'Check that your token can read this project (the read_api scope).',
      );
    }
    throw new SourceError(`GitLab API error ${res.status} for ${label}.`, 'Try again later.');
  };
}
