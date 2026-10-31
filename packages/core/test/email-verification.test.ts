import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import {
  analyze,
  comparablePlanJson,
  createStageContext,
  DEFAULT_CONFIG,
  type ReviewPlan,
} from '../src/index.ts';

// requirement.md §12.2: noise, symbol (M2) and grouping (M3) checks.
describe('email-verification fixture', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bowi-ev-'));
  let repo: string;
  let plan: ReviewPlan;
  const run = async () =>
    analyze(await openLocalSnapshot({ cwd: repo }), createStageContext(DEFAULT_CONFIG), {
      toolVersion: 'test',
    });

  beforeAll(async () => {
    repo = buildFixtureRepo(emailVerification, join(tmp, 'repo')).dir;
    plan = await run();
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const file = (path: string) => plan.files.find((f) => f.path === path)!;
  const hunksOf = (path: string) => plan.hunks.filter((h) => h.fileId === file(path).id);

  it('marks the lockfile generated and date.ts formatting-only', () => {
    expect(file('package-lock.json').generated).toBe(true);
    expect(hunksOf('package-lock.json').every((h) => h.kind === 'generated')).toBe(true);
    expect(hunksOf('src/utils/date.ts').map((h) => h.kind)).toEqual(['format']);
  });

  it('marks slugify as moved with exactly one changed line on each side', () => {
    const [from] = hunksOf('src/utils/helpers.ts');
    const [to] = hunksOf('src/utils/string.ts');
    expect([from!.kind, to!.kind]).toEqual(['move', 'move']);
    expect(from!.move!.pairHunkId).toBe(to!.id);
    expect(to!.move!.pairHunkId).toBe(from!.id);
    expect(to!.move!.changedLineIndexes).toHaveLength(1);
    expect(to!.lines[to!.move!.changedLineIndexes[0]!]!.text).toContain('[^\\w]+');
    expect(from!.lines[from!.move!.changedLineIndexes[0]!]!.text).toContain('[^a-z0-9]+');
    expect(to!.move!.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('keeps every other hunk as logic', () => {
    const noise = [
      'package-lock.json',
      'src/utils/date.ts',
      'src/utils/helpers.ts',
      'src/utils/string.ts',
    ];
    expect(
      plan.hunks
        .filter((h) => !noise.includes(plan.files.find((f) => f.id === h.fileId)!.path))
        .every((h) => h.kind === 'logic'),
    ).toBe(true);
  });

  it('finds the changed symbols with their change kinds and layers', () => {
    const s = (q: string) => plan.symbols.find((x) => x.qualifiedName === q);
    expect(s('AuthService.register')).toMatchObject({ change: 'body', layer: 'service' });
    expect(s('AuthService.verifyEmail')).toMatchObject({ change: 'added', layer: 'service' });
    expect(s('MailService.sendVerificationEmail')).toMatchObject({
      change: 'added',
      kind: 'method',
    });
    expect(s('AuthController.verifyEmail')).toMatchObject({ change: 'added', layer: 'api' });
    expect(s('User')).toMatchObject({ change: 'body', kind: 'class', layer: 'data' });
    expect(s('AddEmailVerified1730')).toMatchObject({ change: 'added', layer: 'schema' });
    expect(s('slugify')).toMatchObject({ change: 'moved' });
    expect(s('AuthService')).toBeUndefined(); // blank lines between methods do not touch the class
    expect(s('AuthService.login')).toBeUndefined();
  });

  it('gives every logic and move hunk at least one symbol, and noise none', () => {
    for (const h of plan.hunks) {
      if (h.kind === 'logic' || h.kind === 'move') expect(h.symbolIds.length).toBeGreaterThan(0);
      else expect(h.symbolIds).toEqual([]);
    }
    const ids = new Set(plan.symbols.map((s) => s.id));
    expect(plan.hunks.flatMap((h) => h.symbolIds).every((id) => ids.has(id))).toBe(true);
  });

  it('counts lines to review and noise', () => {
    expect(plan.stats.reviewLines + plan.stats.noiseLines).toBe(
      plan.stats.additions + plan.stats.deletions,
    );
    expect(plan.meta.languages).toEqual(['markdown', 'typescript']);
    expect(plan.meta.warnings).toEqual([]);
  });

  // requirement.md §12.2: grouping checks (M3).
  it('has exactly 3 groups: feature, moved code, noise', () => {
    expect(plan.groups.map((g) => g.kind)).toEqual(['feature', 'move', 'noise']);
    expect(plan.groups[0]!.confidence).toBe('high');
  });

  it('orders the feature steps data → service → api → test → docs', () => {
    const steps = plan.groups[0]!.steps;
    expect(steps.map((s) => s.title)).toEqual([
      'Data shape',
      'Services',
      'Auth controller',
      'Tests',
      'Docs',
    ]);
    const pathsOf = (i: number) => [
      ...new Set(
        steps[i]!.hunkIds.map((id) => plan.files.find((f) => id.startsWith(`${f.id}:`))!.path),
      ),
    ];
    expect(pathsOf(0).sort()).toEqual([
      'src/migrations/1730_add_email_verified.ts',
      'src/users/user.entity.ts',
    ]);
    // The mail service is used by the auth service, so it is read first.
    expect(pathsOf(1)).toEqual(['src/mail/mail.service.ts', 'src/auth/auth.service.ts']);
    expect(plan.groups[0]!.testsFirstStepOrder[0]).toBe(steps[3]!.id);
  });

  it('finds unchanged code using changed symbols, e.g. AuthService.login() using User (GRAPH-11)', () => {
    const user = plan.symbols.find((s) => s.qualifiedName === 'User')!;
    const refs = plan.outsideRefs.filter((r) => r.symbolId === user.id);
    expect(refs).toContainEqual({
      symbolId: user.id,
      fileId: file('src/auth/auth.service.ts').id,
      path: 'src/auth/auth.service.ts',
      line: 59, // inside login(), which the PR does not change
      excerpt: 'const user: User | null = await this.users.findByEmail(dto.email);',
    });
    expect(refs).toContainEqual(
      expect.objectContaining({ path: 'src/admin/admin-users.controller.ts', line: 18 }),
    );
    expect(refs.length).toBeLessThanOrEqual(DEFAULT_CONFIG.outsideRefs.maxPerSymbol);
    // Never a line the PR adds, never an import.
    const added = new Set(
      plan.hunks.flatMap((h) =>
        h.lines
          .filter((l) => l.kind === 'add')
          .map((l) => `${plan.files.find((f) => f.id === h.fileId)!.path}:${l.newNo}`),
      ),
    );
    expect(plan.outsideRefs.filter((r) => added.has(`${r.path}:${r.line}`))).toEqual([]);
    expect(plan.outsideRefs.filter((r) => r.excerpt.startsWith('import '))).toEqual([]);
  });

  it('records the reading order the report opens with (CLI-7)', () => {
    expect(plan.meta.order).toBe('dependency');
  });

  it('explains the feature group with the expected reasons', () => {
    const reasons = plan.groups[0]!.reasons;
    expect(reasons).toContain(
      '`AuthService.register()` calls `MailService.sendVerificationEmail()`',
    );
    expect(
      reasons.some(
        (r) =>
          r.includes('email_verified') &&
          r.includes('`User`') &&
          r.includes('AddEmailVerified1730'),
      ),
    ).toBe(true);
  });

  it('puts README.md in the feature group through a docs-mentions edge', () => {
    const readme = file('README.md').id;
    expect(
      plan.groups[0]!.steps.flatMap((s) => s.hunkIds).some((id) => id.startsWith(`${readme}:`)),
    ).toBe(true);
    expect(
      plan.edges.some(
        (e) => e.type === 'docs-mentions' && e.evidence.text.includes('verify-email'),
      ),
    ).toBe(true);
  });

  it('puts the slugify move and the noise in their own groups', () => {
    const [, moved, noise] = plan.groups;
    expect(moved!.steps.flatMap((s) => s.hunkIds).sort()).toEqual(
      [...hunksOf('src/utils/helpers.ts'), ...hunksOf('src/utils/string.ts')]
        .map((h) => h.id)
        .sort(),
    );
    expect(moved!.reasons[0]).toContain('1 line changed');
    expect(noise!.steps.map((s) => s.title)).toEqual(['Generated files', 'Formatting only']);
    expect(noise!.summary).toContain('package-lock.json: generated');
  });

  it('is deterministic', async () => {
    expect(comparablePlanJson(await run())).toBe(comparablePlanJson(plan));
  });
});
