import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFixtureRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import { analyze, createStageContext, DEFAULT_CONFIG } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'bowi-history-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const fn = (name: string, body: string) =>
  `export function ${name}(): number {\n  return ${body};\n}\n`;

describe('history edges (GRAPH-6, GRAPH-7)', () => {
  it('links files changed together in base history and symbols changed in the same PR commit', async () => {
    const repo = buildFixtureRepo(
      {
        name: 'history',
        baseBranch: 'main',
        headBranch: 'work',
        base: [
          {
            message: 'init',
            files: {
              'src/a/alpha.ts': fn('alpha', '1'),
              'src/b/beta.ts': fn('beta', '1'),
              'src/c/gamma.ts': fn('gamma', '1'),
              'src/d/delta.ts': fn('delta', '1'),
            },
          },
          {
            message: 'two',
            files: { 'src/a/alpha.ts': fn('alpha', '2'), 'src/b/beta.ts': fn('beta', '2') },
          },
          {
            message: 'three',
            files: { 'src/a/alpha.ts': fn('alpha', '3'), 'src/b/beta.ts': fn('beta', '3') },
          },
          {
            message: 'four',
            files: {
              'src/a/alpha.ts': fn('alpha', '4'),
              'src/b/beta.ts': fn('beta', '4'),
              'src/c/gamma.ts': fn('gamma', '2'),
            },
          },
        ],
        head: [
          {
            message: 'feat: alpha and gamma',
            files: { 'src/a/alpha.ts': fn('alpha', '5'), 'src/c/gamma.ts': fn('gamma', '3') },
          },
          {
            message: 'feat: beta and delta',
            files: { 'src/b/beta.ts': fn('beta', '5'), 'src/d/delta.ts': fn('delta', '2') },
          },
        ],
      },
      join(tmp, 'repo'),
    ).dir;
    const plan = await analyze(
      await openLocalSnapshot({ cwd: repo }),
      createStageContext(DEFAULT_CONFIG),
      {
        toolVersion: 'test',
      },
    );
    const name = (id: string) => plan.symbols.find((s) => s.id === id)!.qualifiedName;
    const edges = plan.edges
      .filter((e) => e.type === 'same-commit' || e.type === 'co-change')
      .map((e) => [e.type, name(e.from), name(e.to), e.weight, e.evidence.text]);
    expect(edges).toEqual([
      [
        'co-change',
        'alpha',
        'beta',
        0.3,
        'src/a/alpha.ts and src/b/beta.ts changed together in 4 of the last 4 commits',
      ],
      [
        'same-commit',
        'alpha',
        'gamma',
        0.4,
        expect.stringMatching(
          /^`alpha\(\)` and `gamma\(\)` were changed in the same commit, [0-9a-f]{7} “feat: alpha and gamma”$/,
        ),
      ],
      ['same-commit', 'beta', 'delta', 0.4, expect.stringContaining('“feat: beta and delta”')],
    ]);
    // gamma and delta changed with alpha or beta only once in history: no co-change edge.
  });
});
