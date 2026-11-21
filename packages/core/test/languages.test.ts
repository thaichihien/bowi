import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scratchRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '../src/index.ts';

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
