import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comparablePlanJson, type ReviewPlan } from '@bowi/core';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { expectedChangedFiles } from '@bowi/fixtures/email-verification';
import { run, type CliIo } from '../src/index.ts';
import { fakeApi, fakeServer } from '../../sources/test/fake-github.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-cli-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function bowi(cwd: string, ...argv: string[]) {
  return bowiWith({}, cwd, ...argv);
}

/** Runs the CLI with extra io: a fake GitHub, a terminal stdout, a browser opener. */
async function bowiWith(extra: Partial<CliIo> & { tty?: boolean }, cwd: string, ...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd,
    env: {},
    stdout: { write: (s: string) => (stdout += s), isTTY: !!extra.tty },
    stderr: { write: (s: string) => (stderr += s) },
    now: () => new Date('2026-01-01T00:00:00Z'),
    // Never the real GitHub: a URL without a fake fails fast on an unreachable API.
    github: { token: '', apiBase: 'http://127.0.0.1:9', ...extra.github },
    ...(extra.openFile && { openFile: extra.openFile }),
  });
  return { code, stdout, stderr };
}

const readPlan = (dir: string): ReviewPlan =>
  JSON.parse(readFileSync(join(dir, 'review-plan.json'), 'utf8'));
const gitOut = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('bowi --local --json-only on the email-verification fixture', () => {
  let repo: string;
  let plan: ReviewPlan;
  let out: string;

  beforeAll(async () => {
    repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    out = join(tempDir(), 'out');
    const r = await bowi(repo, '--local', '--json-only', '--out', out);
    expect(r.stderr).toContain('✓ Diff      11 files');
    expect(r.code).toBe(0);
    plan = readPlan(out);
  });

  it('lists the 11 changed files with the same line counts as git', () => {
    expect(plan.files.map((f) => f.path)).toEqual(expectedChangedFiles);
    const numstat = gitOut(repo, 'diff', '--numstat', 'main...HEAD')
      .trim()
      .split('\n')
      .map((l) => l.split('\t'))
      .map(([add, del, path]) => [path, Number(add), Number(del)]);
    expect(plan.files.map((f) => [f.path, f.additions, f.deletions])).toEqual(numstat);
    expect(
      plan.files.find((f) => f.path === 'src/migrations/1730_add_email_verified.ts')!.status,
    ).toBe('added');
    expect(
      plan.files.filter((f) => f.status !== 'added').every((f) => f.status === 'modified'),
    ).toBe(true);
  });

  it('produces one hunk per git hunk, with stable IDs and consistent line numbers', () => {
    const gitHunks = gitOut(repo, 'diff', 'main...HEAD')
      .split('\n')
      .filter((l) => l.startsWith('@@ ')).length;
    expect(plan.hunks).toHaveLength(gitHunks);
    expect(plan.stats).toMatchObject({ files: 11, hunks: gitHunks, additions: 115, deletions: 25 });

    for (const h of plan.hunks) {
      expect(h.id.startsWith(`${h.fileId}:h`)).toBe(true);
      const oldNos = h.lines.filter((l) => l.kind !== 'add').map((l) => l.oldNo);
      const newNos = h.lines.filter((l) => l.kind !== 'del').map((l) => l.newNo);
      expect(oldNos).toEqual(oldNos.map((_, i) => h.oldStart + i));
      expect(newNos).toEqual(newNos.map((_, i) => h.newStart + i));
    }

    const entity = plan.hunks.find(
      (h) => h.fileId === plan.files.find((f) => f.path === 'src/users/user.entity.ts')!.id,
    )!;
    expect(entity.lines.filter((l) => l.kind === 'add').map((l) => l.text.trim())).toEqual([
      '',
      "@Column({ name: 'email_verified', default: false })",
      'emailVerified: boolean;',
      '',
      "@Column({ name: 'verify_token', nullable: true })",
      'verifyToken: string | null;',
    ]);
  });

  it('records source metadata', () => {
    expect(plan.source).toMatchObject({
      kind: 'local',
      baseRef: 'main',
      headRef: 'feature/email-verification',
    });
    expect(plan.source.commits).toHaveLength(4);
    expect(plan.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is deterministic across runs', async () => {
    const out2 = join(tempDir(), 'out');
    await bowi(repo, '--local', '--json-only', '--out', out2);
    expect(comparablePlanJson(readPlan(out2))).toBe(comparablePlanJson(plan));
  });

  it('writes to ./.bowi/<repo>-<branch>/ by default and ignores its own output next time', async () => {
    const first = await bowi(repo, '--local', '--json-only', '--quiet');
    expect(first).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const dir = join(repo, '.bowi', 'repo-feature-email-verification');
    expect(existsSync(join(dir, 'review-plan.json'))).toBe(true);
    await bowi(repo, '--local', '--json-only', '--quiet');
    expect(readPlan(dir).files.map((f) => f.path)).toEqual(expectedChangedFiles);
  });
});

describe('bowi --local (with review.html)', () => {
  it('writes a self-contained review.html next to the plan', async () => {
    const repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    const out = join(tempDir(), 'out');
    const r = await bowi(repo, '--local', '--out', out);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/✓ Rendered {2}review\.html, \d+ KB/);
    const html = readFileSync(join(out, 'review.html'), 'utf8');
    expect(html).toContain('<title>feature/email-verification · Bowi review</title>');
    expect(html).toContain('id="bowi-plan"');
    expect(existsSync(join(out, 'review-plan.json'))).toBe(true);
  });
});

describe('bowi <github-pr-url>', () => {
  it('reviews a pull request through the GitHub source', async () => {
    const root = tempDir();
    const { remoteUrl, pr } = fakeServer(root);
    const cwd = tempDir();
    const github = { fetch: fakeApi(pr), apiBase: 'https://api.github.com', remoteUrl, token: '' };
    const cache = join(root, 'cache');
    const r = await bowiWith(
      { github },
      cwd,
      'https://github.com/acme/api/pull/7/files',
      '--cache-dir',
      cache,
      '--json-only',
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('✓ Resolved  PR #7 · head');
    expect(r.stderr).toContain('✓ Fetched   head and merge base from github.com/acme/api');
    const plan = readPlan(join(cwd, '.bowi', 'api-7'));
    expect(plan.source).toMatchObject({
      kind: 'github',
      repo: 'acme/api',
      prNumber: 7,
      title: 'Add email verification',
      linkedIssues: ['#12', 'acme/web#3'],
    });
    expect(plan.files.map((f) => f.path)).toEqual(expectedChangedFiles);
    expect(plan.groups.map((g) => g.kind)).toEqual(['feature', 'move', 'noise']);
    // No spinner escape codes when stderr is not a terminal.
    expect(r.stderr).not.toContain('\x1b');

    const again = await bowiWith(
      { github },
      cwd,
      'https://github.com/acme/api/pull/7',
      '--cache-dir',
      cache,
      '--json-only',
    );
    expect(again.stderr).toContain('✓ Fetched   both commits already cached');
  });

  it('exits 2 with a next step when GitHub cannot be reached', async () => {
    const r = await bowi(tempDir(), 'https://github.com/acme/api/pull/7');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Could not reach the GitHub API');
  });
});

describe('opening the report (CLI-5)', () => {
  it('opens review.html only for a terminal and without --no-open', async () => {
    const repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    const opened: string[] = [];
    const openFile = (p: string) => opened.push(p);
    await bowiWith({ openFile }, repo, '--local', '-q');
    expect(opened).toEqual([]);
    await bowiWith({ openFile, tty: true }, repo, '--local', '-q', '--no-open');
    expect(opened).toEqual([]);
    await bowiWith({ openFile, tty: true }, repo, '--local', '-q');
    expect(opened).toEqual([join(repo, '.bowi', 'repo-feature-email-verification', 'review.html')]);
  });
});

describe('bowi cache clear', () => {
  it('deletes the cache folder', async () => {
    const dir = join(tempDir(), 'cache');
    mkdirSync(join(dir, 'repos'), { recursive: true });
    const r = await bowi(tempDir(), 'cache', 'clear', '--cache-dir', dir);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`Cleared ${dir}`);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('bowi usage and errors', () => {
  it('exits 1 with a next step when given nothing to review', async () => {
    const r = await bowi(tempDir());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('bowi --local');
  });

  it('exits 1 for conflicting or malformed arguments', async () => {
    const url = 'https://github.com/o/r/pull/1';
    expect((await bowi(tempDir(), url, '--local')).code).toBe(1);
    expect((await bowi(tempDir(), 'https://example.com/x')).code).toBe(1);
    expect((await bowi(tempDir(), '--frobnicate')).code).toBe(1);
  });

  it('exits 2 outside a git repository', async () => {
    const r = await bowi(tempDir(), '--local');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Not inside a git repository');
  });

  it('prints help and version with exit 0', async () => {
    expect(await bowi(tempDir(), '--help')).toMatchObject({ code: 0 });
    expect((await bowi(tempDir(), '--version')).stdout.trim()).toBe('0.0.0');
  });
});
