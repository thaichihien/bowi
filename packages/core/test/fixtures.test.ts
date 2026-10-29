import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildFixtureRepo,
  hubChange,
  noLinks,
  renameRefactor,
  unsupportedLanguage,
  type FixtureSpec,
} from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import {
  analyze,
  comparablePlanJson,
  createStageContext,
  DEFAULT_CONFIG,
  type ReviewPlan,
} from '../src/index.ts';

// requirement.md §12.1 fixtures #2–#5 (M3).
const tmp = mkdtempSync(join(tmpdir(), 'bowi-fx-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function planFor(spec: FixtureSpec): Promise<ReviewPlan> {
  // Same folder name every time: the plan records it as the repository name.
  const repo = buildFixtureRepo(spec, join(mkdtempSync(join(tmp, 'run-')), spec.name)).dir;
  return analyze(await openLocalSnapshot({ cwd: repo }), createStageContext(DEFAULT_CONFIG), {
    toolVersion: 'test',
  });
}

const pathsIn = (p: ReviewPlan, groupIndex: number) => {
  const byId = new Map(p.files.map((f) => [f.id, f.path]));
  return [
    ...new Set(
      p.groups[groupIndex]!.steps.flatMap((s) => s.hunkIds).map((id) =>
        byId.get(id.split(':')[0]!)!,
      ),
    ),
  ].sort();
};

describe('hub-change', () => {
  it('keeps the logger refactor and the unrelated feature apart', async () => {
    const p = await planFor(hubChange);
    expect(p.groups.map((g) => g.kind)).toEqual(['refactor', 'feature']);
    expect(pathsIn(p, 0)).toHaveLength(21);
    expect(pathsIn(p, 0)).toContain('src/logger.ts');
    expect(pathsIn(p, 1)).toEqual([
      'src/billing/invoice.service.ts',
      'src/billing/tax.ts',
      'test/invoice.service.spec.ts',
    ]);
    expect(p.groups[0]!.reasons).toEqual([
      '`Logger.log()` is called by 20 changed symbols, e.g. `Module01Service.run01()`',
    ]);
    // The feature uses the logger, so the logger group is read first.
    expect(p.groups[1]!.dependsOn).toEqual([p.groups[0]!.id]);
  });

  it('weakens edges into the hub', async () => {
    const p = await planFor(hubChange);
    const intoHub = p.edges.filter((e) => e.to.endsWith('#Logger.log'));
    expect(intoHub.length).toBe(21);
    expect(intoHub.every((e) => e.weight < DEFAULT_CONFIG.grouping.edgeThreshold)).toBe(true);
  });
});

describe('no-links', () => {
  it('makes one group instead of eight single-hunk groups', async () => {
    const p = await planFor(noLinks);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]!.steps.flatMap((s) => s.hunkIds)).toHaveLength(8);
    expect(p.groups[0]!.confidence).toBe('low');
    expect(p.groups[0]!.title).toBe('Raise limits'); // single commit: its subject
  });
});

describe('rename-refactor', () => {
  it('makes one refactor group', async () => {
    const p = await planFor(renameRefactor);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]!.kind).toBe('refactor');
    expect(pathsIn(p, 0)).toHaveLength(10);
    expect(p.symbols.find((s) => s.qualifiedName === 'UserRepository')!.change).toBe('renamed');
  });
});

describe('unsupported-language', () => {
  it('handles files without a grammar at tier 0', async () => {
    const p = await planFor(unsupportedLanguage);
    expect(p.files.every((f) => f.parseStatus === 'unsupported')).toBe(true);
    expect(p.symbols.every((s) => s.kind === 'file')).toBe(true);
    expect(p.groups.map((g) => g.kind)).toEqual(['mixed', 'noise']);
    expect(pathsIn(p, 1)).toEqual(['app/services/checkout.rb']);
  });
});

describe('all fixtures', () => {
  it.each([hubChange, noLinks, renameRefactor, unsupportedLanguage])(
    '$name is deterministic',
    async (spec) => {
      expect(comparablePlanJson(await planFor(spec))).toBe(comparablePlanJson(await planFor(spec)));
    },
  );
});
