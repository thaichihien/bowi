/**
 * Builds a deterministic git repository from a FixtureSpec.
 *
 * Input: a spec whose commits each point at a folder of files (full new contents of every file
 * the commit adds or changes) plus optional deletions. Output: a repo with `baseBranch` holding
 * the base commits and `headBranch` (checked out) adding the head commits on top.
 *
 * Determinism: author, committer, dates and timezone are fixed, and git runs without the user's
 * global/system config or hooks, so the same spec always yields the same commit SHAs.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface FixtureCommit {
  message: string;
  /** Folder (relative to the spec's `filesDir`) whose files are copied over the working tree. */
  dir?: string;
  /** Paths removed in this commit. */
  delete?: string[];
}

export interface FixtureSpec {
  name: string;
  /** Absolute folder containing each commit's `dir`. */
  filesDir: string;
  baseBranch: string;
  headBranch: string;
  base: FixtureCommit[];
  head: FixtureCommit[];
}

export interface BuiltFixture {
  dir: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
}

const FIRST_COMMIT_EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0) / 1000;

const GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.fileMode=true',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
];

function git(cwd: string, args: string[], date?: number): string {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Bowi Fixtures',
    GIT_AUTHOR_EMAIL: 'fixtures@bowi.invalid',
    GIT_COMMITTER_NAME: 'Bowi Fixtures',
    GIT_COMMITTER_EMAIL: 'fixtures@bowi.invalid',
    TZ: 'UTC',
  };
  if (date !== undefined) {
    env.GIT_AUTHOR_DATE = `@${date} +0000`;
    env.GIT_COMMITTER_DATE = `@${date} +0000`;
  }
  return execFileSync('git', [...GIT_CONFIG, ...args], { cwd, env, encoding: 'utf8' }).trim();
}

export function buildFixtureRepo(spec: FixtureSpec, targetDir: string): BuiltFixture {
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Fixture target ${targetDir} is not empty`);
  }
  mkdirSync(targetDir, { recursive: true });
  git(targetDir, ['init', '--quiet', '--initial-branch', spec.baseBranch]);

  let commitIndex = 0;
  const commit = (c: FixtureCommit) => {
    if (c.dir) cpSync(join(spec.filesDir, c.dir), targetDir, { recursive: true });
    for (const path of c.delete ?? []) rmSync(join(targetDir, path));
    git(targetDir, ['add', '--all']);
    git(
      targetDir,
      ['commit', '--quiet', '--allow-empty', '-m', c.message],
      FIRST_COMMIT_EPOCH + 3600 * commitIndex++,
    );
  };

  for (const c of spec.base) commit(c);
  const baseSha = git(targetDir, ['rev-parse', 'HEAD']);

  git(targetDir, ['checkout', '--quiet', '-b', spec.headBranch]);
  for (const c of spec.head) commit(c);
  const headSha = git(targetDir, ['rev-parse', 'HEAD']);

  return {
    dir: targetDir,
    baseBranch: spec.baseBranch,
    headBranch: spec.headBranch,
    baseSha,
    headSha,
  };
}
