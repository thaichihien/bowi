import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scratchRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '../src/index.ts';
import { csharp, java } from '../src/languages/index.ts';

const repos: string[] = [];
afterAll(() => repos.forEach((r) => rmSync(dirname(r), { recursive: true, force: true })));

async function plan(base: Record<string, string>, head: Record<string, string>) {
  const repo = scratchRepo(base, head);
  repos.push(repo);
  const ctx = createStageContext(DEFAULT_CONFIG, { warnings: [] });
  return analyze(await openLocalSnapshot({ cwd: repo }), ctx, { toolVersion: 'test' });
}

/** The step titles of the group holding `path`, and the group's reasons. */
function groupOf(p: ReviewPlan, path: string) {
  const file = p.files.find((f) => f.path === path)!;
  const hunk = p.hunks.find((h) => h.fileId === file.id && h.kind === 'logic')!;
  return p.groups.find((g) => g.steps.some((s) => s.hunkIds.includes(hunk.id)))!;
}
const filesOf = (p: ReviewPlan, g: ReviewPlan['groups'][number]) =>
  [
    ...new Set(
      g.steps.flatMap((s) => s.hunkIds.map((id) => p.hunks.find((h) => h.id === id)!.fileId)),
    ),
  ]
    .map((id) => p.files.find((f) => f.id === id)!.path)
    .sort();

describe('Python (M15)', () => {
  const models = (extra: string) =>
    `from dataclasses import dataclass\n\n\n@dataclass\nclass User:\n    email: str\n${extra}`;
  const service = (body: string) =>
    `from .models import User\n\n\nclass UserService:\n    def __init__(self, repo):\n        self.repo = repo\n\n${body}`;
  const tests = (body: string) =>
    `from app.users.services import UserService\n\n\ndef test_find():\n    assert UserService(None)\n${body}`;
  const unrelated = (v: string) => `def bump(version):\n    return version + "${v}"\n`;

  it('links models, the service using them and its tests through imports', async () => {
    const p = await plan(
      {
        'app/users/models.py': models(''),
        'app/users/services.py': service(''),
        'tests/test_services.py': tests(''),
        'scripts/release.py': unrelated('-next'),
      },
      {
        'app/users/models.py': models('    verified: bool = False\n'),
        'app/users/services.py': service(
          '    def verify(self, user: User) -> None:\n        user.verified = True\n        self.repo.save(user)\n',
        ),
        'tests/test_services.py': tests(
          '\n\ndef test_verify():\n    service = UserService(None)\n    service.verify(None)\n',
        ),
        'scripts/release.py': unrelated('-rc'),
      },
    );
    const g = groupOf(p, 'app/users/services.py');
    expect(filesOf(p, g)).toEqual([
      'app/users/models.py',
      'app/users/services.py',
      'tests/test_services.py',
    ]);
    expect(g.steps.map((s) => s.title)).toEqual(['Data shape', 'Services', 'Tests']);
    expect(p.files.find((f) => f.path === 'app/users/models.py')!.language).toBe('python');
    expect(p.meta.languages).toContain('python');
  });

  it('reads a reformat by Black as formatting', async () => {
    const p = await plan(
      { 'app/config.py': "SETTINGS = {'debug': False, 'timeout': 30}\n" },
      { 'app/config.py': 'SETTINGS = {\n    "debug": False,\n    "timeout": 30,\n}\n' },
    );
    expect(p.hunks.map((h) => h.kind)).toEqual(['format']);
  });
});

describe('Go (M15)', () => {
  const server = (extra: string) =>
    `package auth\n\ntype Server struct {\n\tAddr string\n${extra}}\n`;
  const start = (body: string) =>
    `package auth\n\nimport "fmt"\n\nfunc (s *Server) Start() error {\n${body}\treturn nil\n}\n`;
  const main = (body: string) =>
    `package main\n\nimport "github.com/acme/app/internal/auth"\n\nfunc main() {\n\ts := &auth.Server{}\n${body}}\n`;

  it('links files of one package without imports, and importers through the package', async () => {
    const p = await plan(
      {
        'internal/auth/server.go': server(''),
        'internal/auth/start.go': start('\tfmt.Println(s.Addr)\n'),
        'cmd/app/main.go': main(''),
      },
      {
        'internal/auth/server.go': server('\tTLS  bool\n'),
        'internal/auth/start.go': start('\tfmt.Println(s.Addr, s.TLS)\n'),
        'cmd/app/main.go': main('\t_ = s.Start()\n'),
      },
    );
    const g = groupOf(p, 'internal/auth/start.go');
    expect(filesOf(p, g)).toEqual([
      'cmd/app/main.go',
      'internal/auth/server.go',
      'internal/auth/start.go',
    ]);
    expect(p.symbols.find((s) => s.qualifiedName === 'Server.Start')?.kind).toBe('method');
  });

  it('reads a gofmt run as formatting and go.sum as generated', async () => {
    const p = await plan(
      {
        'internal/auth/codes.go':
          'package auth\n\nvar codes = map[string]int{"ok":200,"missing":404}\n',
        'go.sum': 'example.com/a v1.0.0 h1:abc\n',
      },
      {
        'internal/auth/codes.go':
          'package auth\n\nvar codes = map[string]int{\n\t"ok":      200,\n\t"missing": 404,\n}\n',
        'go.sum': 'example.com/a v1.1.0 h1:def\n',
      },
    );
    const kindOf = (path: string) =>
      p.hunks.find((h) => h.fileId === p.files.find((f) => f.path === path)!.id)!.kind;
    expect(kindOf('internal/auth/codes.go')).toBe('format');
    expect(kindOf('go.sum')).toBe('generated');
  });
});

describe('Java (M16)', () => {
  const user = (extra: string) =>
    `package org.acme.users;\n\npublic class User {\n  private String email;\n${extra}}\n`;
  const service = (body: string) =>
    `package org.acme.users;\n\nimport java.util.Optional;\n\npublic class UserService {\n  private final UserRepository repo;\n\n  public UserService(UserRepository repo) {\n    this.repo = repo;\n  }\n\n  public Optional<User> find(String email) {\n    return repo.findByEmail(email);\n  }\n${body}}\n`;
  const repository = `package org.acme.users;\n\npublic interface UserRepository {\n  Optional<User> findByEmail(String email);\n}\n`;
  const test = (body: string) =>
    `package org.acme.users;\n\nimport org.junit.jupiter.api.Test;\n\nclass UserServiceTest {\n  @Test\n  void finds() {\n    new UserService(null).find("a");\n  }\n${body}}\n`;
  const controller = (body: string) =>
    `package org.acme.web;\n\nimport org.acme.users.UserService;\n\npublic class AccountController {\n  private final UserService users;\n\n  AccountController(UserService users) {\n    this.users = users;\n  }\n${body}}\n`;
  const unrelated = (v: string) =>
    `package org.acme.build;\n\nclass Version {\n  static String next() {\n    return "${v}";\n  }\n}\n`;

  it('links a package across source roots, and importers by class', async () => {
    const p = await plan(
      {
        'src/main/java/org/acme/users/User.java': user(''),
        'src/main/java/org/acme/users/UserService.java': service(''),
        'src/main/java/org/acme/users/UserRepository.java': repository,
        'src/test/java/org/acme/users/UserServiceTest.java': test(''),
        'src/main/java/org/acme/web/AccountController.java': controller(''),
        'src/main/java/org/acme/build/Version.java': unrelated('1.0'),
      },
      {
        'src/main/java/org/acme/users/User.java': user('  private boolean verified;\n'),
        'src/main/java/org/acme/users/UserService.java': service(
          '\n  public void verify(User user) {\n    user.setVerified(true);\n  }\n\n  public void verify(String email) {\n    find(email).ifPresent(this::verify);\n  }\n',
        ),
        'src/main/java/org/acme/users/UserRepository.java': repository,
        'src/test/java/org/acme/users/UserServiceTest.java': test(
          '\n  @Test\n  void verifies() {\n    new UserService(null).verify("a");\n  }\n',
        ),
        'src/main/java/org/acme/web/AccountController.java': controller(
          '\n  void confirm(String email) {\n    users.verify(email);\n  }\n',
        ),
        'src/main/java/org/acme/build/Version.java': unrelated('1.1'),
      },
    );
    const g = groupOf(p, 'src/main/java/org/acme/users/UserService.java');
    expect(filesOf(p, g)).toEqual([
      'src/main/java/org/acme/users/User.java',
      'src/main/java/org/acme/users/UserService.java',
      'src/main/java/org/acme/web/AccountController.java',
      'src/test/java/org/acme/users/UserServiceTest.java',
    ]);
    // Overloads stay apart; calls still reach them by name.
    expect(p.symbols.map((s) => s.qualifiedName)).toEqual(
      expect.arrayContaining(['UserService.verify(User)', 'UserService.verify(String)']),
    );
    // Foundations first: the entity, the service using it, its caller, then tests.
    expect(g.steps.map((s) => s.title)).toEqual([
      'User',
      'UserService',
      'AccountController',
      'Tests',
    ]);
    expect(p.meta.languages).toContain('java');
  });

  it('reads a reformat as formatting', async () => {
    const p = await plan(
      { 'src/main/java/a/Codes.java': 'package a;\nclass Codes { int[] all = {200,404}; }\n' },
      {
        'src/main/java/a/Codes.java':
          'package a;\n\nclass Codes {\n  int[] all = {\n    200, 404,\n  };\n}\n',
      },
    );
    expect(p.hunks.map((h) => h.kind)).toEqual(['format']);
  });
});

describe('Kotlin (M16)', () => {
  const util = (extra: string) =>
    `package netlib.internal\n\nfun String.toHostName(): String = lowercase()\n${extra}`;
  const call = (body: string) =>
    `package netlib\n\nimport netlib.internal.closeQuietly\n\nclass HttpCall(private val client: HttpClient) {\n  fun cancel() {\n    client.close()\n  }\n${body}}\n`;
  const unrelated = (v: string) => `package tools\n\nconst val VERSION = "${v}"\n`;

  it('links an import of a top-level function to its package', async () => {
    const p = await plan(
      {
        'netlib/src/main/kotlin/netlib/internal/-Util.kt': util(''),
        'netlib/src/main/kotlin/netlib/HttpCall.kt': call(''),
        'tools/src/main/kotlin/tools/Version.kt': unrelated('1'),
      },
      {
        'netlib/src/main/kotlin/netlib/internal/-Util.kt': util(
          '\nfun AutoCloseable.closeQuietly() {\n  try {\n    close()\n  } catch (e: Exception) {\n  }\n}\n',
        ),
        'netlib/src/main/kotlin/netlib/HttpCall.kt': call(
          '\n  fun release() {\n    client.closeQuietly()\n  }\n',
        ),
        'tools/src/main/kotlin/tools/Version.kt': unrelated('2'),
      },
    );
    const g = groupOf(p, 'netlib/src/main/kotlin/netlib/HttpCall.kt');
    expect(filesOf(p, g)).toEqual([
      'netlib/src/main/kotlin/netlib/HttpCall.kt',
      'netlib/src/main/kotlin/netlib/internal/-Util.kt',
    ]);
    expect(p.symbols.find((s) => s.qualifiedName === 'HttpCall.release')?.kind).toBe('method');
    expect(p.files[0]!.language).toBe('kotlin');
  });
});

describe('C# (M16)', () => {
  const entity = (extra: string) =>
    `namespace Acme.Core.Entities;\n\npublic class User\n{\n    public string Email { get; set; }\n${extra}}\n`;
  const service = (body: string) =>
    `using Acme.Core.Entities;\n\nnamespace Acme.Core.Services;\n\npublic partial class UserService : IUserService\n{\n    public User Find(string email) => null;\n${body}}\n`;
  const part = (body: string) =>
    `namespace Acme.Core.Services;\n\npublic partial class UserService\n{\n    private void Log(string text)\n    {\n    }\n${body}}\n`;
  const unrelated = (v: string) =>
    `namespace Acme.Build;\n\npublic static class Version\n{\n    public const string Value = "${v}";\n}\n`;

  it('links by namespace and using, across the parts of a partial class', async () => {
    const p = await plan(
      {
        'src/Core/Entities/User.cs': entity(''),
        'src/Core/Services/UserService.cs': service(''),
        'src/Core/Services/UserService.Logging.cs': part(''),
        'src/Build/Version.cs': unrelated('1'),
      },
      {
        'src/Core/Entities/User.cs': entity('    public bool EmailVerified { get; set; }\n'),
        'src/Core/Services/UserService.cs': service(
          '\n    public void Verify(User user)\n    {\n        user.EmailVerified = true;\n        LogVerified(user.Email);\n    }\n',
        ),
        'src/Core/Services/UserService.Logging.cs': part(
          '\n    private void LogVerified(string email)\n    {\n        Log(email);\n    }\n',
        ),
        'src/Build/Version.cs': unrelated('2'),
      },
    );
    const g = groupOf(p, 'src/Core/Services/UserService.cs');
    expect(filesOf(p, g)).toEqual([
      'src/Core/Entities/User.cs',
      'src/Core/Services/UserService.Logging.cs',
      'src/Core/Services/UserService.cs',
    ]);
    expect(p.symbols.find((s) => s.qualifiedName === 'User.EmailVerified')?.kind).toBe('method');
    expect(g.steps.map((s) => s.title)[0]).toBe('Data shape');
  });

  it('collapses EF Core designer files and auto-generated code', async () => {
    const p = await plan(
      {
        'src/Migrations/20240101_Init.Designer.cs': 'namespace M;\nclass A { }\n',
        'src/Client/Api.cs': '// <auto-generated />\nnamespace C;\nclass Api { }\n',
      },
      {
        'src/Migrations/20240101_Init.Designer.cs': 'namespace M;\nclass A { int x; }\n',
        'src/Client/Api.cs': '// <auto-generated />\nnamespace C;\nclass Api { int y; }\n',
      },
    );
    expect(p.hunks.map((h) => h.kind)).toEqual(['generated', 'generated']);
  });
});

describe('Java and C# families (M16)', () => {
  const file = (id: string, path: string) =>
    ({ id, path, status: 'modified' }) as ReviewPlan['files'][number];

  it('resolves Java and Kotlin imports by declared package, member and path', () => {
    const files = [
      file('f1', 'src/main/java/org/acme/User.java'),
      file('f2', 'lib/src/main/kotlin/netlib/internal/-Util.kt'),
      file('f3', 'legacy/org/acme/mail/Mailer.java'),
    ];
    const resolve = java.createImportResolver(
      files,
      new Map([
        ['f1', 'org.acme'],
        ['f2', 'netlib.internal'],
      ]),
    );
    expect(resolve('x.java', 'org.acme.User')).toBe('f1');
    expect(resolve('x.java', 'org.acme.User.Builder')).toBe('f1');
    expect(resolve('x.java', 'org.acme.mail.Mailer')).toBe('f3');
    expect(resolve('x.kt', 'netlib.internal.closeQuietly')).toBeUndefined();
    expect(java.packageImport!('netlib.internal.closeQuietly')).toBe('netlib.internal');
    expect(java.packageImport!('org.acme.*')).toBe('org.acme');
    expect(java.packageImport!('org.acme.User')).toBeUndefined();
  });

  it('pairs tests by name and blanks comments and strings', () => {
    expect(
      [
        'UserServiceTest',
        'UserServiceTests',
        'CacheIT',
        'ApiIntegrationTest',
        'Test',
        'Contest',
      ].map(java.testSubject),
    ).toEqual(['UserService', 'UserService', 'Cache', 'Api', 'Test', 'Contest']);
    expect(java.codeOnly('a("b(") /* c /* d */ e */ f // g\n"""\nh\n""" i')).toBe(
      'a("  ") ' + ' '.repeat(17) + ' f     \n"""\n \n""" i',
    );
    expect(csharp.codeOnly('a(@"b""c") $"{d}" // e')).toBe('a(@"    ") $"   "     ');
  });

  it('sees Java packages and imports, and C# enclosing namespaces and usings', () => {
    const facts = (text: string, family = java) => family.fileFacts(text);
    const use = (text: string, name: string, pkg: string, family = java) =>
      family.canUse!(facts(text, family), 'a', 'b', name, pkg);
    expect(use('package org.acme;\n', 'User', 'org.acme')).toBe(true);
    expect(use('package org.web;\nimport org.acme.User;\n', 'User', 'org.acme')).toBe(true);
    expect(use('package org.web;\nimport org.acme.*;\n', 'User', 'org.acme')).toBe(true);
    expect(use('package org.web;\n', 'User', 'org.acme')).toBe(false);
    expect(use('namespace Acme.Core.Services;\n', 'User', 'Acme.Core', csharp)).toBe(true);
    expect(
      use('using Acme.Core.Entities;\nnamespace Acme.Api;\n', 'User', 'Acme.Core.Entities', csharp),
    ).toBe(true);
    expect(use('namespace Acme.Api;\n', 'User', 'Acme.Core.Entities', csharp)).toBe(false);
  });
});

describe('links of Java, Kotlin and C# classes (M16)', () => {
  const edgesOf = (p: ReviewPlan, from: string, to: string) =>
    p.edges.filter(
      (e) =>
        p.symbols.find((s) => s.id === e.from)?.qualifiedName === from &&
        p.symbols.find((s) => s.id === e.to)?.qualifiedName === to,
    );

  it('links a method to the one it overrides', async () => {
    const api = (extra: string) =>
      `package org.acme.cluster;\n\npublic interface ClusterProvider {\n  void notify(String key);\n${extra}}\n`;
    const impl = (extra: string) =>
      `package org.acme.cluster.infinispan;\n\nimport org.acme.cluster.ClusterProvider;\n\nclass InfinispanClusterProvider implements ClusterProvider {\n  public void notify(String key) {\n    send(key);\n  }\n${extra}}\n`;
    const p = await plan(
      {
        'src/main/java/org/acme/cluster/ClusterProvider.java': api(''),
        'src/main/java/org/acme/cluster/infinispan/InfinispanClusterProvider.java': impl(''),
      },
      {
        'src/main/java/org/acme/cluster/ClusterProvider.java': api(
          '\n  void notify(String key, boolean local);\n',
        ),
        'src/main/java/org/acme/cluster/infinispan/InfinispanClusterProvider.java': impl(
          '\n  public void notify(String key, boolean local) {\n    if (!local) send(key);\n  }\n',
        ),
      },
    );
    const [edge] = edgesOf(
      p,
      'InfinispanClusterProvider.notify(String, boolean)',
      'ClusterProvider.notify(String, boolean)',
    );
    expect(edge?.evidence.text).toContain('overrides');
  });

  it('Java: a call reaches a method of another class only from a file naming the class', async () => {
    const finder = (name: string, body: string) =>
      `package org.acme.finders;\n\npublic class ${name} {\n  public String list(int page) {\n    return "${body}";\n  }\n}\n`;
    const caller = (body: string) =>
      `package org.acme.finders;\n\nclass Theme {\n  String render(Client client, PostFinder posts) {\n${body}  }\n}\n`;
    const p = await plan(
      {
        'src/main/java/org/acme/finders/PostFinder.java': finder('PostFinder', 'a'),
        'src/main/java/org/acme/finders/CommentFinder.java': finder('CommentFinder', 'a'),
        'src/main/java/org/acme/finders/Theme.java': caller('    return "";\n'),
      },
      {
        'src/main/java/org/acme/finders/PostFinder.java': finder('PostFinder', 'b'),
        'src/main/java/org/acme/finders/CommentFinder.java': finder('CommentFinder', 'b'),
        'src/main/java/org/acme/finders/Theme.java': caller(
          '    client.list(1);\n    return posts.list(1);\n',
        ),
      },
    );
    expect(edgesOf(p, 'Theme.render', 'PostFinder.list')).toHaveLength(1);
    expect(edgesOf(p, 'Theme.render', 'CommentFinder.list')).toHaveLength(0);
  });

  it('C#: added usings join the code changed in their file', async () => {
    const service = (usings: string, body: string) =>
      `using System;\n${usings}\nnamespace Acme.Api.Controllers;\n\npublic class AccountsController\n{\n    public void Get()\n    {\n    }\n\n    public void Post()\n    {\n${body}    }\n}\n`;
    const p = await plan(
      {
        'src/Api/Controllers/AccountsController.cs': service('', ''),
        'src/Api/Other.cs':
          'namespace Acme.Api;\n\npublic class Other\n{\n    public int A() => 1;\n}\n',
      },
      {
        'src/Api/Controllers/AccountsController.cs': service(
          'using Acme.Core.Services;\n',
          '        Console.WriteLine("posted");\n',
        ),
        'src/Api/Other.cs':
          'namespace Acme.Api;\n\npublic class Other\n{\n    public int A() => 2;\n}\n',
      },
    );
    const file = p.files.find((f) => f.path === 'src/Api/Controllers/AccountsController.cs')!;
    const hunks = p.hunks.filter((h) => h.fileId === file.id).map((h) => h.id);
    expect(hunks).toHaveLength(2);
    const groupOfHunk = (id: string) =>
      p.groups.find((g) => g.steps.some((s) => s.hunkIds.includes(id)))!.id;
    expect(groupOfHunk(hunks[0]!)).toBe(groupOfHunk(hunks[1]!));
  });
});
