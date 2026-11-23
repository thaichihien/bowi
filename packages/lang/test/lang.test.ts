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

  it('names Markdown sections after what they belong to', async () => {
    // Headings listed without text between them share what follows; a sub-heading that
    // repeats its parent's name is not named twice.
    const src = await parse(
      '## API\n\n### ky.get(input)\n### ky.query(input)\n\nSets method.\n\n#### options\n\n##### hooks\n\n###### hooks.beforeRetry\n\nB.\n\n### ky.extend(defaults)\n\n#### options\n\nE.\n',
      'markdown',
    );
    expect(src.symbols.map((s) => s.qualifiedName)).toEqual([
      'API',
      'API.ky.get(input)',
      'API.ky.query(input)',
      'API.options',
      'API.options.hooks',
      'API.options.hooks.beforeRetry',
      'API.ky.extend(defaults)',
      'API.ky.extend(defaults).options',
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

describe('re-exports (§15 #11)', () => {
  it('parses `export type *`, keeping lines', async () => {
    const src = await parse("export type * from './a';\nexport function b() {}\n");
    expect(src.hasError).toBe(false);
    expect(src.imports.map((i) => i.source)).toEqual(['./a']);
    expect(src.symbols.find((s) => s.name === 'b')?.startLine).toBe(2);
  });

  it('counts re-exported names as uses, not their new names', async () => {
    const src = await parse(
      "export { a, b as c, type T } from './x';\nexport * as ns from './y';\n",
    );
    expect(src.references.map((r) => `${r.name}:${r.kind}`).sort()).toEqual([
      'T:name',
      'a:name',
      'b:name',
    ]);
    // Imports stay names of the import, not uses.
    expect((await parse("import { a } from './x';\n")).references).toEqual([]);
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

  it('see changes inside Markdown code blocks and HTML blocks', async () => {
    // The grammar keeps only punctuation as tokens there: the text itself must count.
    const doc = (code: string, html: string) =>
      `# A\n\n\`\`\`js\nky(url, {\n\tstatusCodes: ${code},\n\tlimit: 10\n});\n\`\`\`\n\n    indented ${code}\n\n<div>\n${html}\n</div>\n`;
    const base = await parse(doc('[413]', 'Hello'), 'markdown');
    const number = await parse(doc('[500]', 'Hello'), 'markdown');
    const html = await parse(doc('[413]', 'Bye'), 'markdown');
    const spacing = await parse(
      doc('[413]', 'Hello').replace('limit: 10', 'limit:   10'),
      'markdown',
    );
    expect(number.fingerprint).not.toBe(base.fingerprint);
    expect(number.coverFingerprint(4, 7)).not.toBe(base.coverFingerprint(4, 7));
    expect(html.fingerprint).not.toBe(base.fingerprint);
    expect(spacing.fingerprint).toBe(base.fingerprint);
    // A code line without punctuation is still a line with content.
    expect(base.isContentLine(6)).toBe(true);
  });

  it('know which lines hold code, not only comments', async () => {
    const src = await parse(
      '/**\n\tDoc text without a star.\n*/\nconst a = 1; // trailing\n// alone\nconst b = `x\ny`;\n',
    );
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => src.isCodeLine(n))).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
      true,
    ]);
  });
});

describe('Java, Kotlin and C# (M16)', () => {
  const symbolsOf = async (code: string, lang: Parameters<typeof parseSource>[0]) => {
    const src = await parse(code, lang);
    expect(src.hasError).toBe(false);
    return src.symbols.map((s) => `${s.kind} ${s.qualifiedName}${s.exported ? '' : ' (private)'}`);
  };

  it('maps .java, .kt, .kts and .cs', () => {
    expect(['A.java', 'B.kt', 'build.gradle.kts', 'C.cs'].map(languageForPath)).toEqual([
      'java',
      'kotlin',
      'kotlin',
      'csharp',
    ]);
  });

  it('Java: classes, members, overloads by parameter types, visibility', async () => {
    const code = [
      'package org.acme;',
      'public class UserService {',
      '  private final Repo repo;',
      '  public UserService(Repo repo) { this.repo = repo; }',
      '  public void save(java.util.List<User> users) {}',
      '  void save(User... users) {}',
      '  private void log() {}',
      '  enum State { ON }',
      '  record Point(int x) {}',
      '}',
      'interface Repo { User find(long id); }',
    ].join('\n');
    expect(await symbolsOf(code, 'java')).toEqual([
      'class UserService',
      'method UserService.UserService',
      'method UserService.save(List)',
      'method UserService.save(User[])',
      'method UserService.log (private)',
      'class UserService.State',
      'class UserService.Point',
      'interface Repo',
      'method Repo.find',
    ]);
    const src = await parse(code, 'java');
    expect(src.symbols.find((s) => s.qualifiedName === 'UserService.save(List)')!.name).toBe(
      'save',
    );
    expect(src.packageName).toBe('org.acme');
    expect(src.fields.map((f) => f.name)).toEqual(['repo', 'ON', 'x']);
    expect(src.classes[0]!.constructorParams).toEqual([{ name: 'repo', types: ['Repo'], line: 4 }]);
  });

  it('Java: imports, annotations and how names are used', async () => {
    const src = await parse(
      [
        'package a;',
        'import java.util.List;',
        'import static org.acme.Util.check;',
        'import org.acme.mail.*;',
        '@RestController',
        '@RequestMapping(value = "/users", produces = MediaType.JSON)',
        'class C extends Base implements Api {',
        '  @GetMapping("/{id}") User get(@PathVariable long id) { return repo.find(new Key(id)).user; }',
        '}',
      ].join('\n'),
      'java',
    );
    expect(src.imports.map((i) => [i.source, i.names])).toEqual([
      ['java.util.List', ['List']],
      ['org.acme.Util.check', ['check']],
      ['org.acme.mail.*', []],
    ]);
    expect(src.decorators.map((d) => [d.name, d.args, d.refs, d.target])).toEqual([
      ['RestController', [], [], { kind: 'class', name: 'C' }],
      ['RequestMapping', ['/users'], ['MediaType', 'JSON'], { kind: 'class', name: 'C' }],
      ['GetMapping', ['/{id}'], [], { kind: 'method', name: 'get', className: 'C' }],
      ['PathVariable', [], [], { kind: 'parameter', name: 'id', className: 'C' }],
    ]);
    expect(src.classes[0]).toMatchObject({ extends: ['Base'], implements: ['Api'] });
    const kind = (name: string) => src.references.find((r) => r.name === name)?.kind;
    expect([kind('find'), kind('Key'), kind('user'), kind('User'), kind('List')]).toEqual([
      'call',
      'new',
      'member',
      'type',
      undefined, // names in imports are not uses
    ]);
  });

  it('Kotlin: interfaces, objects, companion members, extensions, top-level names', async () => {
    const code = [
      'package netlib',
      '',
      'interface Dns {',
      '  fun lookup(host: String): List<String>',
      '}',
      '',
      'class HttpCall(private val client: HttpClient, timeout: Int) : Call, Base() {',
      '  fun execute(): Response = client.run()',
      '  fun execute(timeout: Long) {',
      '  }',
      '  private fun log() {',
      '  }',
      '  companion object {',
      '    fun create(c: HttpClient): HttpCall = HttpCall(c, 0)',
      '  }',
      '}',
      '',
      'object Util {',
      '  fun x() {',
      '  }',
      '}',
      '',
      'fun Socket.closeQuietly() {',
      '}',
      '',
      'fun Closeable.closeQuietly() {',
      '}',
      '',
      'const val MAX = 10',
    ].join('\n');
    expect(await symbolsOf(code, 'kotlin')).toEqual([
      'interface Dns',
      'method Dns.lookup',
      'class HttpCall',
      'method HttpCall.execute()',
      'method HttpCall.execute(Long)',
      'method HttpCall.log (private)',
      'method HttpCall.create',
      'class Util',
      'method Util.x',
      'function closeQuietly(this Socket)',
      'function closeQuietly(this Closeable)',
      'variable MAX',
    ]);
    const src = await parse(code, 'kotlin');
    expect(src.packageName).toBe('netlib');
    // `val` and `var` constructor parameters are properties; a plain one is not.
    expect(src.fields.map((f) => f.name)).toEqual(['client']);
    expect(src.classes.find((c) => c.name === 'HttpCall')).toMatchObject({
      extends: ['Base'],
      implements: ['Call'],
    });
    const uses = (name: string) =>
      src.references.filter((r) => r.name === name && r.kind !== 'declaration').map((r) => r.kind);
    expect([uses('run'), uses('HttpCall'), uses('Response')]).toEqual([
      ['call'],
      ['type', 'new'],
      ['type'],
    ]);
  });

  it('C#: types, properties as members, default visibility, usings, namespace', async () => {
    const code = [
      'using Acme.Core.Entities;',
      'using static Acme.Core.Utilities.CoreHelpers;',
      'using Alias = Acme.Core.Models.Data;',
      'namespace Acme.Core.Services',
      '{',
      '    [Authorize(Policy = "Admin")]',
      '    public class UserService(IUserRepository repo) : BaseService, IUserService',
      '    {',
      '        private readonly IMailService _mail;',
      '        public string Name { get; set; }',
      '        public Task SaveAsync(User user) => repo.SaveAsync(new User { Email = user.Email });',
      '        Task SaveAsync(Guid id) => null;',
      '    }',
      '    interface IUserService { Task SaveAsync(User user); }',
      '    enum Kind { A }',
      '}',
    ].join('\n');
    expect(await symbolsOf(code, 'csharp')).toEqual([
      'class UserService',
      'method UserService.Name',
      'method UserService.SaveAsync(User)',
      'method UserService.SaveAsync(Guid) (private)',
      'interface IUserService',
      'method IUserService.SaveAsync',
      'type Kind',
    ]);
    const src = await parse(code, 'csharp');
    expect(src.packageName).toBe('Acme.Core.Services');
    expect(src.imports.map((i) => [i.source, i.names])).toEqual([
      ['Acme.Core.Entities', []],
      ['Acme.Core.Utilities.CoreHelpers', []],
      ['Acme.Core.Models.Data', ['Alias']],
    ]);
    expect(src.classes[0]).toMatchObject({
      extends: ['BaseService'],
      implements: ['IUserService'],
      constructorParams: [{ name: 'repo', types: ['IUserRepository'] }],
    });
    expect(src.decorators.map((d) => [d.name, d.args, d.refs])).toEqual([
      ['Authorize', ['Admin'], []],
    ]);
    const kinds = (name: string) => [
      ...new Set(src.references.filter((r) => r.name === name).map((r) => r.kind)),
    ];
    expect(kinds('Email')).toEqual(['member']);
    expect(kinds('User')).toEqual(['type', 'new']);
    expect(kinds('SaveAsync')).toEqual(['declaration', 'call']);
    expect(kinds('IUserRepository')).toEqual(['type']);
  });

  it('formatting: a reformat keeps the fingerprint, a changed comment does not', async () => {
    const fp = async (code: string, lang: Parameters<typeof parseSource>[0]) =>
      (await parse(code, lang)).fingerprint;
    expect(await fp('class A { void f() { g(1,2); } }', 'java')).toBe(
      await fp('class A {\n  void f() {\n    g(1, 2);\n  }\n}\n', 'java'),
    );
    expect(await fp('class A {\n  // one\n}\n', 'java')).not.toBe(
      await fp('class A {\n  // two\n}\n', 'java'),
    );
    expect(await fp('fun f(a: Int, b: Int) {\n}\n', 'kotlin')).toBe(
      await fp('fun f(\n  a: Int,\n  b: Int,\n) {\n}\n', 'kotlin'),
    );
    expect(await fp('class A { void F() { G(); } }', 'csharp')).toBe(
      await fp('class A\n{\n    void F()\n    {\n        G();\n    }\n}\n', 'csharp'),
    );
  });
});

describe('Python decorators (M17)', () => {
  it('record what a decorator is called on, and strings in list arguments', async () => {
    const src = await parse(
      [
        '@bp.route("/orders", methods=["GET", "POST"])', // 1
        '@login_required', // 2
        'def orders():', // 3
        '    pass', // 4
      ].join('\n'),
      'python',
    );
    expect(src.decorators).toEqual([
      {
        name: 'route',
        args: ['/orders', 'GET', 'POST'],
        refs: [],
        line: 1,
        receiver: 'bp',
        target: { kind: 'other', name: 'orders' },
      },
      {
        name: 'login_required',
        args: [],
        refs: [],
        line: 2,
        target: { kind: 'other', name: 'orders' },
      },
    ]);
  });
});
