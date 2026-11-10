import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anchorFor, snippetOf, type PostResult, type ReviewPlan } from '@bowi/core';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import {
  fakeReviewApi,
  fakeServer,
  type FakePr,
  type FakeReview,
} from '../../sources/test/fake-github.ts';
import { run, type CliIo } from '../src/index.ts';
import type { ServeHandle } from '../src/serve.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-post-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SERVICE = 'src/auth/auth.service.ts';
const URL_7 = 'https://github.com/acme/api/pull/7';
const readPlan = (dir: string): ReviewPlan =>
  JSON.parse(readFileSync(join(dir, 'review-plan.json'), 'utf8'));
const embedded = (dir: string): ReviewPlan => {
  const html = readFileSync(join(dir, 'review.html'), 'utf8');
  const m = /<script id="bowi-plan" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!;
  return JSON.parse(m[1]!);
};

let pr: FakePr;
let remoteUrl: string;
let cache: string;
let original: string;
let out: string;
let work: string;

async function bowi(
  argv: string[],
  github: Partial<NonNullable<CliIo['github']>> = {},
  extra: Partial<CliIo> = {},
) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd: work,
    env: { PATH: process.env.PATH },
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    now: () => new Date('2026-01-01T00:00:00Z'),
    github: { apiBase: 'https://api.github.com', remoteUrl, token: 't', ...github },
    ...extra,
  });
  return { code, stdout, stderr };
}

/** A line, a range, a file comment and an outdated one, with a summary. */
function addComments(dir: string): void {
  const plan = readPlan(dir);
  const file = plan.files.find((f) => f.path === SERVICE)!;
  const hunk = plan.hunks.filter((h) => h.fileId === file.id)[1]!;
  const comment = (id: string, a: number, b: number, body: string) => ({
    id,
    body,
    anchor: anchorFor(SERVICE, plan.source.headSha, hunk, { index: a }, { index: b }),
    snippet: snippetOf(hunk, a, b),
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-01T10:00:00Z',
    status: 'active' as const,
  });
  plan.review = {
    body: 'Looks good.',
    comments: [
      comment('c-1', 3, 5, 'A range'),
      comment('c-2', 11, 11, 'One line'),
      {
        ...comment('c-3', 0, 0, 'The file'),
        anchor: { path: SERVICE, headSha: plan.source.headSha },
        snippet: [],
      },
      { ...comment('c-4', 11, 11, 'Old one'), status: 'outdated' },
    ],
  };
  writeFileSync(join(dir, 'review-plan.json'), JSON.stringify(plan, null, 2));
}

beforeAll(async () => {
  const root = tempDir();
  ({ remoteUrl, pr } = fakeServer(root));
  cache = join(root, 'cache');
  out = join(tempDir(), 'out');
  work = tempDir();
  const api = fakeReviewApi(pr);
  const r = await bowi([URL_7, '--out', out, '--cache-dir', cache, '--no-open'], {
    fetch: api.fetch,
  });
  expect(r.stderr).not.toContain('error:');
  expect(r.code).toBe(0);
  original = readFileSync(join(out, 'review-plan.json'), 'utf8');
});

beforeEach(() => {
  writeFileSync(join(out, 'review-plan.json'), original);
  addComments(out);
});

describe('bowi comments push (CLI-16)', () => {
  it('lists what goes where, asks, sends a pending review and records it', async () => {
    const api = fakeReviewApi(pr);
    const questions: string[] = [];
    const r = await bowi(
      ['comments', 'push', out],
      { fetch: api.fetch },
      {
        ask: async (q) => {
          questions.push(q);
          // Nothing went out before the answer.
          expect(api.reviews).toEqual([]);
          return 'y';
        },
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Posting to acme/api#7 as @alice (GITHUB_TOKEN)');
    expect(r.stdout).toContain('Review summary');
    expect(r.stdout).toContain('Left out: 1 outdated comment');
    expect(questions).toEqual(['Send 3 comments and the summary as a pending review? [y/N] ']);
    expect(r.stdout).toContain('✓ Sent      3 comments and the summary as a pending review');
    expect(r.stdout).toContain(`→ Submit    ${URL_7}/files`);

    const [review] = api.reviews;
    expect(review).toMatchObject({ body: 'Looks good.', commit: pr.headSha, submitted: false });
    expect(review!.threads.map((t) => t.body)).toEqual(['The file', 'A range', 'One line']);
    expect(review!.threads[1]).toMatchObject({ subjectType: 'LINE', startSide: 'RIGHT' });

    const saved = readPlan(out).review!;
    expect(saved.bodySync).toMatchObject({ host: 'github', id: 'R_1', pending: true });
    expect(saved.comments.find((c) => c.id === 'c-1')!.sync).toMatchObject({
      pending: true,
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(saved.comments.find((c) => c.id === 'c-4')!.sync).toBeUndefined();
    expect(embedded(out).review!.comments.find((c) => c.id === 'c-1')!.sync).toBeDefined();
  });

  it('posts nothing twice: a second push sends nothing and shows where to submit', async () => {
    const api = fakeReviewApi(pr);
    await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    const sentBefore = api.operations.length;
    const again = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Nothing new to post: 3 comments already sent.');
    expect(again.stdout).toContain(`→ Submit    ${URL_7}/files`);
    // It did not even ask GitHub.
    expect(api.operations.length).toBe(sentBefore);
  });

  it('joins the pending review it finds, for a comment written later', async () => {
    const api = fakeReviewApi(pr);
    await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    const plan = readPlan(out);
    plan.review!.comments.push({
      id: 'c-5',
      body: 'Later',
      anchor: { path: SERVICE, headSha: plan.source.headSha },
      snippet: [],
      createdAt: 'x',
      updatedAt: 'x',
      status: 'active',
    });
    writeFileSync(join(out, 'review-plan.json'), JSON.stringify(plan));
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Already sent, not sent again: 3 comments');
    expect(r.stdout).toContain('They join your pending review (3 comments).');
    expect(api.reviews).toHaveLength(1);
    expect(api.reviews[0]!.threads.map((t) => t.body)).toContain('Later');
  });

  it('--now makes the review public and records it as posted', async () => {
    const api = fakeReviewApi(pr);
    const r = await bowi(['comments', 'push', out, '--yes', '--now'], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓ Posted    3 comments and the summary, public now');
    expect(api.reviews[0]!.submitted).toBe(true);
    const saved = readPlan(out).review!;
    expect(saved.bodySync!.pending).toBe(false);
    expect(saved.comments.find((c) => c.id === 'c-1')!.sync!.pending).toBe(false);
    const listed = await bowi(['comments', out]);
    expect(listed.stdout).toContain('· posted');
    expect(listed.stdout).toContain('4 comments, 3 posted, 1 outdated');
  });

  it('--outdated sends outdated comments on their file, with the old lines', async () => {
    const api = fakeReviewApi(pr);
    await bowi(['comments', 'push', out, '--yes', '--outdated'], { fetch: api.fetch });
    const old = api.reviews[0]!.threads.find((t) => t.body.includes('Old one'))!;
    expect(old.subjectType).toBe('FILE');
    expect(old.body).toMatch(/^Line \d+, written on `\w{7}`:\n\n```diff\n/);
  });

  it('puts a refused line on its file, and says so', async () => {
    const api = fakeReviewApi(pr, {
      refuse: (t) => t.subjectType === 'LINE' && t.body === 'One line',
    });
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('! On file');
    const moved = api.reviews[0]!.threads.find((t) => t.body.endsWith('One line'))!;
    expect(moved.subjectType).toBe('FILE');
    expect(moved.body).toMatch(/^Line \d+:\n\nOne line$/);
  });

  it('reports a comment the host refuses altogether and keeps it open', async () => {
    const api = fakeReviewApi(pr, { refuse: (t) => t.body.includes('One line') });
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not sent');
    expect(readPlan(out).review!.comments.find((c) => c.id === 'c-2')!.sync).toBeUndefined();
    expect(readPlan(out).review!.comments.find((c) => c.id === 'c-1')!.sync).toBeDefined();
  });

  it('records what went through when the connection drops half way', async () => {
    const api = fakeReviewApi(pr, { dropAfter: 1 });
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('GitHub did not answer in time.');
    expect(r.stderr).toContain('posted twice');
    const sent = readPlan(out).review!.comments.filter((c) => c.sync);
    expect(sent.map((c) => c.id)).toEqual(['c-3']);
    // Trying again sends the rest only.
    const healthy = fakeReviewApi(pr, { reviews: api.reviews });
    expect((await bowi(['comments', 'push', out, '--yes'], { fetch: healthy.fetch })).code).toBe(0);
    expect(api.reviews).toHaveLength(1);
    expect(api.reviews[0]!.threads.map((t) => t.body)).toEqual(['The file', 'A range', 'One line']);
  });

  it('--yes stops on new commits; asked, the reviewer decides', async () => {
    const api = fakeReviewApi(pr, { headSha: 'f'.repeat(40) });
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('The pull request has new commits since this report');
    expect(api.reviews).toEqual([]);
    const no = await bowi(
      ['comments', 'push', out],
      { fetch: api.fetch },
      { ask: async () => 'n' },
    );
    expect(no.code).toBe(0);
    expect(no.stdout).toContain('! This pull request has new commits.');
    expect(no.stdout).toContain('Nothing was posted.');
    expect(api.reviews).toEqual([]);
  });

  it('refuses without a terminal to ask on', async () => {
    const api = fakeReviewApi(pr);
    const r = await bowi(['comments', 'push', out], { fetch: api.fetch });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Nothing was posted: no terminal to ask on.');
    expect(r.stderr).toContain('--yes');
    expect(api.reviews).toEqual([]);
  });

  it('stops on a pending review of another commit, and --now on any pending review', async () => {
    const other: FakeReview = {
      id: 'R_0',
      body: '',
      commit: 'e'.repeat(40),
      submitted: false,
      threads: [],
    };
    const api = fakeReviewApi(pr, { reviews: [other] });
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Your pending review on GitHub is on commit eeeeeee');
    const same = fakeReviewApi(pr, { reviews: [{ ...other, commit: pr.headSha }] });
    const now = await bowi(['comments', 'push', out, '--yes', '--now'], { fetch: same.fetch });
    expect(now.code).toBe(2);
    expect(now.stderr).toContain('can only join it');
  });

  it('leaves a summary out when the pending review already has one', async () => {
    const api = fakeReviewApi(pr, {
      reviews: [{ id: 'R_0', body: 'Theirs', commit: pr.headSha, submitted: false, threads: [] }],
    });
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already has a summary');
    expect(api.reviews[0]!.body).toBe('Theirs');
    expect(readPlan(out).review!.bodySync).toBeUndefined();
  });

  it('says what a read-only token needs, and that nothing was posted', async () => {
    const api = fakeReviewApi(pr, { forbid: true });
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot post to it. Nothing was posted.');
    expect(r.stderr).toContain('Pull requests: write');
  });

  it('has no pull request to post to from a local report', async () => {
    const repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    const local = join(tempDir(), 'local');
    let code = await run(['--local', '--out', local, '--no-open'], {
      cwd: repo,
      env: { PATH: process.env.PATH },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
    expect(code).toBe(0);
    let err = '';
    code = await run(['comments', 'push', local, '--yes'], {
      cwd: repo,
      env: { PATH: process.env.PATH },
      stdout: { write: () => true },
      stderr: { write: (s: string) => (err += s) },
    });
    expect(code).toBe(1);
    expect(err).toContain('no pull request to post to');
    expect(err).toContain('--markdown');
  });
});

function http(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

describe('posting through bowi serve (UI-28)', () => {
  async function serving(
    github: Partial<NonNullable<CliIo['github']>>,
    extra: Partial<CliIo>,
    fn: (
      api: (method: string, path: string, body?: unknown) => ReturnType<typeof http>,
    ) => Promise<void>,
  ) {
    let failure: unknown;
    const result = await bowi(['serve', out, '--no-open'], github, {
      ...extra,
      onServe: (h: ServeHandle) => {
        const url = new URL(h.url);
        const token = url.searchParams.get('t')!;
        const api = (method: string, path: string, body?: unknown) =>
          http(`${url.origin}${path}`, {
            method,
            headers: {
              'X-Bowi-Token': token,
              ...(body !== undefined && { 'Content-Type': 'application/json' }),
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
          });
        fn(api)
          .catch((e) => (failure = e))
          .finally(() => void h.stop());
      },
    });
    if (failure) throw failure;
    return result;
  }

  it('contacts GitHub only when asked, needs the token, and sends what was ticked', async () => {
    const api = fakeReviewApi(pr);
    const generatedAt = readPlan(out).generatedAt;
    const r = await serving({ fetch: api.fetch }, {}, async (call) => {
      await call('GET', '/api/review');
      // Serving and loading the comments made no request.
      expect(api.operations).toEqual([]);
      const status = await call('GET', '/api/github');
      expect(status.status).toBe(200);
      expect(JSON.parse(status.body)).toEqual({
        login: 'alice',
        via: 'GITHUB_TOKEN',
        headSha: pr.headSha,
      });
      const sent = await call('POST', '/api/github', {
        generatedAt,
        mode: 'pending',
        commentIds: ['c-1'],
        summary: true,
      });
      expect(sent.status).toBe(200);
      const result = JSON.parse(sent.body) as PostResult;
      expect(result).toMatchObject({ sent: 1, summarySent: true, failed: [], onFile: [] });
      expect(result.review.comments.find((c) => c.id === 'c-1')!.sync!.pending).toBe(true);
      expect(result.review.comments.find((c) => c.id === 'c-2')!.sync).toBeUndefined();

      // A save from an old tab cannot change or remove what went out, or fake a send.
      const old = readPlan(out).review!;
      const put = await call('PUT', '/api/review', {
        generatedAt,
        review: {
          body: 'Changed',
          comments: [{ ...old.comments.find((c) => c.id === 'c-2')!, sync: old.comments[0]!.sync }],
        },
      });
      expect(put.status).toBe(200);
      const after = readPlan(out).review!;
      expect(after.body).toBe('Looks good.');
      expect(after.comments.find((c) => c.id === 'c-1')!.body).toBe('A range');
      expect(after.comments.find((c) => c.id === 'c-2')!.sync).toBeUndefined();
    });
    expect(r.stderr).toMatch(
      /✓ Sent {6}1 comment and the summary to acme\/api#7 as @alice, as a pending review/,
    );
  });

  it('refuses a post without the token, in the wrong form, or on a stale page', async () => {
    const api = fakeReviewApi(pr);
    const generatedAt = readPlan(out).generatedAt;
    await serving({ fetch: api.fetch }, {}, async (call) => {
      const good = { generatedAt, mode: 'pending', commentIds: ['c-1'], summary: false };
      expect((await call('POST', '/api/github', { ...good, mode: 'approve' })).status).toBe(400);
      expect((await call('POST', '/api/github', { ...good, generatedAt: 'old' })).status).toBe(409);
      expect((await call('PUT', '/api/github', good)).status).toBe(405);
      expect(api.reviews).toEqual([]);
    });
    await bowi(
      ['serve', out, '--no-open'],
      { fetch: api.fetch },
      {
        onServe: (h: ServeHandle) => {
          const url = new URL(h.url);
          void http(`${url.origin}/api/github`)
            .then((res) => expect(res.status).toBe(403))
            .finally(() => void h.stop());
        },
      },
    );
  });

  it('answers what stopped it, with its kind', async () => {
    const noGh = { env: { PATH: join(tmpdir(), 'bowi-no-such-folder') } };
    await serving({ token: '', fetch: fakeReviewApi(pr).fetch }, noGh, async (call) => {
      const status = await call('GET', '/api/github');
      expect(status.status).toBe(502);
      expect(JSON.parse(status.body)).toMatchObject({
        kind: 'login',
        error: 'Bowi needs a GitHub login to post, and the GitHub CLI is not installed.',
      });
    });
    const api = fakeReviewApi(pr, { forbid: true });
    const generatedAt = readPlan(out).generatedAt;
    await serving({ fetch: api.fetch }, {}, async (call) => {
      const sent = await call('POST', '/api/github', {
        generatedAt,
        mode: 'now',
        commentIds: ['c-1'],
        summary: false,
      });
      expect(JSON.parse(sent.body)).toMatchObject({ sent: 0, error: { kind: 'read-only' } });
    });
  });

  it('marks sent comments as posted and back, only through its own request', async () => {
    const api = fakeReviewApi(pr);
    await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    const generatedAt = readPlan(out).generatedAt;
    await serving({ fetch: api.fetch }, {}, async (call) => {
      const mark = (posted: boolean) =>
        call('POST', '/api/review/posted', { generatedAt, ids: ['c-1'], summary: true, posted });
      expect((await mark(true)).status).toBe(200);
      let review = readPlan(out).review!;
      expect(review.bodySync!.pending).toBe(false);
      expect(review.comments.find((c) => c.id === 'c-1')!.sync!.pending).toBe(false);
      expect(review.comments.find((c) => c.id === 'c-2')!.sync!.pending).toBe(true);
      expect(embedded(out).review!.bodySync!.pending).toBe(false);
      expect((await mark(false)).status).toBe(200);
      expect(readPlan(out).review!.comments.find((c) => c.id === 'c-1')!.sync!.pending).toBe(true);
      // A save from a page cannot do it.
      review = readPlan(out).review!;
      const flipped = {
        ...review,
        comments: review.comments.map((c) =>
          c.sync ? { ...c, sync: { ...c.sync, pending: false } } : c,
        ),
      };
      expect((await call('PUT', '/api/review', { generatedAt, review: flipped })).status).toBe(200);
      expect(readPlan(out).review!.comments.find((c) => c.id === 'c-1')!.sync!.pending).toBe(true);
      const stale = await call('POST', '/api/review/posted', {
        generatedAt: 'old',
        ids: [],
        summary: false,
        posted: true,
      });
      expect(stale.status).toBe(409);
      expect((await call('POST', '/api/review/posted', { generatedAt, ids: 'all' })).status).toBe(
        400,
      );
    });
    expect(api.operations.filter((o) => o !== 'BowiStatus')).not.toContain('BowiSubmit');
  });

  it('uses a token pasted in the dialog instead, keeps it in memory only, and goes back', async () => {
    const api = fakeReviewApi(pr, { logins: { t: 'alice', ghp_other123: 'bob' } });
    const generatedAt = readPlan(out).generatedAt;
    const r = await serving({ fetch: api.fetch }, {}, async (call) => {
      const bad = await call('POST', '/api/github/token', { token: 'ghp_wrong', name: 'Work' });
      expect(bad.status).toBe(502);
      expect(JSON.parse(bad.body)).toMatchObject({
        kind: 'login',
        error: 'GitHub rejected your token (401).',
      });
      expect(JSON.parse((await call('GET', '/api/github')).body).login).toBe('alice');
      expect((await call('POST', '/api/github/token', { token: 'has space' })).status).toBe(400);

      const good = await call('POST', '/api/github/token', {
        token: ' ghp_other123 ',
        name: 'Work',
      });
      expect(good.status).toBe(200);
      expect(good.body).not.toContain('ghp_other123');
      expect(JSON.parse(good.body)).toMatchObject({
        login: 'bob',
        via: 'token',
        tokenName: 'Work',
      });
      expect(JSON.parse((await call('GET', '/api/github')).body)).toMatchObject({ login: 'bob' });
      const sent = await call('POST', '/api/github', {
        generatedAt,
        mode: 'pending',
        commentIds: ['c-1'],
        summary: false,
      });
      expect(JSON.parse(sent.body)).toMatchObject({ sent: 1, login: 'bob' });

      expect((await call('DELETE', '/api/github/token')).status).toBe(200);
      expect(JSON.parse((await call('GET', '/api/github')).body)).toMatchObject({
        login: 'alice',
        via: 'GITHUB_TOKEN',
      });
    });
    // Never written or printed.
    expect(r.stderr).not.toContain('ghp_other123');
    expect(readFileSync(join(out, 'review-plan.json'), 'utf8')).not.toContain('ghp_other123');
    expect(readFileSync(join(out, 'review.html'), 'utf8')).not.toContain('ghp_other123');
  });
});
