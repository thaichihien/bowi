import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scratchRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import { kindFor, ruleTitle, type GroupFacts } from '../src/group/describe.ts';
import {
  analyze,
  createStageContext,
  DEFAULT_CONFIG,
  type ChangedSymbol,
  type ChangeEdge,
  type ReviewPlan,
} from '../src/index.ts';

const repos: string[] = [];
afterAll(() => repos.forEach((r) => rmSync(dirname(r), { recursive: true, force: true })));

async function plan(base: Record<string, string>, head: Record<string, string>) {
  const repo = scratchRepo(base, head);
  repos.push(repo);
  const ctx = createStageContext(DEFAULT_CONFIG, { warnings: [] });
  return analyze(await openLocalSnapshot({ cwd: repo }), ctx, { toolVersion: 'test' });
}

/** The group holding the hunks of `path`. */
const groupOf = (p: ReviewPlan, path: string) => {
  const file = p.files.find((f) => f.path === path)!;
  const hunk = p.hunks.find((h) => h.fileId === file.id)!;
  return p.groups.find((g) => g.steps.some((s) => s.hunkIds.includes(hunk.id)))!;
};

describe('edits to doc comments only', () => {
  // JSDoc text without leading stars, as many projects write it; the code is unchanged.
  const hooks = (text: string) =>
    `/**\n\t${text}\n*/\nexport type Hooks = {\n\tbeforeRetry?: () => void;\n};\n`;
  const options = (text: string) =>
    `import type { Hooks } from './hooks';\n\nexport type Options = {\n\t/**\n\t${text}\n\t*/\n\thooks?: Hooks;\n};\n`;

  it('are read as documentation: a docs group with a Docs step', async () => {
    const p = await plan(
      {
        'src/types/hooks.ts': hooks('Hooks run around a request.'),
        'src/types/options.ts': options('Hooks to run.'),
      },
      {
        'src/types/hooks.ts': hooks('Hooks run around a request and its retries.'),
        'src/types/options.ts': options('Hooks to run, also before each retry.'),
      },
    );
    const g = groupOf(p, 'src/types/options.ts');
    expect(g.kind).toBe('docs');
    expect(g.steps.map((s) => [s.title, s.layer])).toEqual([['Docs', 'docs']]);
    // The files keep their own layer in the plan, and the edits stay real changes (§15 #10).
    expect(p.files.find((f) => f.path === 'src/types/options.ts')!.layer).toBe('data');
    expect(p.hunks.every((h) => h.kind === 'logic')).toBe(true);
  });

  it('are not mistaken for code when the same lines change code', async () => {
    const p = await plan(
      { 'src/types/hooks.ts': hooks('Hooks run around a request.') },
      {
        'src/types/hooks.ts': hooks('Hooks run around a request.').replace(
          'beforeRetry?: () => void;',
          'beforeRetry?: () => void; // and retries',
        ),
      },
    );
    expect(groupOf(p, 'src/types/hooks.ts').kind).not.toBe('docs');
  });
});

describe('titles and kinds', () => {
  const symbol = (
    id: string,
    over: Partial<ChangedSymbol> & Pick<ChangedSymbol, 'fileId' | 'layer'>,
  ): ChangedSymbol => ({
    id,
    name: id,
    qualifiedName: id,
    kind: 'function',
    change: 'added',
    hunkIds: [`${over.fileId}:h0`],
    ...over,
  });
  const calls = (from: string, to: string, weight = 1): ChangeEdge => ({
    from,
    to,
    type: 'calls',
    weight,
    evidence: { text: `${from} calls ${to}`, locations: [] },
  });
  const facts = (
    symbols: ChangedSymbol[],
    edges: ChangeEdge[],
    layers: string[],
    commentOnly: string[] = [],
  ): GroupFacts => ({
    cluster: { symbolIds: symbols.map((s) => s.id), origin: 'strong', attached: [] },
    symbols,
    hunks: [],
    edges,
    threshold: 0.5,
    fileLayers: new Set(layers),
    commentOnly: new Set(commentOnly),
  });
  const fileOf = (id: string) =>
    ({ f1: 'src/timing.ts', f2: 'src/client.ts', f3: 'test/retry.ts', f4: 'readme.md' })[id]!;

  it('name the code another file uses, over a busier private helper', () => {
    const s = [
      symbol('parseDate', { fileId: 'f1', layer: 'util' }),
      symbol('fromSeconds', { fileId: 'f1', layer: 'util' }),
      symbol('fromEpoch', { fileId: 'f1', layer: 'util' }),
      symbol('calculateDelay', { fileId: 'f1', layer: 'util' }),
      symbol('Client.delay', { fileId: 'f2', layer: 'service', change: 'body' }),
    ];
    const edges = [
      calls('fromSeconds', 'parseDate'),
      calls('fromEpoch', 'parseDate'),
      calls('calculateDelay', 'fromSeconds'),
      calls('calculateDelay', 'fromEpoch'),
      calls('Client.delay', 'calculateDelay'),
    ];
    expect(ruleTitle(facts(s, edges, ['util', 'service']), fileOf)).toBe(
      'New `calculateDelay()` and 4 related changes',
    );
  });

  it('name a group of tests after its test file, and call it tests even with its docs', () => {
    const s = [
      symbol('formatHttpTime', { fileId: 'f3', layer: 'test' }),
      symbol('formatAsctimeDate', { fileId: 'f3', layer: 'test' }),
      symbol("test('asctime')", { fileId: 'f3', layer: 'test' }),
      symbol('API.options.timeout', {
        fileId: 'f4',
        layer: 'docs',
        kind: 'section',
        change: 'body',
      }),
    ];
    const f = facts(
      s,
      [calls("test('asctime')", 'formatAsctimeDate'), calls('formatAsctimeDate', 'formatHttpTime')],
      ['test', 'docs'],
    );
    expect(ruleTitle(f, fileOf)).toBe('Tests in `test/retry.ts` and 1 related change');
    expect(kindFor(f)).toBe('test');
  });

  it('say "Docs of" for a symbol whose edits are all to its doc comment', () => {
    const s = [
      symbol('Hooks', { fileId: 'f1', layer: 'data', kind: 'type', change: 'body' }),
      symbol('Options', { fileId: 'f2', layer: 'data', kind: 'type', change: 'body' }),
    ];
    const f = facts(
      s,
      [{ ...calls('Options', 'Hooks'), type: 'uses-type' }],
      ['docs'],
      ['f1:h0', 'f2:h0'],
    );
    expect(ruleTitle(f, fileOf)).toBe('Docs of `Hooks` and 1 related change');
    expect(kindFor(f)).toBe('docs');
  });
});
