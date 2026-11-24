/**
 * Sending comments to a GitLab merge request (M13, §15 #88), the only place Bowi writes to GitLab.
 *
 * GitLab's review is the reviewer's draft notes on the merge request: each comment is one draft
 * (only its author sees it), and "post now" publishes them all at once (`bulk_publish`), as
 * GitHub submits a pending review. The summary is a draft without a position, which GitLab
 * publishes as a comment on the merge request. A draft has no address of its own until it is
 * published, so what Bowi records links to the merge request.
 *
 * Lines are placed by GitLab's position: the merge request version the report was made from (its
 * base, start and head SHAs) and both line numbers of a context line. A range also carries GitLab's
 * line codes (the SHA-1 of the path, then the old and new line).
 */

import { createHash } from 'node:crypto';
import {
  HostError,
  type HostComment,
  type HostRef,
  type HostRow,
  type ReviewHost,
} from '@bowi/core';
import {
  loginHint,
  mergeRequestLabel,
  projectApi,
  resolveGitlabLogin,
  type GitlabLogin,
  type MergeRequestRef,
} from './gitlab.ts';

export type { GitlabLogin } from './gitlab.ts';

/** GITLAB_TOKEN (for its host), else glab's login on this host; else says which step applies. */
export async function findGitlabLogin(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitlabLogin> {
  const login = await resolveGitlabLogin(host, env);
  if ('token' in login) return login;
  if (login.missing === 'not-installed') {
    throw new HostError(
      'login',
      `Bowi needs a GitLab login on ${host} to post, and the GitLab CLI (glab) is not installed.`,
      `Install it from https://gitlab.com/gitlab-org/cli and log in, or set a token and start Bowi again. ${loginHint(host)}`,
    );
  }
  throw new HostError('login', `Bowi needs a GitLab login on ${host} to post.`, loginHint(host));
}

const TIMEOUT_MS = 30_000;

/** GitLab's line code of a diff row: the SHA-1 of the file's path, then its old and new line. */
export function lineCode(path: string, row: HostRow): string {
  return `${createHash('sha1').update(path).digest('hex')}_${row.oldNo}_${row.newNo}`;
}

interface Version {
  base_commit_sha: string;
  start_commit_sha: string;
  head_commit_sha: string;
}

interface DraftJson {
  id: number;
  position?: { head_sha?: string | null; position_type?: string | null } | null;
}

export function gitlabReviewHost(
  ref: MergeRequestRef,
  login: GitlabLogin,
  options: { fetch?: typeof fetch; apiBase?: string; timeoutMs?: number } = {},
): ReviewHost {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.apiBase ?? `https://${ref.host}/api/v4`}`;
  const mr = projectApi(ref);
  const label = mergeRequestLabel(ref);
  const name = { glab: 'glab login', GITLAB_TOKEN: '`GITLAB_TOKEN`', token: 'token' }[login.via];
  let webUrl = `https://${ref.host}/${ref.path}/-/merge_requests/${ref.iid}`;
  /** The head the comments are on: the report's (a new review) or the pending drafts'. */
  let head: string | undefined;
  let version: Version | undefined;

  /** A request's status and JSON; everything that stops a send is thrown as a HostError. */
  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const writes = method !== 'GET';
    // After a request that writes, no answer does not mean nothing happened.
    const noAnswer = (message: string) =>
      writes
        ? new HostError(
            'uncertain',
            message,
            'The last comment may have arrived. Check the merge request before you try again, so it is not posted twice.',
          )
        : new HostError('other', message, 'Check your network connection and try again.');
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${login.token}`,
          Accept: 'application/json',
          'User-Agent': 'bowi',
          ...(body && { 'Content-Type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      throw noAnswer('GitLab did not answer in time.');
    }
    if (res.status === 401) {
      throw new HostError(
        'login',
        `GitLab rejected your ${name} (401).`,
        {
          glab: `It may have expired. Run \`glab auth login${ref.host === 'gitlab.com' ? '' : ` --hostname ${ref.host}`}\` again.`,
          GITLAB_TOKEN: 'Check `GITLAB_TOKEN`.',
          token: 'Check the token, or paste another one.',
        }[login.via],
      );
    }
    if (res.status === 429) {
      throw new HostError(
        'limit',
        'GitLab says Bowi is sending too much at once (rate limit).',
        'Wait a few minutes and try again. What was sent is recorded and is not sent twice.',
      );
    }
    if (res.status === 403) {
      throw new HostError(
        'read-only',
        `Your ${name} can read ${label} but cannot post to it.`,
        'Give the token the `api` scope, and check that you may comment on this merge request.',
      );
    }
    if (res.status >= 500) throw noAnswer(`GitLab answered with an error (${res.status}).`);
    let data: T;
    try {
      data = (res.status === 204 ? undefined : await res.json()) as T;
    } catch {
      if (res.ok) throw noAnswer('GitLab sent an answer Bowi could not read.');
      data = undefined as T;
    }
    return { status: res.status, data, headers: res.headers };
  }

  const notFound = () =>
    new HostError(
      'other',
      `Merge request ${label} was not found.`,
      'Check that it still exists and that your login can read this project.',
    );
  const reason = (data: unknown) => {
    const m = (data as { message?: unknown; error?: unknown } | undefined) ?? {};
    const text = m.message ?? m.error;
    if (text === undefined) return 'GitLab gave no reason';
    return typeof text === 'string' ? text : JSON.stringify(text);
  };

  /** The merge request version a head belongs to: GitLab keeps one per push. */
  async function versionOf(sha: string): Promise<Version> {
    if (version?.head_commit_sha === sha) return version;
    for (let page = 1; ; page++) {
      const { status, data } = await request<Version[]>(
        'GET',
        `${mr}/versions?per_page=100&page=${page}`,
      );
      if (status === 404) throw notFound();
      const found = data.find((v) => v.head_commit_sha === sha);
      if (found) return (version = found);
      if (data.length < 100) break;
    }
    throw new HostError(
      'other',
      `Commit ${sha.slice(0, 7)} of this report is not a version of ${label} on GitLab.`,
      'Run Bowi again on the merge request, then post.',
    );
  }

  async function createDraft(
    body: Record<string, unknown>,
  ): Promise<HostRef | { refused: string }> {
    const { status, data } = await request<DraftJson>('POST', `${mr}/draft_notes`, body);
    if (status === 404) throw notFound();
    if (status !== 200 && status !== 201) return { refused: reason(data) };
    return { id: String(data.id), url: body.position ? `${webUrl}/diffs` : webUrl };
  }

  return {
    async status() {
      const [user, merge] = await Promise.all([
        request<{ username: string }>('GET', '/user'),
        request<{ sha: string; web_url?: string }>('GET', mr),
      ]);
      if (merge.status === 404 || !merge.data?.sha) throw notFound();
      if (!user.data?.username) {
        throw new HostError('other', `GitLab did not say who is logged in (${user.status}).`);
      }
      if (merge.data.web_url) webUrl = merge.data.web_url;
      // Only the reviewer's own drafts are listed.
      const drafts: DraftJson[] = [];
      for (let page = 1; ; page++) {
        const { status, data } = await request<DraftJson[]>(
          'GET',
          `${mr}/draft_notes?per_page=100&page=${page}`,
        );
        if (status !== 200) break;
        drafts.push(...data);
        if (data.length < 100) break;
      }
      const placed = drafts.filter((d) => d.position?.head_sha);
      const pendingHead = placed[0]?.position?.head_sha ?? merge.data.sha;
      if (drafts.length > 0) head = pendingHead;
      return {
        login: user.data.username,
        headSha: merge.data.sha,
        ...(drafts.length > 0 && {
          pendingId: 'drafts',
          pending: {
            comments: placed.length,
            hasBody: placed.length < drafts.length,
            headSha: pendingHead,
          },
        }),
      };
    },

    async startReview(headSha, body) {
      head = headSha;
      await versionOf(headSha);
      if (body === undefined) return { id: 'drafts', url: webUrl };
      const made = await createDraft({ note: body });
      if ('refused' in made)
        throw new HostError('other', `GitLab refused the summary: ${made.refused}.`);
      return made;
    },

    async setSummary(_reviewId, body) {
      const made = await createDraft({ note: body });
      if ('refused' in made)
        throw new HostError('other', `GitLab refused the summary: ${made.refused}.`);
      return made;
    },

    async addComment(_reviewId, comment) {
      if (head === undefined) throw new HostError('other', 'No review was started on GitLab.');
      const v = await versionOf(head);
      const shas = {
        base_sha: v.base_commit_sha,
        start_sha: v.start_commit_sha,
        head_sha: v.head_commit_sha,
      };
      const paths = { old_path: comment.oldPath ?? comment.path, new_path: comment.path };
      if (comment.line === undefined || comment.side === undefined) {
        const made = await createDraft({
          note: comment.body,
          position: { position_type: 'file', ...shas, ...paths },
        });
        if (!('refused' in made)) return made;
        // A GitLab without comments on files: on the merge request, naming the file.
        return createDraft({ note: `On \`${comment.path}\`:\n\n${comment.body}` });
      }
      return createDraft({
        note: comment.body,
        position: { position_type: 'text', ...shas, ...paths, ...linePosition(comment) },
      });
    },

    async publish() {
      const { status, data } = await request<unknown>('POST', `${mr}/draft_notes/bulk_publish`);
      if (status === 404) throw notFound();
      if (status >= 300) {
        throw new HostError('other', `GitLab did not publish the review: ${reason(data)}.`);
      }
    },
  };
}

/** `old_line` / `new_line` of the last line, and the range when there is one. */
function linePosition(c: HostComment): Record<string, unknown> {
  const rows = c.rows;
  if (!rows) return c.side === 'old' ? { old_line: c.line } : { new_line: c.line };
  const place = (row: HostRow) => ({
    ...(row.kind !== 'add' && { old_line: row.oldNo }),
    ...(row.kind !== 'del' && { new_line: row.newNo }),
  });
  const end = place(rows.end);
  if (c.startLine === undefined) return end;
  const point = (row: HostRow) => ({
    line_code: lineCode(c.path, row),
    type: row.kind === 'add' ? 'new' : row.kind === 'del' ? 'old' : null,
    ...place(row),
  });
  return { ...end, line_range: { start: point(rows.start), end: point(rows.end) } };
}
