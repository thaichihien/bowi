/**
 * Offline stand-ins for GitLab (M13): the fake "server" repository of fake-github.ts with GitLab's
 * `refs/merge-requests/<iid>/head`, and a fake API v4 (an injected fetch) with the merge request,
 * its commits, closing issues and versions, and the reviewer's draft notes.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { emailVerification, type FixtureSpec } from '@bowi/fixtures';
import { fakeServer, type FakePr } from './fake-github.ts';

export const MR_PATH = 'acme/platform/api';
export const MR_URL = `https://gitlab.com/${MR_PATH}/-/merge_requests/7`;

/** A fixture published as merge request !7 of acme/platform/api on a file:// server. */
export function fakeGitlabServer(
  root: string,
  spec: FixtureSpec = emailVerification,
): { remoteUrl: string; pr: FakePr } {
  const server = fakeServer(root, spec);
  execFileSync('git', [
    '-C',
    join(root, 'server.git'),
    'update-ref',
    'refs/merge-requests/7/head',
    server.pr.headSha,
  ]);
  return server;
}

export interface FakeDraft {
  id: number;
  note: string;
  position?: Record<string, unknown>;
  published: boolean;
}

/**
 * The API Bowi reads and writes. `drafts` keeps what was sent; `refuse` answers a draft the way a
 * position outside the diff is answered, `status` answers every request with it, `writeStatus`
 * every write, `noFileComments` refuses comments on files as a GitLab before them does, and
 * `tokens` lists the tokens GitLab knows (others get 401).
 */
export function fakeGitlabApi(
  pr: FakePr,
  options: {
    username?: string;
    headSha?: string;
    drafts?: FakeDraft[];
    refuse?: (draft: { note: string; position?: Record<string, unknown> }) => boolean;
    noFileComments?: boolean;
    status?: number;
    writeStatus?: number;
    tokens?: string[];
    forkPath?: string;
  } = {},
): { fetch: typeof fetch; drafts: FakeDraft[]; requests: string[] } {
  const drafts = options.drafts ?? [];
  const requests: string[] = [];
  const mr = `/api/v4/projects/${encodeURIComponent(MR_PATH)}/merge_requests/7`;
  const reply = (body: unknown, code = 200, headers: Record<string, string> = {}) =>
    new Response(code === 204 ? null : JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname.replace('/api/v4', '')}`);
    if (options.status) return reply({ message: 'error' }, options.status);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (options.tokens && !options.tokens.includes(auth?.replace(/^Bearer /, '') ?? '')) {
      return reply({ message: '401 Unauthorized' }, 401);
    }
    const path = url.pathname;
    if (method !== 'GET' && options.writeStatus)
      return reply({ message: 'error' }, options.writeStatus);
    if (path === mr) {
      return reply({
        title: pr.title ?? 'Add email verification',
        description: pr.body ?? 'Closes #12.',
        web_url: MR_URL,
        author: { username: 'tanuki' },
        created_at: '2026-01-05T09:00:00Z',
        source_branch: 'feature/email-verification',
        target_branch: pr.baseRef,
        source_project_id: options.forkPath ? 99 : 1,
        target_project_id: 1,
        sha: options.headSha ?? pr.headSha,
        diff_refs: { base_sha: pr.mergeBaseSha, start_sha: pr.baseSha, head_sha: pr.headSha },
      });
    }
    if (path === '/api/v4/projects/99' && options.forkPath) {
      return reply({ path_with_namespace: options.forkPath });
    }
    if (path === `${mr}/commits`) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = Number(url.searchParams.get('per_page') ?? '20');
      // Newest first, as GitLab lists them.
      const newest = [...pr.commits].reverse();
      return reply(
        newest.slice((page - 1) * per, page * per).map((c) => ({
          id: c.sha,
          message: c.message,
          author_name: c.author?.name,
          authored_date: c.author?.date,
          committer_name: c.committer?.name,
          committed_date: c.committer?.date,
        })),
        200,
        { 'x-total': String(pr.commits.length) },
      );
    }
    if (path === `${mr}/closes_issues`) {
      return reply([
        { iid: 12, project_id: 1, references: { full: `${MR_PATH}#12` } },
        { iid: 3, project_id: 2, references: { full: 'acme/web#3' } },
      ]);
    }
    if (path === '/api/v4/user') return reply({ username: options.username ?? 'alice' });
    if (path === `${mr}/versions`) {
      return reply([
        {
          head_commit_sha: pr.headSha,
          base_commit_sha: pr.mergeBaseSha,
          start_commit_sha: pr.baseSha,
        },
      ]);
    }
    if (path === `${mr}/draft_notes` && method === 'GET') {
      return reply(
        drafts
          .filter((d) => !d.published)
          .map((d) => ({ id: d.id, note: d.note, position: d.position ?? null })),
      );
    }
    if (path === `${mr}/draft_notes` && method === 'POST') {
      const body = JSON.parse(init!.body as string) as {
        note: string;
        position?: Record<string, unknown>;
      };
      if (
        options.refuse?.(body) ||
        (options.noFileComments && body.position?.position_type === 'file')
      ) {
        return reply({ message: { base: ['Position is invalid'] } }, 400);
      }
      const draft: FakeDraft = {
        id: 100 + drafts.length,
        note: body.note,
        ...(body.position && { position: body.position }),
        published: false,
      };
      drafts.push(draft);
      return reply({ id: draft.id, note: draft.note }, 201);
    }
    if (path === `${mr}/draft_notes/bulk_publish` && method === 'POST') {
      for (const d of drafts) d.published = true;
      return reply(undefined, 204);
    }
    return reply({ message: '404 Not Found' }, 404);
  }) as typeof fetch;
  return { fetch: fetchFake, drafts, requests };
}
