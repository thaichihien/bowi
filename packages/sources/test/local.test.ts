import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStageContext, DEFAULT_CONFIG, diffStage, SourceError, UsageError } from '@bowi/core';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { openLocalSnapshot } from '../src/local.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-local-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ctx = createStageContext(DEFAULT_CONFIG);
const sh = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim();

describe('openLocalSnapshot on the email-verification fixture', () => {
  let repo: string;
  beforeAll(() => {
    repo = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
  });

  it('resolves main as base and reports the head branch and commits', async () => {
    const snap = await openLocalSnapshot({ cwd: join(repo, 'src') });
    expect(snap.meta).toMatchObject({
      kind: 'local',
      repo: 'repo',
      baseRef: 'main',
      headRef: 'feature/email-verification',
    });
    expect(snap.meta.mergeBaseSha).toBe(snap.meta.baseSha);
    expect(snap.meta.commits.map((c) => c.subject)).toEqual(
      emailVerification.head.map((c) => c.message),
    );
    expect(snap.meta.commits[0]).toEqual({
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      subject: emailVerification.head[0]!.message,
      author: { name: 'Bowi Fixtures' },
      authoredAt: '2026-01-05T10:00:00Z',
      committedAt: snap.meta.commits[0]!.authoredAt,
    });
    expect(snap.meta.uncommitted).toBeUndefined();
  });

  it('reads old and new file versions', async () => {
    const snap = await openLocalSnapshot({ cwd: repo });
    expect(await snap.readFile('old', 'src/utils/string.ts')).not.toContain('slugify');
    expect(await snap.readFile('new', 'src/utils/string.ts')).toContain('slugify');
    expect(await snap.readFile('old', 'src/migrations/1730_add_email_verified.ts')).toBeNull();
    expect(await snap.readFile('new', '../outside.ts')).toBeNull();
  });

  it('includes staged, unstaged and untracked changes but not ignored files, without touching the index', () => {
    // Uses a fresh copy because it edits the working tree.
    const dir = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    writeFileSync(join(dir, '.gitignore'), 'secret.env\n');
    writeFileSync(join(dir, 'secret.env'), 'TOKEN=1\n');
    writeFileSync(join(dir, 'src/new-untracked.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/utils/helpers.ts'), '// unstaged edit\n', { flag: 'a' });
    writeFileSync(join(dir, 'src/staged.ts'), 'export const b = 2;\n');
    sh(dir, 'add', 'src/staged.ts');
    const indexBefore = readFileSync(join(dir, '.git/index'));
    const statusBefore = sh(dir, 'status', '--porcelain');

    return (async () => {
      const { files } = await diffStage(await openLocalSnapshot({ cwd: dir }), ctx);
      const paths = files.map((f) => f.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          '.gitignore',
          'src/new-untracked.ts',
          'src/staged.ts',
          'src/utils/helpers.ts',
        ]),
      );
      expect(paths).not.toContain('secret.env');
      expect(files.find((f) => f.path === 'src/new-untracked.ts')!.status).toBe('added');
      expect((await openLocalSnapshot({ cwd: dir })).meta.uncommitted).toBe(true);

      const without = await diffStage(
        await openLocalSnapshot({ cwd: dir, includeUntracked: false }),
        ctx,
      );
      expect(without.files.map((f) => f.path)).not.toContain('src/new-untracked.ts');
      expect(without.files.map((f) => f.path)).toContain('src/staged.ts');

      const excluded = await diffStage(
        await openLocalSnapshot({
          cwd: dir,
          excludeUntracked: [join(dir, 'src/new-untracked.ts')],
        }),
        ctx,
      );
      expect(excluded.files.map((f) => f.path)).not.toContain('src/new-untracked.ts');

      expect(readFileSync(join(dir, '.git/index')).equals(indexBefore)).toBe(true);
      expect(sh(dir, 'status', '--porcelain')).toBe(statusBefore);
    })();
  });

  it('prefers origin/HEAD and accepts an explicit base', async () => {
    const dir = buildFixtureRepo(emailVerification, join(tempDir(), 'repo')).dir;
    const firstHead = emailVerification.head.length;
    sh(dir, 'update-ref', 'refs/remotes/origin/develop', `HEAD~${firstHead - 1}`);
    sh(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    const viaOrigin = await openLocalSnapshot({ cwd: dir });
    expect(viaOrigin.meta.baseRef).toBe('origin/develop');
    expect(viaOrigin.meta.commits).toHaveLength(firstHead - 1);

    const explicit = await openLocalSnapshot({ cwd: dir, base: 'main' });
    expect(explicit.meta.baseRef).toBe('main');
    await expect(openLocalSnapshot({ cwd: dir, base: 'nope' })).rejects.toBeInstanceOf(UsageError);
  });
});

describe('openLocalSnapshot errors', () => {
  it('fails with a SourceError outside a repository', async () => {
    await expect(openLocalSnapshot({ cwd: tempDir() })).rejects.toBeInstanceOf(SourceError);
  });

  it('fails with a UsageError when no base branch exists', async () => {
    const dir = tempDir();
    sh(dir, 'init', '-q', '-b', 'trunk');
    sh(dir, 'commit', '-q', '--allow-empty', '-m', 'x');
    await expect(openLocalSnapshot({ cwd: dir })).rejects.toBeInstanceOf(UsageError);
  });
});

describe('diff edge cases from real git output', () => {
  it('handles renames, deletions, mode changes, binary, symlinks, odd names and missing final newlines', async () => {
    const dir = tempDir();
    sh(dir, 'init', '-q', '-b', 'main');
    const body =
      Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
    writeFileSync(join(dir, 'moved.ts'), body);
    writeFileSync(join(dir, 'gone.ts'), 'export const gone = true;\n');
    writeFileSync(join(dir, 'run.sh'), 'echo hi\n');
    writeFileSync(join(dir, 'eol.txt'), 'last line\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'base');
    sh(dir, 'checkout', '-q', '-b', 'work');

    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib/moved.ts'), body.replace('v3 = 3', 'v3 = 33'));
    unlinkSync(join(dir, 'moved.ts'));
    unlinkSync(join(dir, 'gone.ts'));
    chmodSync(join(dir, 'run.sh'), 0o755);
    writeFileSync(join(dir, 'eol.txt'), 'last line');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    writeFileSync(join(dir, 'café "quoted".ts'), 'export {};\n');
    writeFileSync(join(dir, 'with space.ts'), 'export {};\n');
    symlinkSync('lib/moved.ts', join(dir, 'link.ts'));
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'work');

    const snap = await openLocalSnapshot({ cwd: dir });
    const { files, hunks } = await diffStage(snap, ctx);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

    expect(byPath['lib/moved.ts']).toMatchObject({
      status: 'renamed',
      oldPath: 'moved.ts',
      additions: 1,
      deletions: 1,
    });
    expect(byPath['gone.ts']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(byPath['run.sh']).toMatchObject({ status: 'mode', additions: 0, deletions: 0 });
    expect(byPath['logo.png']).toMatchObject({ status: 'binary' });
    expect(byPath['café "quoted".ts']).toMatchObject({ status: 'added' });
    expect(byPath['with space.ts']).toMatchObject({ status: 'added' });
    expect(byPath['link.ts']).toMatchObject({ status: 'added' });
    expect(await snap.readFile('new', 'link.ts')).toBe('lib/moved.ts');

    const eolHunk = hunks.find((h) => h.fileId === byPath['eol.txt']!.id)!;
    expect(eolHunk.lines.find((l) => l.kind === 'add')).toMatchObject({
      text: 'last line',
      noEol: true,
    });
    expect(hunks.filter((h) => h.fileId === byPath['logo.png']!.id)).toEqual([]);

    // IDs follow sorted paths.
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort());
    expect(files.map((f) => f.id)).toEqual(files.map((_, i) => `f${i}`));
  });
});
