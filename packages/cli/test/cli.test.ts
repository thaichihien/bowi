import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comparablePlanJson, type ReviewPlan } from '@bowi/core';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { expectedChangedFiles } from '@bowi/fixtures/email-verification';
import { run, type CliIo } from '../src/index.ts';
import { fakeClaude } from '../../ai/test/fake-claude.ts';
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
    ...(extra.ai && { ai: extra.ai }),
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

  it('reads .bowi.json from the base side, never from the pull request itself', async () => {
    const root = tempDir();
    const { remoteUrl, pr } = fakeServer(root, {
      ...emailVerification,
      base: [
        ...emailVerification.base,
        {
          message: 'config',
          files: { '.bowi.json': '{"generated":["README.md"],"ai":{"enabled":true}}\n' },
        },
      ],
      head: [
        ...emailVerification.head,
        // A PR must not be able to hide its own code as generated noise.
        { message: 'hide', files: { '.bowi.json': '{"generated":["src/**"]}\n' } },
      ],
    });
    const cwd = tempDir();
    const github = { fetch: fakeApi(pr), apiBase: 'https://api.github.com', remoteUrl, token: '' };
    const r = await bowiWith(
      { github },
      cwd,
      'https://github.com/acme/api/pull/7',
      '--cache-dir',
      join(root, 'cache'),
      '--json-only',
    );
    expect(r.code).toBe(0);
    const plan = readPlan(join(cwd, '.bowi', 'api-7'));
    const generated = plan.files.filter((f) => f.generated).map((f) => f.path);
    expect(generated).toEqual(['README.md', 'package-lock.json']);
    // Nor can the repository turn AI on for the reviewer.
    expect(r.stderr).toContain('! .bowi.json: "ai" settings of the repository are ignored');
    expect(plan.meta.ai).toEqual({ enabled: false });
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

describe('configuration (CLI-7, CLI-9)', () => {
  let repo: string;
  beforeAll(() => {
    repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
  });

  it('reads .bowi.json at the repository root and warns about unknown settings', async () => {
    writeFileSync(
      join(repo, '.bowi.json'),
      JSON.stringify({ generated: ['README.md'], order: 'tests-first', colour: 'red' }),
    );
    const out = join(tempDir(), 'out');
    const r = await bowi(join(repo, 'src'), '--local', '--json-only', '--out', out);
    rmSync(join(repo, '.bowi.json'));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('! .bowi.json: unknown setting "colour" was ignored');
    const plan = readPlan(out);
    expect(plan.files.find((f) => f.path === 'README.md')!.generated).toBe(true);
    expect(plan.meta.order).toBe('tests-first');
  });

  it('takes --config and --order, the flag winning over the file', async () => {
    const config = join(tempDir(), 'custom.json');
    writeFileSync(
      config,
      JSON.stringify({ order: 'tests-first', outsideRefs: { maxPerSymbol: 0 } }),
    );
    const out = join(tempDir(), 'out');
    const r = await bowi(
      repo,
      '--local',
      '--json-only',
      '--out',
      out,
      '--config',
      config,
      '--order',
      'dependency',
    );
    expect(r.code).toBe(0);
    const plan = readPlan(out);
    expect(plan.meta.order).toBe('dependency');
    expect(plan.outsideRefs).toEqual([]);
  });

  it('exits 1 for an invalid or missing config file and a bad --order', async () => {
    const config = join(tempDir(), 'bad.json');
    writeFileSync(config, '{"grouping":{"edgeThreshold":"high"}}');
    const bad = await bowi(repo, '--local', '--json-only', '--config', config);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('has invalid settings: grouping.edgeThreshold');
    const missing = await bowi(repo, '--local', '--json-only', '--config', join(repo, 'nope.json'));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Cannot read the config file');
    expect((await bowi(repo, '--local', '--order', 'random')).code).toBe(1);
  });
});

describe('AI enrichment (CLI-8, AI-1)', () => {
  let repo: string;
  let claude: string;
  beforeAll(() => {
    repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    claude = fakeClaude(tempDir());
  });

  it('--ai titles the groups through Claude Code, says so first, and caches the answers', async () => {
    const cache = join(tempDir(), 'cache');
    const args = ['--local', '--json-only', '--ai', '--cache-dir', cache];
    const out = join(tempDir(), 'out');
    const r = await bowiWith({ ai: { command: claude } }, repo, ...args, '--out', out);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      '  AI is on: group diffs (no noise, no whole files) and the PR title and description go to Claude through Claude Code, with your Claude Code login.',
    );
    expect(r.stderr).toMatch(/✓ AI {8}1 of 1 groups titled · overview {2,}\d/);
    const plan = readPlan(out);
    expect(plan.groups.map((g) => [g.titleSource, g.title, g.intent])).toEqual([
      ['ai', 'AI title for g1', 'What these changes do together.'],
      ['rule', 'Move `slugify()` from helpers.ts to string.ts', undefined],
      ['rule', 'Generated files and formatting', undefined],
    ]);
    expect(plan.overview).toBe('The pull request as a whole, in a sentence.');
    expect(plan.meta.ai).toEqual({
      enabled: true,
      provider: 'claude-code',
      model: 'claude-test-1',
    });

    const again = await bowiWith({ ai: { command: claude } }, repo, ...args, '--out', out);
    expect(again.stderr).toContain('1 of 1 groups titled · overview · 2 from cache');
  });

  it('follows the config file, and --no-ai wins over it', async () => {
    const config = join(tempDir(), 'ai.json');
    writeFileSync(config, JSON.stringify({ ai: { enabled: true, effort: 'low' } }));
    const cache = join(tempDir(), 'cache');
    const base = ['--local', '--json-only', '--config', config, '--cache-dir', cache];
    const on = join(tempDir(), 'on');
    expect((await bowiWith({ ai: { command: claude } }, repo, ...base, '--out', on)).code).toBe(0);
    expect(readPlan(on).meta.ai).toMatchObject({ enabled: true, effort: 'low' });
    const off = join(tempDir(), 'off');
    const r = await bowiWith({ ai: { command: claude } }, repo, ...base, '--no-ai', '--out', off);
    expect(r.stderr).not.toContain('AI');
    expect(readPlan(off).meta.ai).toEqual({ enabled: false });
  });

  it('exits 1 with a next step when Claude Code is missing or the provider is not available', async () => {
    const missing = await bowiWith(
      { ai: { command: join(tempDir(), 'claude') } },
      repo,
      '--local',
      '--json-only',
      '--ai',
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('error: Claude Code is not installed');
    expect(missing.stderr).toContain('Install Claude Code');

    const config = join(tempDir(), 'ai.json');
    writeFileSync(config, JSON.stringify({ ai: { provider: 'openai' } }));
    const other = await bowi(repo, '--local', '--json-only', '--ai', '--config', config);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain('The AI provider "openai" is not available yet.');
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
