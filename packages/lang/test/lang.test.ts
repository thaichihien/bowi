import { describe, expect, it } from 'vitest';
import { languageForPath, parseSource } from '../src/index.ts';

const parse = (code: string, lang: Parameters<typeof parseSource>[0] = 'typescript') =>
  parseSource(lang, code);

describe('languageForPath', () => {
  it('maps extensions and leaves unknown files to tier 0', () => {
    expect(
      [
        'a.ts',
        'b.d.ts',
        'c.tsx',
        'd.mjs',
        'e.jsx',
        'f.json',
        'ci.yml',
        'README.md',
        'g.rb',
        'Makefile',
        'dir.ts/x',
      ].map(languageForPath),
    ).toEqual([
      'typescript',
      'typescript',
      'tsx',
      'javascript',
      'javascript',
      'json',
      'yaml',
      'markdown',
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

  it('uses YAML keys up to two levels deep', async () => {
    const src = await parse(
      "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    steps:\n      - uses: x\n'quoted': 1\n",
      'yaml',
    );
    expect(src.hasError).toBe(false);
    expect(src.symbols.map((s) => [s.qualifiedName, s.startLine, s.endLine])).toEqual([
      ['name', 1, 1],
      ['on', 2, 4],
      ['on.push', 3, 4],
      ['jobs', 5, 8],
      ['jobs.build', 6, 8],
      ['quoted', 9, 9],
    ]);
  });

  it('makes Markdown sections symbols, nested by heading level', async () => {
    const src = await parse(
      '# Acme\n\nIntro.\n\n## Setup\n\nRun it.\n\n### Deeper\n\nText.\n',
      'markdown',
    );
    expect(
      src.symbols.map((s) => [s.qualifiedName, s.kind, s.startLine, s.endLine, s.signature]),
    ).toEqual([
      ['Acme', 'section', 1, 11, '# Acme'],
      ['Acme.Setup', 'section', 5, 11, '## Setup'],
      ['Acme.Setup.Deeper', 'section', 9, 11, '### Deeper'],
    ]);
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

describe('decorators and classes', () => {
  it('records decorator names, string arguments and targets', async () => {
    const src = await parse(
      [
        "@Controller('auth')", // 1
        'export class A extends B implements C, D<E> {', // 2
        "  constructor(private readonly s: Svc, @InjectQueue('mail') q: Queue<Job>) {}", // 3
        "  @Column({ name: 'x_y' }) x: string;", // 4
        "  @Get(':id') @UseGuards(G)", // 5
        '  get() {}', // 6
        '}', // 7
      ].join('\n'),
    );
    expect(src.decorators).toEqual([
      {
        name: 'Controller',
        args: ['auth'],
        refs: [],
        line: 1,
        target: { kind: 'class', name: 'A' },
      },
      {
        name: 'InjectQueue',
        args: ['mail'],
        refs: [],
        line: 3,
        target: { kind: 'parameter', name: 'q', className: 'A' },
      },
      {
        name: 'Column',
        args: ['x_y'],
        refs: [],
        line: 4,
        target: { kind: 'property', name: 'x', className: 'A' },
      },
      {
        name: 'Get',
        args: [':id'],
        refs: [],
        line: 5,
        target: { kind: 'method', name: 'get', className: 'A' },
      },
      {
        name: 'UseGuards',
        args: [],
        refs: ['G'],
        line: 5,
        target: { kind: 'method', name: 'get', className: 'A' },
      },
    ]);
    expect(src.classes).toEqual([
      {
        name: 'A',
        line: 2,
        extends: ['B'],
        implements: ['C', 'D'],
        constructorParams: [
          { name: 's', types: ['Svc'], line: 3 },
          { name: 'q', types: ['Queue', 'Job'], line: 3 },
        ],
      },
    ]);
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
  it('ignore whitespace, semicolons, trailing commas, quote style and comment layout', async () => {
    const a = await parse("// note  here\nconst f=(a:number)=>g(a,'x')\n");
    const b = await parse('// note here\nconst f = (a: number) =>\n  g(\n    a,\n    "x",\n  );\n');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.coverFingerprint(2, 2)).toBe(b.coverFingerprint(2, 6));
    const doc1 = await parse('/**\n * Returns the total.\n */\nexport const t = 1;\n');
    const doc2 = await parse('/** Returns  the total. */\nexport const t = 1;\n');
    expect(doc1.fingerprint).toBe(doc2.fingerprint);
  });

  it('change when comment text changes (an edited doc comment is not formatting)', async () => {
    expect((await parse('// retries once\nf();\n')).fingerprint).not.toBe(
      (await parse('// retries twice\nf();\n')).fingerprint,
    );
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

  it('ignore re-wrapped Markdown text but not edited text', async () => {
    const a = await parse('# A\n\nOne two\nthree.\n\n- item\n  more\n', 'markdown');
    const b = await parse('# A\n\nOne\ntwo three.\n\n- item more\n', 'markdown');
    const c = await parse('# A\n\nOne two\nfour.\n\n- item\n  more\n', 'markdown');
    const d = await parse('# A\n\nOne two\nthree.\n\n- item\n  less\n', 'markdown');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).not.toBe(d.fingerprint);
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => a.isContentLine(n))).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('know which lines hold content', async () => {
    const src = await parse(
      'const a = 1;\n\n// comment\n/* block\n   comment */\nconst b = `x\ny`;\n',
    );
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => src.isContentLine(n))).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});
