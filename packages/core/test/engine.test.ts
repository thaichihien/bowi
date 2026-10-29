import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scratchRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '../src/index.ts';

const repos: string[] = [];
afterAll(() => repos.forEach((r) => rmSync(dirname(r), { recursive: true, force: true })));

async function plan(
  base: Record<string, string>,
  head: Record<string, string | null>,
): Promise<ReviewPlan> {
  const repo = scratchRepo(base, head);
  repos.push(repo);
  const ctx = createStageContext(DEFAULT_CONFIG, { warnings: [] });
  return analyze(await openLocalSnapshot({ cwd: repo }), ctx, { toolVersion: 'test' });
}

const kinds = (p: ReviewPlan) => Object.fromEntries(p.hunks.map((h) => [h.id, h.kind]));
const symbolsOf = (p: ReviewPlan) =>
  p.symbols.map((s) => `${s.change} ${s.kind} ${s.qualifiedName}`);

describe('formatting-only detection', () => {
  it('separates a reformatted function from a real change in the same file', async () => {
    const base =
      'function a(x){return x+1}\n' + '\n'.repeat(8) + 'function b(y) {\n  return y * 2;\n}\n';
    const head =
      'function a(x) {\n  return x + 1;\n}\n' +
      '\n'.repeat(8) +
      'function b(y) {\n  return y * 3;\n}\n';
    const p = await plan({ 'src/m.ts': base }, { 'src/m.ts': head });
    expect(p.hunks.map((h) => [h.kind, h.header])).toEqual([
      ['format', ''],
      ['logic', 'b()'],
    ]);
    expect(symbolsOf(p)).toEqual(['body function b']);
  });

  it('treats blank-line edits as formatting but keeps comment text edits visible', async () => {
    const p = await plan(
      {
        'a.ts':
          'const a = 1;\n\n\nconst b = 2;\n' + '\n'.repeat(10) + '// retries once\nconst c = 3;\n',
      },
      {
        'a.ts':
          'const a = 1;\nconst b = 2;\n' + '\n'.repeat(10) + '// retries twice\nconst c = 3;\n',
      },
    );
    expect(p.hunks.map((h) => h.kind)).toEqual(['format', 'logic']);
  });

  it('keeps a semicolon that changes parsing as logic', async () => {
    const p = await plan({ 'a.ts': 'const a = b\n(c)\n' }, { 'a.ts': 'const a = b;\n(c)\n' });
    expect(Object.values(kinds(p))).toEqual(['logic']);
  });

  it('only counts blank-line changes as formatting in files without a grammar', async () => {
    const p = await plan(
      { 'a.rb': 'x = 1\n\n\ny = 2\n', 'b.py': 'def f():\n    return 1\n' },
      { 'a.rb': 'x = 1\ny = 2\n', 'b.py': 'def f():\n  return 1\n' },
    );
    expect(p.files.map((f) => [f.path, f.parseStatus])).toEqual([
      ['a.rb', 'unsupported'],
      ['b.py', 'unsupported'],
    ]);
    expect(Object.values(kinds(p))).toEqual(['format', 'logic']);
    expect(symbolsOf(p)).toEqual(['body file b.py']);
  });
});

describe('moves', () => {
  const fn = (name: string, extra = '') =>
    `export function ${name}(items: number[]) {\n  const out = [];\n  for (const i of items) {\n    out.push(i * 2);${extra}\n  }\n  return out;\n}\n`;

  it('marks an unchanged move as a pure move with similarity 1', async () => {
    const p = await plan(
      {
        'src/a.ts': `export const keep = 1;\n\n${fn('double')}`,
        'src/b.ts': 'export const other = 2;\n',
      },
      {
        'src/a.ts': 'export const keep = 1;\n',
        'src/b.ts': `export const other = 2;\n\n${fn('double')}`,
      },
    );
    const moved = p.hunks.filter((h) => h.kind === 'move');
    expect(moved).toHaveLength(2);
    expect(moved.map((h) => h.move)).toEqual([
      {
        fromFileId: 'f0',
        fromStart: 3,
        similarity: 1,
        changedLineIndexes: [],
        pairHunkId: moved[1]!.id,
      },
      {
        fromFileId: 'f0',
        fromStart: 3,
        similarity: 1,
        changedLineIndexes: [],
        pairHunkId: moved[0]!.id,
      },
    ]);
    expect(symbolsOf(p)).toEqual(['moved function double']);
    expect(p.stats.reviewLines).toBe(0);
  });

  it('keeps a move inside a hunk with other changes as logic', async () => {
    const p = await plan(
      { 'src/a.ts': fn('double'), 'src/b.ts': 'export const other = 2;\n' },
      {
        'src/a.ts': 'export const replacement = 3;\n',
        'src/b.ts': `export const other = 2;\n\n${fn('double')}`,
      },
    );
    expect(p.hunks.every((h) => h.kind === 'logic')).toBe(true);
  });

  it('does not match unrelated added and removed functions', async () => {
    const p = await plan(
      { 'src/a.ts': fn('double') },
      {
        'src/a.ts':
          'export function greet(name: string) {\n  const msg = `hi ${name}`;\n  console.log(msg);\n  return msg;\n}\n',
      },
    );
    expect(p.hunks.every((h) => h.kind === 'logic')).toBe(true);
  });
});

describe('symbols', () => {
  it('classifies added, deleted, signature, body and renamed symbols', async () => {
    const p = await plan(
      {
        'src/s.ts': [
          'export class S {',
          '  keep(a: number) {',
          '    return a;',
          '  }',
          '  sig(a: number) {',
          '    return a;',
          '  }',
          '  gone() {',
          '    return 0;',
          '  }',
          '}',
          'export function oldName(v: string) {',
          '  return v.trim().toLowerCase();',
          '}',
          '',
        ].join('\n'),
      },
      {
        'src/s.ts': [
          'export class S {',
          '  keep(a: number) {',
          '    return a + 1;',
          '  }',
          '  sig(a: number, b: number) {',
          '    return a;',
          '  }',
          '  fresh() {',
          '    return 1;',
          '  }',
          '}',
          'export function newName(v: string) {',
          '  return v.trim().toLowerCase();',
          '}',
          '',
        ].join('\n'),
      },
    );
    expect(symbolsOf(p).sort()).toEqual([
      'added method S.fresh',
      'body method S.keep',
      'deleted method S.gone',
      'renamed function newName',
      'signature method S.sig',
    ]);
    const sig = p.symbols.find((s) => s.qualifiedName === 'S.sig')!;
    expect([sig.oldSignature, sig.newSignature]).toEqual([
      'sig(a: number)',
      'sig(a: number, b: number)',
    ]);
  });

  it('does not report a reformatted symbol that shares a hunk with a real change', async () => {
    const p = await plan(
      { 'src/m.ts': 'function a() {\n  return 1;\n}\nfunction b(x:number){return x}\n' },
      { 'src/m.ts': 'function a() {\n  return 2;\n}\nfunction b(x: number) {\n  return x;\n}\n' },
    );
    expect(p.hunks.map((h) => h.kind)).toEqual(['logic']);
    expect(symbolsOf(p)).toEqual(['body function a']);
  });

  it('maps a new class to one symbol and imports to the file pseudo-symbol', async () => {
    const p = await plan(
      { 'src/x.ts': 'export {};\n' },
      { 'src/n.ts': "import { a } from './a';\n\nexport class N {\n  one() {}\n  two() {}\n}\n" },
    );
    expect(symbolsOf(p)).toEqual(['added file src/n.ts', 'added class N']);
  });

  it('falls back to text-only analysis with a warning on syntax errors', async () => {
    const p = await plan(
      { 'src/bad.ts': 'export const a = 1;\n' },
      { 'src/bad.ts': 'export const a = (;\n' },
    );
    expect(p.files[0]!.parseStatus).toBe('error');
    expect(p.meta.warnings).toEqual(['src/bad.ts has syntax errors; used text-only analysis']);
    expect(symbolsOf(p)).toEqual(['body file src/bad.ts']);
  });
});
