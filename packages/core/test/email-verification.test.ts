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

// requirement.md §12.2: noise and symbol checks (M2).
describe('email-verification fixture (M2)', () => {
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
    expect(plan.meta.languages).toEqual(['typescript']);
    expect(plan.meta.warnings).toEqual([]);
  });

  it('is deterministic', async () => {
    expect(comparablePlanJson(await run())).toBe(comparablePlanJson(plan));
  });
});
