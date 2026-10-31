import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFixtureRepo, type FixtureSpec } from '@bowi/fixtures';
import { defaultPlugins } from '@bowi/plugins';
import { gitText } from '@bowi/sources';
import { adjustedRandIndex } from '../src/ari.ts';
import { BASELINES } from '../src/baselines.ts';
import { evaluateCase } from '../src/evaluate.ts';
import { caseSnapshot } from '../src/repo.ts';
import { verdict } from '../src/report.ts';
import { parseLog, qualifies, selectCases, type LogCommit } from '../src/select.ts';

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('adjustedRandIndex', () => {
  it('is 1 for the same partition, whatever the label names', () => {
    expect(adjustedRandIndex(['a', 'a', 'b', 'c'], ['x', 'x', 'y', 'z'])).toBe(1);
  });

  it('is 0 for one group against several commits', () => {
    expect(adjustedRandIndex(['a', 'a', 'b', 'b'], ['g', 'g', 'g', 'g'])).toBe(0);
  });

  it('matches the textbook value for a partial match', () => {
    // scikit-learn's adjusted_rand_score([0,0,0,1,1,1], [0,0,1,1,2,2]) = 0.2424…
    expect(
      adjustedRandIndex(['0', '0', '0', '1', '1', '1'], ['0', '0', '1', '1', '2', '2']),
    ).toBeCloseTo(0.24242424, 6);
  });

  it('is NaN with fewer than two items', () => {
    expect(adjustedRandIndex(['a'], ['b'])).toBeNaN();
  });
});

describe('baselines', () => {
  it('group by nothing, the top folder, or the file folder', () => {
    const paths = ['src/a/x.ts', 'src/b/y.ts', 'README.md'];
    expect(paths.map(BASELINES['one-group'])).toEqual(['all', 'all', 'all']);
    expect(paths.map(BASELINES['top-folder'])).toEqual(['src', 'src', '.']);
    expect(paths.map(BASELINES.folder)).toEqual(['src/a', 'src/b', '.']);
  });
});

describe('case selection', () => {
  const commit = (
    n: number,
    subject = `feat: change ${n}`,
    files = [`src/f${n}.ts`],
  ): LogCommit => ({
    sha: `c${n}`,
    parents: [`c${n - 1}`],
    subject,
    files,
  });

  it('keeps clean single-purpose commits with code', () => {
    expect(qualifies(commit(1))).toBe(true);
    expect(qualifies(commit(1, 'chore(deps): update dependency x to v2'))).toBe(false);
    expect(qualifies(commit(1, '4.13.14'))).toBe(false);
    expect(qualifies(commit(1, 'Revert "feat: x"'))).toBe(false);
    expect(qualifies(commit(1, 'docs: guide', ['docs/guide.md']))).toBe(false);
    expect(
      qualifies(
        commit(
          1,
          'feat: big',
          Array.from({ length: 21 }, (_, i) => `src/${i}.ts`),
        ),
      ),
    ).toBe(false);
    expect(qualifies({ ...commit(1), parents: ['a', 'b'] })).toBe(false);
  });

  it('cuts runs of consecutive commits into cases of 3, 4, 5, 6 commits, newest first', () => {
    // Newest first, as git log prints: c20 … c1; c12 is a release that breaks the run.
    const log = Array.from({ length: 20 }, (_, i) => 20 - i).map((n) =>
      n === 12 ? commit(n, 'v1.2.3') : commit(n),
    );
    const cases = selectCases(log, 'demo', 10);
    expect(cases.map((c) => [c.id, c.base, c.commits.map((x) => x.sha).join(' ')])).toEqual([
      ['demo-1', 'c17', 'c18 c19 c20'],
      ['demo-2', 'c13', 'c14 c15 c16 c17'],
      // c13 is left alone before the release; the next run starts at c11.
      ['demo-3', 'c6', 'c7 c8 c9 c10 c11'],
      ['demo-4', 'c0', 'c1 c2 c3 c4 c5 c6'],
    ]);
  });

  it('reads git log output', async () => {
    const repo = buildFixtureRepo(spec(), join(tempDir(), 'repo')).dir;
    const log = parseLog(
      await gitText(
        [
          'log',
          '--first-parent',
          '--format=%x1e%H %P%x1f%s',
          '--raw',
          '--no-abbrev',
          '--no-renames',
          'HEAD',
        ],
        { cwd: repo },
      ),
    );
    expect(log.map((c) => [c.subject, c.files, c.parents.length])).toEqual([
      ['feat: invoices', ['src/billing/invoice.ts', 'test/invoice.test.ts'], 1],
      ['feat: greeting', ['src/greet/greet.ts'], 1],
      ['feat: users', ['src/users/user.service.ts', 'src/users/user.ts'], 1],
      ['init', ['README.md', 'src/users/user.ts'], 0],
    ]);
  });
});

describe('evaluateCase', () => {
  it('labels every hunk with its commit and scores Bowi and the baselines', async () => {
    const repo = buildFixtureRepo(spec(), join(tempDir(), 'repo')).dir;
    const log = parseLog(
      await gitText(['log', '--format=%x1e%H %P%x1f%s', '--raw', '--no-abbrev', 'HEAD'], {
        cwd: repo,
      }),
    );
    const [c] = selectCases(log, 'demo', 1);
    expect(c!.commits.map((x) => x.subject)).toEqual([
      'feat: users',
      'feat: greeting',
      'feat: invoices',
    ]);

    const result = await evaluateCase(repo, c!, caseSnapshot(repo, 'demo', c!), defaultPlugins);
    expect(result).toMatchObject({ id: 'demo-1', commits: 3, files: 5, mixed: 0 });
    expect(result.hunks).toBe(5);
    // Three unrelated features in three folders: Bowi and grouping by folder both recover them.
    expect(result.all.bowi).toBe(1);
    expect(result.all['one-group']).toBe(0);
    expect(result.all['top-folder']).toBeLessThan(1); // src/ holds two of the features
    expect(result.language).toBe('TypeScript');
  });
});

describe('verdict', () => {
  const result = (bowi: number, folder: number) =>
    ({ all: { bowi, 'one-group': 0, 'top-folder': 0, folder }, code: {} }) as never;

  it('needs a clear margin over the better folder baseline in most cases', () => {
    expect(verdict([result(0.8, 0.5), result(0.7, 0.6), result(0.9, 0.4)])).toMatchObject({
      supported: true,
      baseline: 'folder',
      atLeast: 3,
    });
    expect(verdict([result(0.55, 0.5), result(0.6, 0.6)]).supported).toBe(false);
  });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bowi-bench-'));
  roots.push(d);
  return d;
}

/** Three unrelated features, one commit each; the users feature also edits a base file. */
function spec(): FixtureSpec {
  return {
    name: 'bench-demo',
    baseBranch: 'main',
    headBranch: 'work',
    base: [
      {
        message: 'init',
        files: {
          'README.md': '# demo\n',
          'src/users/user.ts': 'export interface User {\n  id: string;\n}\n',
        },
      },
    ],
    head: [
      {
        message: 'feat: users',
        files: {
          'src/users/user.ts': 'export interface User {\n  id: string;\n  email: string;\n}\n',
          'src/users/user.service.ts':
            "import type { User } from './user';\n\nexport function emailOf(u: User): string {\n  return u.email;\n}\n",
        },
      },
      {
        message: 'feat: greeting',
        files: {
          'src/greet/greet.ts':
            'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
        },
      },
      {
        message: 'feat: invoices',
        files: {
          'src/billing/invoice.ts':
            'export function total(lines: number[]): number {\n  return lines.reduce((s, x) => s + x, 0);\n}\n',
          'test/invoice.test.ts':
            "import { total } from '../src/billing/invoice';\n\nit('adds', () => {\n  expect(total([1, 2])).toBe(3);\n});\n",
        },
      },
    ],
  };
}
