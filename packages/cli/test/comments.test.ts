import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorFor, snippetOf, type Review, type ReviewPlan } from '@bowi/core';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { run, type CliIo } from '../src/index.ts';
import type { ServeHandle } from '../src/serve.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-comments-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function bowi(cwd: string, argv: string[], extra: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd,
    env: {},
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    now: () => new Date('2026-01-01T00:00:00Z'),
    github: { token: '', apiBase: 'http://127.0.0.1:9' },
    ...extra,
  });
  return { code, stdout, stderr };
}

const readPlan = (dir: string): ReviewPlan =>
  JSON.parse(readFileSync(join(dir, 'review-plan.json'), 'utf8'));
const embedded = (dir: string): ReviewPlan => {
  const html = readFileSync(join(dir, 'review.html'), 'utf8');
  const m = /<script id="bowi-plan" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!;
  return JSON.parse(m[1]!);
};
const SERVICE = 'src/auth/auth.service.ts';

/** Two comments on the service (lines 44–46 and 52), a file comment and a summary. */
function addComments(dir: string): Review {
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
      comment('c-1', 3, 5, 'Send first?'),
      comment('c-2', 11, 11, 'Unauthorized?'),
      {
        ...comment('c-3', 0, 0, 'Needs a test.'),
        anchor: { path: SERVICE, headSha: plan.source.headSha },
        snippet: [],
      },
    ],
  };
  writeFileSync(join(dir, 'review-plan.json'), JSON.stringify(plan, null, 2));
  return plan.review;
}

describe('re-runs keep the comments (§15 #64)', () => {
  let repo: string;
  let out: string;

  beforeAll(async () => {
    repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    out = join(tempDir(), 'out');
    expect((await bowi(repo, ['--local', '--out', out])).code).toBe(0);
    addComments(out);
  });

  it('keeps them in place on the same diff, and in review.html', async () => {
    const r = await bowi(repo, ['--local', '--out', out]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/✓ Comments {2}3 kept {2,}0\.0s/);
    expect(readPlan(out).review!.comments.map((c) => c.status)).toEqual([
      'active',
      'active',
      'active',
    ]);
    expect(embedded(out).review!.body).toBe('Looks good.');
  });

  it('moves a comment with its lines and keeps the others as outdated', async () => {
    const path = join(repo, SERVICE);
    const source = readFileSync(path, 'utf8');
    // Two lines above the commented ones; the line of the second comment changes.
    writeFileSync(
      path,
      source
        .replace('  async register(', '  // one\n  // two\n  async register(')
        .replace("'Invalid token'", "'Unknown token'"),
    );
    const r = await bowi(repo, ['--local', '--out', out, '--no-comments']);
    expect(r.stderr).toContain('✓ Comments  2 kept (1 moved), 1 outdated');
    const [moved, outdated, file] = readPlan(out).review!.comments;
    expect(moved!.anchor).toMatchObject({ startLine: 46, line: 48, side: 'new' });
    expect(outdated!.status).toBe('outdated');
    expect(file!.status).toBe('active');
    // --no-comments: the plan keeps them, the page leaves them out.
    expect(embedded(out).review).toBeUndefined();
    writeFileSync(path, source);
  });

  it('keeps comments of another review aside instead of mixing them in', async () => {
    const other = join(tempDir(), 'other');
    expect((await bowi(repo, ['--local', '--json-only', '--out', other])).code).toBe(0);
    addComments(other);
    const plan = readPlan(other);
    plan.source.headRef = 'some-other-branch';
    writeFileSync(join(other, 'review-plan.json'), JSON.stringify(plan));
    const r = await bowi(repo, ['--local', '--json-only', '--out', other]);
    expect(r.stderr).toContain('held comments on another review');
    expect(readPlan(other).review).toBeUndefined();
    expect(existsSync(join(other, 'review-plan.json.bak'))).toBe(true);
  });
});

describe('bowi comments (CLI-14)', () => {
  let out: string;
  beforeAll(async () => {
    const repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    out = join(tempDir(), 'out');
    expect((await bowi(repo, ['--local', '--json-only', '--out', out])).code).toBe(0);
  });

  it('says when there are none, then lists them in the terminal or as Markdown', async () => {
    expect((await bowi(out, ['comments', '.'])).stdout).toBe(`No comments in ${out}.\n`);
    addComments(out);
    const list = await bowi(out, ['comments', out]);
    expect(list.code).toBe(0);
    expect(list.stdout).toBe(
      [
        'Review summary\n  Looks good.',
        `${SERVICE} · File comment\n  Needs a test.`,
        `${SERVICE} · Lines 44–46\n  Send first?`,
        `${SERVICE} · Line 52\n  Unauthorized?`,
        '3 comments',
      ].join('\n\n') + '\n',
    );
    const md = await bowi(out, ['comments', out, '--markdown']);
    expect(md.stdout).toMatch(
      /^Looks good\.\n\n### `src\/auth\/auth\.service\.ts`\n\nNeeds a test\./,
    );
    expect(md.stdout).toContain('### `src/auth/auth.service.ts` lines 44–46\n\n```diff\n+');
  });

  it('exits 1 with a next step for a folder without a report', async () => {
    const r = await bowi(tempDir(), ['comments', 'nowhere']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No Bowi report in');
    expect(r.stderr).toContain('Run `bowi --local --out <dir>` first');
  });
});

/** A raw request, so tests can send the Host and Origin a browser page would. */
function http(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('bowi serve (CLI-13)', () => {
  let out: string;
  let repo: string;
  beforeAll(async () => {
    repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    out = join(tempDir(), 'out');
    expect((await bowi(repo, ['--local', '--out', out])).code).toBe(0);
  });

  /** Runs `bowi serve`, hands the address to `fn`, then stops it. */
  async function serving(argv: string[], cwd: string, fn: (url: URL) => Promise<void>) {
    let failure: unknown;
    const result = await bowi(cwd, argv, {
      onServe: (h: ServeHandle) => {
        fn(new URL(h.url))
          .catch((e) => (failure = e))
          .finally(() => void h.stop());
      },
    });
    if (failure) throw failure;
    return result;
  }

  it('serves the page and its comments only to holders of the token', async () => {
    const r = await serving(['serve', out, '--no-open'], repo, async (url) => {
      const token = url.searchParams.get('t')!;
      const base = url.origin;
      const page = await http(url.href);
      expect(page.status).toBe(200);
      expect(page.body).toContain('<meta name="bowi-features" content="comments"');
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect((await http(`${base}/`)).status).toBe(403);
      expect((await http(`${base}/?t=wrong`)).status).toBe(403);
      // DNS rebinding: another name for this address.
      expect((await http(url.href, { headers: { Host: `evil.example:${url.port}` } })).status).toBe(
        403,
      );
      expect((await http(`${base}/api/review`)).status).toBe(403);
      const api = await http(`${base}/api/review`, { headers: { 'X-Bowi-Token': token } });
      expect(api.status).toBe(200);
      expect(JSON.parse(api.body)).toMatchObject({ review: { body: '', comments: [] }, dir: out });
      // Another page in the browser, even with the token.
      const cross = await http(`${base}/api/review`, {
        headers: { 'X-Bowi-Token': token, Origin: 'http://evil.example' },
      });
      expect(cross.status).toBe(403);
      expect((await http(`${base}/review-plan.json?t=${token}`)).status).toBe(404);
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/✓ Serving {3}review\.html · 0 comments in the plan/);
    expect(r.stderr).toMatch(/→ Open http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]{24}\n/);
    expect(r.stderr).toContain('Stopped serving.');
  });

  it('saves comments into the plan and the page, and refuses stale or broken ones', async () => {
    const plan = readPlan(out);
    const review = { body: 'Saved from the page', comments: [] };
    await serving(['serve', out, '--no-open'], repo, async (url) => {
      const token = url.searchParams.get('t')!;
      const put = (body: unknown, type = 'application/json') =>
        http(`${url.origin}/api/review`, {
          method: 'PUT',
          headers: { 'X-Bowi-Token': token, 'Content-Type': type, Origin: url.origin },
          body: JSON.stringify(body),
        });
      expect((await put({ generatedAt: plan.generatedAt, review })).status).toBe(200);
      expect((await put({ generatedAt: 'older', review })).status).toBe(409);
      const bad = await put({ generatedAt: plan.generatedAt, review: { body: 1, comments: [] } });
      expect(bad.status).toBe(400);
      expect((await put({ generatedAt: plan.generatedAt, review }, 'text/plain')).status).toBe(415);
    });
    expect(readPlan(out).review).toEqual(review);
    expect(embedded(out).review).toEqual(review);
    // The analysis is untouched.
    expect({ ...readPlan(out), review: undefined }).toEqual({ ...plan, review: undefined });
  });

  it('serves right after a run with --serve, and needs review.html', async () => {
    let served = '';
    const r = await serving(
      ['--local', '--out', out, '--serve', '--no-open'],
      repo,
      async (url) => {
        served = (await http(url.href)).body;
      },
    );
    expect(r.code).toBe(0);
    expect(served).toContain('id="bowi-plan"');
    const both = await bowi(repo, ['--local', '--serve', '--json-only']);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('--serve needs review.html');
  });

  it('exits 1 for a report written before comments existed', async () => {
    const old = join(tempDir(), 'old');
    expect((await bowi(repo, ['--local', '--out', old])).code).toBe(0);
    const html = readFileSync(join(old, 'review.html'), 'utf8');
    writeFileSync(join(old, 'review.html'), html.replace(/<meta name="bowi-features"[^>]*>/, ''));
    const r = await bowi(repo, ['serve', old]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('was written by an older Bowi');
    expect(r.stderr).toContain(`Run bowi again with --out ${old}`);
  });
});
