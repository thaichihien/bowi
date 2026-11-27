import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scratchRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import {
  AiError,
  analyze,
  createStageContext,
  DEFAULT_CONFIG,
  type AiEnricher,
  type AiGroupInput,
  type AiOverviewInput,
  type ReviewPlan,
} from '../src/index.ts';

const repos: string[] = [];
afterAll(() => repos.forEach((r) => rmSync(dirname(r), { recursive: true, force: true })));

/** Two files per area, the service calling the rate, so each area is one group. */
const area = (a: string, v: number, extra = '') => ({
  [`src/${a}/${a}-rate.ts`]: `export function ${a}Rate(): number {\n${extra}  return ${v};\n}\n`,
  [`src/${a}/${a}.service.ts`]: `import { ${a}Rate } from './${a}-rate';\n\nexport function ${a}Total(x: number): number {\n  return x * ${a}Rate() + ${v};\n}\n`,
});
const BASE = {
  ...area('billing', 1),
  ...area('search', 1),
  ...area('users', 1),
  'src/utils/date.ts': 'export const a = {b:1}\n',
};
const HEAD = {
  ...area('billing', 2),
  ...area('search', 2),
  ...area('users', 2),
  'src/utils/date.ts': 'export const a = { b: 1 };\n',
};

async function plan(
  enricher: AiEnricher | undefined,
  options: { concurrency?: number; timeoutMs?: number; head?: Record<string, string> } = {},
): Promise<{ plan: ReviewPlan; warnings: string[] }> {
  const repo = scratchRepo(BASE, options.head ?? HEAD);
  repos.push(repo);
  const warnings: string[] = [];
  const ctx = createStageContext(DEFAULT_CONFIG, { warnings });
  const p = await analyze(await openLocalSnapshot({ cwd: repo }), ctx, {
    toolVersion: 'test',
    ...(enricher && {
      ai: {
        enricher,
        ...(options.concurrency && { concurrency: options.concurrency }),
        ...(options.timeoutMs && { timeoutMs: options.timeoutMs }),
      },
    }),
  });
  return { plan: p, warnings };
}

function fake(
  answer: (input: AiGroupInput) => unknown,
  overview: unknown = { overview: 'Changes how rates are computed in three areas.' },
) {
  const requests: AiGroupInput[] = [];
  const overviews: AiOverviewInput[] = [];
  const enricher: AiEnricher = {
    id: 'fake',
    describe: () => 'a fake model',
    group: async (input) => {
      requests.push(input);
      return { output: await answer(input), model: 'fake-model' };
    },
    overview: async (input) => {
      overviews.push(input);
      return { output: overview };
    },
  };
  return { enricher, requests, overviews };
}

const titled = (input: AiGroupInput) => ({
  title: `Change the ${input.hunks[0]!.path.split('/')[1]} rate.`,
  intent: 'Doubles the rate and uses it in the total.',
});

describe('AI enrichment (AI-1..6)', () => {
  it('uses valid titles and intents, writes an overview, and sends only logic hunks', async () => {
    const { enricher, requests, overviews } = fake(titled);
    const { plan: p, warnings } = await plan(enricher);
    expect(warnings).toEqual([]);

    expect(p.groups.map((g) => [g.id, g.kind, g.titleSource, g.title, g.intent])).toEqual([
      ['g1', 'fix', 'ai', 'Change the billing rate', 'Doubles the rate and uses it in the total.'],
      ['g2', 'fix', 'ai', 'Change the search rate', 'Doubles the rate and uses it in the total.'],
      ['g3', 'fix', 'ai', 'Change the users rate', 'Doubles the rate and uses it in the total.'],
      ['g4', 'noise', 'rule', 'Formatting', undefined],
    ]);
    expect(p.overview).toBe('Changes how rates are computed in three areas.');
    expect(p.meta.ai).toEqual({ enabled: true, provider: 'fake', model: 'fake-model' });

    // AI-4: one request per logic group, with their hunks only; noise is never sent.
    const sent = requests.flatMap((r) => r.hunks.map((h) => h.id)).sort();
    const logic = p.hunks.filter((h) => h.kind === 'logic').map((h) => h.id);
    expect(sent).toEqual(logic);
    const g1 = requests.find((r) => r.group.id === 'g1')!;
    expect(g1.hunks[0]!.lines).toEqual([
      ' export function billingRate(): number {',
      '-  return 1;',
      '+  return 2;',
      ' }',
    ]);
    expect(g1.pr).toMatchObject({ headRef: 'work', baseRef: 'main', commits: ['head'] });

    // The overview sees the AI titles; collapsed groups only by title.
    expect(overviews[0]!.groups.map((g) => g.title)).toEqual([
      'Change the billing rate',
      'Change the search rate',
      'Change the users rate',
    ]);
    expect(overviews[0]!.collapsed).toEqual(['Formatting']);
  });

  it('trims long hunks and leaves out unchanged lines far from a change', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};\n`).join('');
    const changed = Array.from({ length: 100 }, (_, i) => `  const w${i} = ${i};\n`).join('');
    const { enricher, requests } = fake(titled);
    await plan(enricher, {
      head: { ...HEAD, ...area('billing', 2, body + changed) },
    });
    const hunk = requests.find((r) => r.group.id === 'g1')!.hunks[0]!;
    expect(hunk.lines.length).toBe(80);
    expect(hunk.omittedLines).toBeGreaterThan(0);
    expect(hunk.lines.every((l) => /^[ +-]/.test(l) || l === '⋯')).toBe(true);
  });

  it('keeps the rule-based text for an answer that is invalid, fails or comes too late', async () => {
    const { plan: rules } = await plan(undefined);
    const { enricher } = fake((input) => {
      if (input.group.id === 'g1') return { title: 'x', intent: 'too short' };
      if (input.group.id === 'g2') throw new Error('connection reset');
      return new Promise(() => {}); // never answers
    });
    const { plan: p, warnings } = await plan(enricher, { timeoutMs: 50 });
    expect(p.groups.map((g) => [g.title, g.titleSource, g.intent])).toEqual(
      rules.groups.map((g) => [g.title, 'rule', undefined]),
    );
    expect(warnings).toEqual([
      'AI: group g1 kept its rule-based text (the answer was not valid: title: Too small: expected string to have >=3 characters)',
      'AI: group g2 kept its rule-based text (connection reset)',
      'AI: group g3 kept its rule-based text (no answer after 0 s)',
    ]);
  });

  it('stops asking after a fatal error', async () => {
    const { enricher, requests, overviews } = fake(() => {
      throw new AiError('Claude Code is not logged in.', { fatal: true, hint: 'Run `claude`.' });
    });
    const { plan: p, warnings } = await plan(enricher, { concurrency: 1 });
    expect(requests).toHaveLength(1);
    expect(overviews).toHaveLength(0);
    expect(warnings).toEqual([
      'AI enrichment stopped, rule-based titles kept: Claude Code is not logged in. Run `claude`.',
    ]);
    expect(p.groups.every((g) => g.titleSource === 'rule')).toBe(true);
    expect(p.meta.ai).toEqual({ enabled: true, provider: 'fake' });
  });

  it('changes nothing without an enricher (AI off)', async () => {
    const { plan: p } = await plan(undefined);
    expect(p.meta.ai).toEqual({ enabled: false });
    expect('overview' in p).toBe(false);
    expect(p.groups.every((g) => g.titleSource === 'rule' && g.intent === undefined)).toBe(true);
  });
});
