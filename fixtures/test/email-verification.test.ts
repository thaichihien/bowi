import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFixtureRepo } from '../lib/git-repo.ts';
import { emailVerification, expectedChangedFiles } from '../email-verification/index.ts';

const tempDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-fixture-'));
  tempDirs.push(dir);
  return join(dir, 'repo');
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('email-verification fixture', () => {
  it('builds with identical SHAs every time', () => {
    const a = buildFixtureRepo(emailVerification, freshDir());
    const b = buildFixtureRepo(emailVerification, freshDir());
    expect(a.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(b.baseSha).toBe(a.baseSha);
    expect(b.headSha).toBe(a.headSha);
  });

  it('changes exactly the 11 expected files between merge base and head', () => {
    const repo = buildFixtureRepo(emailVerification, freshDir());
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', `${repo.baseBranch}...${repo.headBranch}`],
      { cwd: repo.dir, encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    expect(changed).toEqual(expectedChangedFiles);
  });
});
