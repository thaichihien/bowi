import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostError } from '@bowi/core';
import { findGitlabLogin, gitlabReviewHost, lineCode } from '../src/index.ts';
import type { FakePr } from './fake-github.ts';
import { fakeGitlabApi, fakeGitlabServer, MR_PATH, MR_URL } from './fake-gitlab.ts';

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ref = { host: 'gitlab.com', path: MR_PATH, iid: 7 };
const login = { token: 't', via: 'GITLAB_TOKEN' as const };
let pr: FakePr;
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'bowi-glr-'));
  roots.push(root);
  pr = fakeGitlabServer(root).pr;
});

describe('gitlabReviewHost', () => {
  it('says who is logged in and finds no pending review', async () => {
    const api = fakeGitlabApi(pr, { username: 'bob' });
    const host = gitlabReviewHost(ref, login, { fetch: api.fetch });
    expect(await host.status()).toEqual({ login: 'bob', headSha: pr.headSha });
  });

  it('sends each comment as a draft on the report’s version, then publishes them together', async () => {
    const api = fakeGitlabApi(pr);
    const host = gitlabReviewHost(ref, login, { fetch: api.fetch });
    await host.status();
    const review = await host.startReview(pr.headSha, 'Looks good overall.');
    expect(review).toEqual({ id: '100', url: MR_URL });
    const shas = { base_sha: pr.mergeBaseSha, start_sha: pr.baseSha, head_sha: pr.headSha };

    // One added line.
    expect(
      await host.addComment(review.id, {
        path: 'src/a.ts',
        body: 'Why?',
        line: 12,
        side: 'new',
        rows: {
          start: { kind: 'add', oldNo: 10, newNo: 12 },
          end: { kind: 'add', oldNo: 10, newNo: 12 },
        },
      }),
    ).toEqual({ id: '101', url: `${MR_URL}/diffs` });
    // A range from a context line to a deleted one, in a renamed file.
    await host.addComment(review.id, {
      path: 'src/b.ts',
      oldPath: 'src/old-b.ts',
      body: 'Range',
      line: 8,
      side: 'old',
      startLine: 5,
      startSide: 'new',
      rows: {
        start: { kind: 'context', oldNo: 6, newNo: 5 },
        end: { kind: 'del', oldNo: 8, newNo: 7 },
      },
    });
    // A whole file.
    await host.addComment(review.id, { path: 'src/c.ts', body: 'File note' });

    const [summary, line, range, file] = api.drafts;
    expect(summary).toMatchObject({ note: 'Looks good overall.' });
    expect(summary!.position).toBeUndefined();
    expect(line!.position).toEqual({
      position_type: 'text',
      ...shas,
      old_path: 'src/a.ts',
      new_path: 'src/a.ts',
      new_line: 12,
    });
    const sha = createHash('sha1').update('src/b.ts').digest('hex');
    expect(range!.position).toEqual({
      position_type: 'text',
      ...shas,
      old_path: 'src/old-b.ts',
      new_path: 'src/b.ts',
      old_line: 8,
      line_range: {
        start: { line_code: `${sha}_6_5`, type: null, old_line: 6, new_line: 5 },
        end: { line_code: `${sha}_8_7`, type: 'old', old_line: 8 },
      },
    });
    expect(file!.position).toEqual({
      position_type: 'file',
      ...shas,
      old_path: 'src/c.ts',
      new_path: 'src/c.ts',
    });
    expect(api.drafts.every((d) => !d.published)).toBe(true);

    await host.publish(review.id);
    expect(api.drafts.every((d) => d.published)).toBe(true);
    expect(api.requests.at(-1)).toBe(
      `POST /projects/${encodeURIComponent(MR_PATH)}/merge_requests/7/draft_notes/bulk_publish`,
    );
  });

  it('gives a context line both numbers', async () => {
    const api = fakeGitlabApi(pr);
    const host = gitlabReviewHost(ref, login, { fetch: api.fetch });
    const review = await host.startReview(pr.headSha);
    await host.addComment(review.id, {
      path: 'src/a.ts',
      body: 'Context',
      line: 4,
      side: 'new',
      rows: {
        start: { kind: 'context', oldNo: 3, newNo: 4 },
        end: { kind: 'context', oldNo: 3, newNo: 4 },
      },
    });
    expect(api.drafts[0]!.position).toMatchObject({ old_line: 3, new_line: 4 });
  });

  it('finds the reviewer’s pending drafts and adds to them', async () => {
    const api = fakeGitlabApi(pr, {
      drafts: [
        { id: 1, note: 'Earlier', position: { head_sha: pr.headSha }, published: false },
        { id: 2, note: 'Summary', published: false },
      ],
    });
    const host = gitlabReviewHost(ref, login, { fetch: api.fetch });
    expect(await host.status()).toMatchObject({
      pendingId: 'drafts',
      pending: { comments: 1, hasBody: true, headSha: pr.headSha },
    });
    expect(await host.addComment('drafts', { path: 'src/c.ts', body: 'More' })).toMatchObject({
      id: '102',
    });
  });

  it('says why a place was refused, and puts a file comment on the merge request when files take none', async () => {
    const api = fakeGitlabApi(pr, {
      refuse: (d) => d.position?.position_type === 'text',
      noFileComments: true,
    });
    const host = gitlabReviewHost(ref, login, { fetch: api.fetch });
    const review = await host.startReview(pr.headSha);
    expect(
      await host.addComment(review.id, { path: 'src/a.ts', body: 'x', line: 999, side: 'new' }),
    ).toEqual({ refused: '{"base":["Position is invalid"]}' });
    expect(await host.addComment(review.id, { path: 'src/c.ts', body: 'File note' })).toEqual({
      id: '100',
      url: MR_URL,
    });
    expect(api.drafts[0]).toMatchObject({ note: 'On `src/c.ts`:\n\nFile note' });
  });

  it('refuses a report whose commit is no version of the merge request', async () => {
    const host = gitlabReviewHost(ref, login, { fetch: fakeGitlabApi(pr).fetch });
    const e = await host.startReview('f'.repeat(40)).catch((x) => x);
    expect(e).toBeInstanceOf(HostError);
    expect(e.message).toContain('is not a version of acme/platform/api!7');
  });

  it('tells a rejected login, a token that cannot post and a lost answer apart', async () => {
    const rejected = await gitlabReviewHost(
      ref,
      { token: 'x', via: 'glab' },
      {
        fetch: fakeGitlabApi(pr, { tokens: ['good'] }).fetch,
      },
    )
      .status()
      .catch((x) => x);
    expect(rejected).toMatchObject({ kind: 'login' });
    expect(rejected.hint).toContain('glab auth login');

    const readOnly = gitlabReviewHost(ref, login, {
      fetch: fakeGitlabApi(pr, { writeStatus: 403 }).fetch,
    });
    expect(await readOnly.startReview(pr.headSha, 'Summary').catch((x) => x)).toMatchObject({
      kind: 'read-only',
    });

    const lost = gitlabReviewHost(ref, login, {
      fetch: fakeGitlabApi(pr, { writeStatus: 502 }).fetch,
    });
    expect(await lost.startReview(pr.headSha, 'Summary').catch((x) => x)).toMatchObject({
      kind: 'uncertain',
    });
  });
});

describe('findGitlabLogin', () => {
  it('says how to log in on that host', async () => {
    const e = await findGitlabLogin('git.example.com', { PATH: '' }).catch((x) => x);
    expect(e).toMatchObject({ kind: 'login' });
    expect(e.hint).toContain('GITLAB_HOST=git.example.com');
  });
});

describe('lineCode', () => {
  it('is the SHA-1 of the path, then the old and new line', () => {
    expect(lineCode('a.ts', { kind: 'add', oldNo: 0, newNo: 1 })).toBe(
      `${createHash('sha1').update('a.ts').digest('hex')}_0_1`,
    );
  });
});
