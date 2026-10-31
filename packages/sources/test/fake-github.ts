/**
 * Offline stand-ins for GitHub: a fake REST API (an injected fetch) and a "server" repository
 * reachable over file:// that allows what GitHub allows (partial clone, fetching by SHA,
 * refs/pull/<n>/head).
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildFixtureRepo, emailVerification, type FixtureSpec } from '@bowi/fixtures';

export interface FakePr {
  owner: string;
  repo: string;
  number: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  commits: FakeCommit[];
  title?: string;
  body?: string;
}

export interface FakeCommit {
  sha: string;
  message: string;
  author?: { name: string; date: string; login?: string };
  committer?: { name: string; date: string; login?: string };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

/** A fixture (default: email-verification) published as PR #7 of acme/api on a file:// server. */
export function fakeServer(
  root: string,
  spec: FixtureSpec = emailVerification,
): { remoteUrl: string; pr: FakePr } {
  const repo = buildFixtureRepo(spec, join(root, 'work')).dir;
  const server = join(root, 'server.git');
  execFileSync('git', ['clone', '--quiet', '--bare', repo, server]);
  const headSha = git(repo, 'rev-parse', 'HEAD');
  const baseSha = git(repo, 'rev-parse', 'main');
  git(server, 'update-ref', 'refs/pull/7/head', headSha);
  git(server, 'config', 'uploadpack.allowFilter', 'true');
  git(server, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const format = '--format=%H%x1f%an%x1f%aI%x1f%cn%x1f%cI%x1f%B%x1e';
  const commits = git(repo, 'log', '--reverse', format, `${baseSha}..${headSha}`)
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c): FakeCommit => {
      const [sha = '', an = '', aI = '', cn = '', cI = '', message = ''] = c.split('\x1f');
      return {
        sha,
        message,
        author: { name: an, date: aI, login: 'octocat' },
        committer: { name: cn, date: cI, login: 'octocat' },
      };
    });
  return {
    remoteUrl: `file://${server}`,
    pr: {
      owner: 'acme',
      repo: 'api',
      number: 7,
      baseRef: 'main',
      baseSha,
      headSha,
      mergeBaseSha: baseSha,
      commits,
    },
  };
}

/** A fetch that answers the three endpoints Bowi uses, or `status` for every request. */
export function fakeApi(
  pr: FakePr,
  status = 200,
  headers: Record<string, string> = {},
): typeof fetch {
  const base = `/repos/${pr.owner}/${pr.repo}`;
  return (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const json = (body: unknown, code = status) =>
      new Response(JSON.stringify(body), {
        status: code,
        headers: { 'content-type': 'application/json', ...headers },
      });
    if (status !== 200) return json({ message: 'error' });
    if (url.pathname === `${base}/pulls/${pr.number}`) {
      return json({
        title: pr.title ?? 'Add email verification',
        body: pr.body ?? 'Fixes #12 and closes acme/web#3.',
        user: { login: 'octocat' },
        created_at: '2026-01-05T09:00:00Z',
        commits: pr.commits.length,
        base: { ref: pr.baseRef, sha: pr.baseSha },
        head: {
          ref: 'feature/email-verification',
          sha: pr.headSha,
          label: 'acme:feature/email-verification',
          repo: { full_name: `${pr.owner}/${pr.repo}` },
        },
      });
    }
    if (url.pathname === `${base}/compare/${pr.baseSha}...${pr.headSha}`) {
      return json({ merge_base_commit: { sha: pr.mergeBaseSha } });
    }
    if (url.pathname === `${base}/pulls/${pr.number}/commits`) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const per = Number(url.searchParams.get('per_page') ?? '30');
      return json(
        pr.commits.slice((page - 1) * per, page * per).map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message,
            author: c.author ? { name: c.author.name, date: c.author.date } : null,
            committer: c.committer ? { name: c.committer.name, date: c.committer.date } : null,
          },
          author: c.author?.login ? { login: c.author.login } : null,
          committer: c.committer?.login ? { login: c.committer.login } : null,
        })),
      );
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
}
