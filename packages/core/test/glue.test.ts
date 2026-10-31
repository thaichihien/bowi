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

const filler = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join('\n');

/** The group of each hunk of `path`, by hunk header. */
function groupsOf(p: ReviewPlan, path: string): string[] {
  const file = p.files.find((f) => f.path === path)!;
  return p.hunks
    .filter((h) => h.fileId === file.id)
    .map((h) => p.groups.find((g) => g.steps.some((s) => s.hunkIds.includes(h.id)))!.id);
}

describe('glue: imports and injected constructor parameters (§15 #57)', () => {
  // Two features: billing adds a field to `BillingRates`; search changes its tokenizer and
  // starts emitting events. The search service's constructor also takes `BillingRates` (an
  // unchanged parameter), which links the constructor to billing.
  const rates = (v: number) =>
    `export class BillingRates {\n${v === 2 ? "  readonly currency = 'EUR';\n" : ''}  rate(): number {\n    return ${v};\n  }\n}\n`;
  const tokenize = (sep: string) =>
    `export function tokenize(q: string): string[] {\n  return q.split('${sep}');\n}\n`;
  const billing = (v: number) =>
    `import { BillingRates } from './billing-rates';\n\nexport function billingTotal(r: BillingRates): number {\n  return r.rate() * ${v};\n}\n`;
  const search = (head: boolean) =>
    [
      "import { BillingRates } from '../billing/billing-rates';",
      "import { tokenize } from './tokenize';",
      ...(head ? ["import { EventEmitter } from 'node:events';"] : []),
      filler(8),
      'export class SearchService {',
      '  constructor(',
      '    private readonly rates: BillingRates,',
      ...(head ? ['    private readonly events: EventEmitter,'] : []),
      '  ) {}',
      filler(8),
      '  search(q: string): string[] {',
      ...(head ? ["    this.events.emit('search', q);"] : []),
      '    return tokenize(q);',
      '  }',
      '}',
      '',
    ].join('\n');

  it('puts the import and the constructor parameter with the code that uses them', async () => {
    const p = await plan(
      {
        'src/billing/billing-rates.ts': rates(1),
        'src/billing/billing.ts': billing(1),
        'src/search/search.service.ts': search(false),
        'src/search/tokenize.ts': tokenize(' '),
      },
      {
        'src/billing/billing-rates.ts': rates(2),
        'src/billing/billing.ts': billing(2),
        'src/search/search.service.ts': search(true),
        'src/search/tokenize.ts': tokenize(','),
      },
    );
    const searchGroups = groupsOf(p, 'src/search/search.service.ts');
    expect(searchGroups).toHaveLength(3); // import, constructor, method
    expect(new Set(searchGroups).size).toBe(1);
    expect(searchGroups[0]).not.toBe(groupsOf(p, 'src/billing/billing-rates.ts')[0]);
  });
});
