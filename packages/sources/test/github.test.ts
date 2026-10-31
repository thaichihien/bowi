import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStageContext, DEFAULT_CONFIG, diffStage, SourceError } from '@bowi/core';
import {
  fetchPullRequest,
  linkedIssues,
  openGithubSnapshot,
  openLocalSnapshot,
  parsePullRequestUrl,
  type PullRequestInfo,
} from '../src/index.ts';
import { fakeApi, fakeServer, type FakePr } from './fake-github.ts';

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'bowi-gh-'));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('parsePullRequestUrl', () => {
  it('accepts PR URLs, also with a tab, query or fragment', () => {
    for (const url of [
      'https://github.com/acme/api/pull/7',
      'https://github.com/acme/api/pull/7/',
      'https://github.com/acme/api/pull/7/files',
      'https://github.com/acme/api/pull/7/files?w=1#diff-abc',
    ]) {
      expect(parsePullRequestUrl(url)).toEqual({ owner: 'acme', repo: 'api', number: 7 });
    }
    expect(parsePullRequestUrl('https://github.com/a.b/c.d-e/pull/12')).toBeUndefined(); // owner has no dots
    expect(parsePullRequestUrl('https://github.com/ab/c.d-e/pull/12')).toEqual({
      owner: 'ab',
      repo: 'c.d-e',
      number: 12,
    });
  });

  it('rejects anything else', () => {
    for (const url of [
      'https://github.com/acme/api',
      'https://gitlab.com/a/b/pull/1',
      'https://github.com/acme/api/issues/7',
      'acme/api#7',
    ]) {
      expect(parsePullRequestUrl(url)).toBeUndefined();
    }
  });
});

describe('linkedIssues', () => {
  it('finds closing keywords', () => {
    expect(linkedIssues('Fixes #12. Also resolves: acme/web#3, see #99. closes #12')).toEqual([
      '#12',
      'acme/web#3',
    ]);
  });
});

describe('fetchPullRequest', () => {
  const pr: FakePr = {
    owner: 'acme',
    repo: 'api',
    number: 7,
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    headSha: 'h'.repeat(40),
    mergeBaseSha: 'm'.repeat(40),
    commits: Array.from({ length: 130 }, (_, i) => ({
      sha: String(i).padStart(40, '0'),
      message: `commit ${i}\n\nbody`,
      author: { name: 'Mona', date: '2026-01-05T10:00:00Z', login: 'octocat' },
      committer:
        i === 129
          ? { name: 'GitHub', date: '2026-01-06T10:00:00Z', login: 'web-flow' }
          : { name: 'Mona', date: '2026-01-05T10:00:00Z', login: 'octocat' },
    })),
  };
  const ref = { owner: 'acme', repo: 'api', number: 7 };

  it('reads metadata, merge base and all commits', async () => {
    const info = await fetchPullRequest(ref, { fetch: fakeApi(pr) });
    expect(info).toMatchObject({
      title: 'Add email verification',
      author: 'octocat',
      baseRef: 'main',
      headRef: 'feature/email-verification',
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      mergeBaseSha: pr.mergeBaseSha,
      linkedIssues: ['#12', 'acme/web#3'],
    });
    expect(info.createdAt).toBe('2026-01-05T09:00:00Z');
    expect(info.totalCommits).toBe(130);
    expect(info.commits).toHaveLength(130);
    expect(info.commits[0]).toEqual({
      sha: pr.commits[0]!.sha,
      subject: 'commit 0',
      body: 'body',
      author: { name: 'Mona', login: 'octocat' },
      authoredAt: '2026-01-05T10:00:00Z',
      committedAt: '2026-01-05T10:00:00Z',
    });
    // A commit made on github.com: committed by GitHub on the author's behalf.
    expect(info.commits[129]!.committer).toEqual({ name: 'GitHub', login: 'web-flow' });
    expect(info.commits[129]!.committedAt).toBe('2026-01-06T10:00:00Z');
  });

  it('turns API failures into source errors (exit 2) with a next step', async () => {
    const fail = async (status: number, headers: Record<string, string> = {}, token?: string) => {
      const e = await fetchPullRequest(ref, {
        fetch: fakeApi(pr, status, headers),
        ...(token && { token }),
      }).catch((x) => x);
      expect(e).toBeInstanceOf(SourceError);
      expect(e.exitCode).toBe(2);
      return `${e.message} ${e.hint}`;
    };
    expect(await fail(404)).toContain('set GITHUB_TOKEN or run `gh auth login`');
    expect(await fail(404, {}, 't')).toContain('your token can read this repository');
    expect(await fail(401, {}, 't')).toContain('rejected the token');
    expect(
      await fail(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }),
    ).toContain('rate limit');
    const offline = await fetchPullRequest(ref, {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    }).catch((x) => x);
    expect(offline.message).toContain('Could not reach the GitHub API');
  });
});

describe('openGithubSnapshot', () => {
  let remoteUrl: string;
  let info: PullRequestInfo;
  let localRepo: string;

  beforeAll(async () => {
    const root = tempDir();
    const server = fakeServer(root);
    remoteUrl = server.remoteUrl;
    localRepo = join(root, 'work');
    info = await fetchPullRequest(
      { owner: 'acme', repo: 'api', number: 7 },
      { fetch: fakeApi(server.pr) },
    );
  });

  it('fetches only what it needs into the cache, then reuses it', async () => {
    const cacheDir = join(tempDir(), 'cache');
    const first = await openGithubSnapshot(info, { cacheDir, remoteUrl });
    expect(first.fromCache).toBe(false);
    expect(first.meta).toMatchObject({
      kind: 'github',
      repo: 'acme/api',
      prNumber: 7,
      author: 'octocat',
    });

    const cached = join(cacheDir, 'repos', 'github.com', 'acme', 'api.git');
    expect(existsSync(cached)).toBe(true);
    expect(existsSync(`${cached}.lock`)).toBe(false);

    const second = await openGithubSnapshot(info, { cacheDir, remoteUrl: 'file:///nonexistent' });
    expect(second.fromCache).toBe(true);
    expect(await second.readDiff()).toBe(await first.readDiff());
  });

  it('produces the same diff and files as the local source', async () => {
    const gh = await openGithubSnapshot(info, { cacheDir: join(tempDir(), 'cache'), remoteUrl });
    const local = await openLocalSnapshot({ cwd: localRepo });
    const ctx = createStageContext(DEFAULT_CONFIG);
    expect(await diffStage(gh, ctx)).toEqual(await diffStage(local, ctx));
    expect(await gh.readFile('new', 'src/auth/auth.service.ts')).toBe(
      await local.readFile('new', 'src/auth/auth.service.ts'),
    );
    expect(await gh.readFile('old', 'src/utils/string.ts')).toBe(
      await local.readFile('old', 'src/utils/string.ts'),
    );
    expect(await gh.readFile('old', 'src/migrations/1730_add_email_verified.ts')).toBeNull();
  });

  it('gives the same history and search results as the local source, fetching in batches', async () => {
    const cacheDir = join(tempDir(), 'cache');
    const gh = await openGithubSnapshot(info, { cacheDir, remoteUrl });
    const local = await openLocalSnapshot({ cwd: localRepo });
    const paths = ['src/users/user.entity.ts', 'src/auth/auth.service.ts', 'README.md'];
    expect(await gh.blame!(paths)).toEqual(await local.blame!(paths));
    expect(await gh.baseHistory!(300)).toEqual(await local.baseHistory!(300));
    const words = ['User', 'register', 'verifyEmail'];
    expect(await gh.grep!(words, ['.ts'])).toEqual(await local.grep!(words, ['.ts']));

    // Everything is in the cache now: a second snapshot needs no server.
    const again = await openGithubSnapshot(info, { cacheDir, remoteUrl: 'file:///nonexistent' });
    expect(await again.blame!(paths)).toEqual(await local.blame!(paths));
    expect(await again.baseHistory!(300)).toEqual(await local.baseHistory!(300));
    expect(await again.grep!(words, ['.ts'])).toEqual(await local.grep!(words, ['.ts']));
  });

  it('reports an unreachable remote as a source error', async () => {
    const e = await openGithubSnapshot(info, {
      cacheDir: join(tempDir(), 'cache'),
      remoteUrl: 'file:///nonexistent/repo.git',
    }).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
  });
});
