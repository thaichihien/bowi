import { describe, expect, it } from 'vitest';
import { languageForPath, parseSource } from '../src/index.ts';

const parse = (code: string, lang: Parameters<typeof parseSource>[0] = 'typescript') =>
  parseSource(lang, code);

describe('languageForPath', () => {
  it('maps extensions and leaves unknown files to tier 0', () => {
    expect(
      ['a.ts', 'b.d.ts', 'c.tsx', 'd.mjs', 'e.jsx', 'f.json', 'g.rb', 'Makefile', 'dir.ts/x'].map(
        languageForPath,
      ),
    ).toEqual([
      'typescript',
      'typescript',
      'tsx',
      'javascript',
      'javascript',
      'json',
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('symbols', () => {
  it('extracts nested, qualified symbols with decorators, exports and signatures', async () => {
    const src = await parse(
      [
        "import { x } from './x';", // 1
        '', // 2
        '@Injectable()', // 3
        'export class Svc {', // 4
        "  @Get('a')", // 5
        '  async run(id: string): Promise<void> {', // 6
        '    const local = 1;', // 7
        '  }', // 8
        '}', // 9
        'export const handler = (e: E) => e;', // 10
        'const LIMIT = 5;', // 11
        'export interface Shape { a: number }', // 12
        'type Id = string;', // 13
        'function helper() {}', // 14
      ].join('\n'),
    );
    expect(src.hasError).toBe(false);
    expect(
      src.symbols.map((s) => [
        s.qualifiedName,
        s.kind,
        s.startLine,
        s.endLine,
        s.exported,
        s.signature,
      ]),
    ).toEqual([
      ['Svc', 'class', 3, 9, true, '@Injectable() export class Svc'],
      ['Svc.run', 'method', 5, 8, false, "@Get('a') async run(id: string): Promise<void>"],
      ['handler', 'function', 10, 10, true, 'export const handler'],
      ['LIMIT', 'variable', 11, 11, false, 'const LIMIT'],
      ['Shape', 'interface', 12, 12, true, 'export interface Shape'],
      ['Id', 'type', 13, 13, false, 'type Id'],
      ['helper', 'function', 14, 14, false, 'function helper()'],
    ]);
    expect(src.symbols[1]!.parent).toBe(0);
  });

  it('names test blocks and hooks', async () => {
    const src = await parse(
      "describe('A', () => {\n  beforeEach(() => {});\n  it('works', () => {});\n});\n",
    );
    expect(src.symbols.map((s) => s.qualifiedName)).toEqual([
      "describe('A')",
      "describe('A').beforeEach()",
      "describe('A').it('works')",
    ]);
  });

  it('uses JSON keys up to two levels deep', async () => {
    const src = await parse(
      '{\n  "deps": {\n    "a": { "deep": 1 }\n  },\n  "name": "x"\n}\n',
      'json',
    );
    expect(src.symbols.map((s) => s.qualifiedName)).toEqual(['deps', 'deps.a', 'name']);
  });

  it('parses JavaScript and TSX', async () => {
    expect(
      (await parse('class A { m() {} }\nconst f = () => <div/>;', 'javascript')).symbols.map(
        (s) => s.qualifiedName,
      ),
    ).toEqual(['A', 'A.m', 'f']);
    expect(
      (await parse('export function C() { return <div className="x" />; }', 'tsx')).hasError,
    ).toBe(false);
  });

  it('reports syntax errors', async () => {
    expect((await parse('function (')).hasError).toBe(true);
  });
});

describe('references', () => {
  it('classifies uses and skips declared names', async () => {
    const src = await parse(
      "import { A } from './a';\nclass S { run(x: T) { this.m.send(x); new A(); f(); return { k: 1, x }; } }\n",
    );
    expect(src.imports).toEqual([{ source: './a', names: ['A'], line: 1 }]);
    const kinds = Object.fromEntries(src.references.map((r) => [r.name, r.kind]));
    expect(kinds).toMatchObject({
      S: 'declaration',
      run: 'declaration',
      T: 'type',
      m: 'member',
      send: 'call',
      A: 'new',
      f: 'call',
      k: 'key',
    });
  });
});

describe('fingerprints', () => {
  it('ignore whitespace, comments, semicolons, trailing commas and quote style', async () => {
    const a = await parse("const f=(a:number)=>g(a,'x')\n");
    const b = await parse('// note\nconst f = (a: number) =>\n  g(\n    a,\n    "x",\n  );\n');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.coverFingerprint(1, 1)).toBe(b.coverFingerprint(2, 6));
  });

  it('change when a semicolon changes how code parses', async () => {
    expect((await parse('const a = b\n(c)\n')).fingerprint).not.toBe(
      (await parse('const a = b;\n(c)\n')).fingerprint,
    );
  });

  it('change for real edits', async () => {
    expect((await parse('f(1)')).fingerprint).not.toBe((await parse('f(2)')).fingerprint);
  });

  it('mask the symbol name in the shape fingerprint', async () => {
    const [a] = (await parse('function one(x) { return x + 1; }')).symbols;
    const [b] = (await parse('function two(x) { return x + 1; }')).symbols;
    expect(a!.fingerprint).not.toBe(b!.fingerprint);
    expect(a!.shapeFingerprint).toBe(b!.shapeFingerprint);
  });

  it('know which lines hold code', async () => {
    const src = await parse(
      'const a = 1;\n\n// comment\n/* block\n   comment */\nconst b = `x\ny`;\n',
    );
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => src.isCodeLine(n))).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});
