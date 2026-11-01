import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SourceError } from '@bowi/core';
import { checkGit, parseGitVersion } from '../src/git.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-git-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A folder with a fake `git` that prints `output`, to put first on PATH. */
function fakeGit(output: string): string {
  const dir = tempDir();
  const file = join(dir, 'git');
  writeFileSync(file, `#!/bin/sh\necho '${output}'\n`);
  chmodSync(file, 0o755);
  return dir;
}

describe('git version', () => {
  it('parses the versions git prints', () => {
    expect(parseGitVersion('git version 2.48.1')).toEqual([2, 48]);
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39]);
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual([2, 45]);
    expect(parseGitVersion('hub version 2.14.2')).toBeNull();
  });

  it('accepts the installed git and 2.31', async () => {
    await expect(checkGit(tempDir())).resolves.toBeUndefined();
    await expect(
      checkGit(tempDir(), { PATH: fakeGit('git version 2.31.0') }),
    ).resolves.toBeUndefined();
  });

  it('rejects an old or missing git with a next step', async () => {
    const old = checkGit(tempDir(), { PATH: fakeGit('git version 2.30.9') });
    await expect(old).rejects.toBeInstanceOf(SourceError);
    await expect(old).rejects.toThrow('Bowi needs git 2.31 or newer; this is git version 2.30.9.');

    const missing = checkGit(tempDir(), { PATH: tempDir() });
    await expect(missing).rejects.toThrow('git is not installed or not on PATH.');
    await expect(missing).rejects.toMatchObject({ exitCode: 2 });
  });
});
