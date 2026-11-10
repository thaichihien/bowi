import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HostError } from '@bowi/core';
import { findGithubLogin, githubReviewHost } from '../src/index.ts';
import { fakeReviewApi, type FakePr } from './fake-github.ts';

const pr: FakePr = {
  owner: 'acme',
  repo: 'api',
  number: 7,
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  headSha: 'a'.repeat(40),
  mergeBaseSha: 'b'.repeat(40),
  commits: [],
};
const ref = { owner: 'acme', repo: 'api', number: 7 };
const login = { token: 't', via: 'GITHUB_TOKEN' as const };
const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const hostWith = (options: Parameters<typeof fakeReviewApi>[1] = {}) => {
  const api = fakeReviewApi(pr, options);
  return { api, host: githubReviewHost(ref, login, { fetch: api.fetch }) };
};
const caught = async (p: Promise<unknown>): Promise<HostError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(HostError);
  return e as HostError;
};

describe('findGithubLogin', () => {
  it('prefers GITHUB_TOKEN', async () => {
    expect(await findGithubLogin({ GITHUB_TOKEN: 'x' })).toEqual({
      token: 'x',
      via: 'GITHUB_TOKEN',
    });
  });

  it('says when the GitHub CLI is not installed', async () => {
    const e = await caught(findGithubLogin({ PATH: join(tmpdir(), 'bowi-no-such-folder') }));
    expect(e.kind).toBe('login');
    expect(e.message).toContain('not installed');
    expect(e.hint).toContain('https://cli.github.com');
  });

  it.skipIf(process.platform === 'win32')('tells logged out from a working gh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bowi-gh-'));
    roots.push(dir);
    const gh = join(dir, 'gh');
    writeFileSync(gh, '#!/bin/sh\nexit 1\n');
    chmodSync(gh, 0o755);
    const out = await caught(findGithubLogin({ PATH: `${dir}:/usr/bin:/bin` }));
    expect(out.message).toBe('Bowi needs a GitHub login to post.');
    expect(out.hint).toContain('gh auth login');
    writeFileSync(gh, '#!/bin/sh\necho from-gh\n');
    expect(await findGithubLogin({ PATH: `${dir}:/usr/bin:/bin` })).toEqual({
      token: 'from-gh',
      via: 'gh',
    });
  });
});

describe('githubReviewHost', () => {
  it('reads who is logged in, the head and a pending review', async () => {
    const { host } = hostWith({
      reviews: [
        { id: 'R_9', body: 'Hi', commit: pr.headSha, submitted: false, threads: [] },
        { id: 'R_8', body: '', commit: pr.headSha, submitted: true, threads: [] },
      ],
      headSha: 'c'.repeat(40),
    });
    expect(await host.status()).toEqual({
      login: 'alice',
      headSha: 'c'.repeat(40),
      pendingId: 'R_9',
      pending: { comments: 0, hasBody: true, headSha: pr.headSha },
    });
  });

  it('maps lines, ranges, old sides and files to what GitHub takes', async () => {
    const { api, host } = hostWith();
    const review = await host.startReview(pr.headSha, 'Summary');
    expect(api.reviews[0]).toMatchObject({ commit: pr.headSha, body: 'Summary', submitted: false });
    const made = await host.addComment(review.id, {
      path: 'a.ts',
      body: 'One',
      line: 5,
      side: 'new',
    });
    expect(made).toEqual({
      id: 'C_1',
      url: 'https://github.com/acme/api/pull/7#discussion_r1',
    });
    await host.addComment(review.id, {
      path: 'a.ts',
      body: 'Range',
      line: 9,
      side: 'new',
      startLine: 3,
      startSide: 'old',
    });
    await host.addComment(review.id, { path: 'a.ts', body: 'Old', line: 4, side: 'old' });
    await host.addComment(review.id, { path: 'a.ts', body: 'File' });
    const [one, range, old, file] = api.reviews[0]!.threads;
    expect(one).toMatchObject({ subjectType: 'LINE', line: 5, side: 'RIGHT' });
    expect(one).not.toHaveProperty('startLine');
    expect(range).toMatchObject({ line: 9, side: 'RIGHT', startLine: 3, startSide: 'LEFT' });
    expect(old).toMatchObject({ line: 4, side: 'LEFT' });
    expect(file).toMatchObject({ subjectType: 'FILE' });
    expect(file).not.toHaveProperty('line');
    await host.publish(review.id);
    expect(api.reviews[0]!.submitted).toBe(true);
  });

  it('reports a refused line as refused, not as a failure', async () => {
    const { host } = hostWith({ refuse: () => true });
    const review = await host.startReview(pr.headSha);
    expect(
      await host.addComment(review.id, { path: 'a.ts', body: 'x', line: 1, side: 'new' }),
    ).toEqual({ refused: 'Line must be part of the diff' });
  });

  it('says a read-only token cannot post, and which one', async () => {
    const { host } = hostWith({ forbid: true });
    const e = await caught(host.startReview(pr.headSha));
    expect(e.kind).toBe('read-only');
    expect(e.message).toBe('Your `GITHUB_TOKEN` can read acme/api#7 but cannot post to it.');
    expect(e.hint).toContain('Pull requests: write');
  });

  it('tells a rejected token, a rate limit and an answer that never came apart', async () => {
    expect((await caught(hostWith({ status: 401 }).host.status())).kind).toBe('login');
    expect((await caught(hostWith({ status: 429 }).host.status())).kind).toBe('limit');
    // A read that gets no answer changed nothing; a write might have.
    expect((await caught(hostWith({ status: 502 }).host.status())).kind).toBe('other');
    const write = hostWith({ writeStatus: 502 }).host.startReview(pr.headSha);
    expect((await caught(write)).kind).toBe('uncertain');
    const { host } = hostWith({ dropAfter: 0 });
    const review = await host.startReview(pr.headSha);
    const lost = await caught(host.addComment(review.id, { path: 'a.ts', body: 'x' }));
    expect(lost.kind).toBe('uncertain');
    expect(lost.hint).toContain('posted twice');
  });
});
