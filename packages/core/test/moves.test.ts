import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scratchRepo } from '@bowi/fixtures';
import { openLocalSnapshot } from '@bowi/sources';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '../src/index.ts';

const repos: string[] = [];
afterAll(() => repos.forEach((r) => rmSync(join(r, '..'), { recursive: true, force: true })));

async function review(base: Record<string, string>, head: Record<string, string | null>) {
  const repo = scratchRepo(base, head);
  repos.push(repo);
  return analyze(await openLocalSnapshot({ cwd: repo }), createStageContext(DEFAULT_CONFIG), {
    toolVersion: 'test',
  });
}

const kinds = (plan: ReviewPlan, path: string) => {
  const id = plan.files.find((f) => f.path === path)!.id;
  return plan.hunks.filter((h) => h.fileId === id).map((h) => h.kind);
};

const fn = (name: string) =>
  `export function ${name}(items: number[]): number {\n  const total = items.reduce((s, x) => s + x, 0);\n  return total * 2;\n}\n`;

// Found by the benchmark on a real PR: such hunks were paired with themselves or with two partners,
// which put one hunk into a step twice and failed the run with exit code 3.
describe('moves that are not a pair of two hunks', () => {
  it('leaves code moved within one hunk as an ordinary change, never formatting', async () => {
    const plan = await review(
      {
        'src/menu.ts': `export type Position = { x: number };\nexport const gap = 4;\n${fn('place')}`,
      },
      {
        'src/menu.ts': `export const gap = 4;\nexport type Position = { x: number };\n${fn('place')}`,
      },
    );
    expect(kinds(plan, 'src/menu.ts')).toEqual(['logic']);
    expect(plan.hunks.every((h) => h.move === undefined)).toBe(true);
  });

  it('leaves one hunk moved into two files as ordinary changes', async () => {
    const plan = await review(
      { 'src/old.ts': `${fn('first')}${fn('second')}`, 'src/a.ts': '', 'src/b.ts': '' },
      { 'src/old.ts': '', 'src/a.ts': fn('first'), 'src/b.ts': fn('second') },
    );
    expect(kinds(plan, 'src/old.ts')).toEqual(['logic']);
    expect([...kinds(plan, 'src/a.ts'), ...kinds(plan, 'src/b.ts')]).toEqual(['logic', 'logic']);
  });

  it('still pairs a function moved alone from one file to another', async () => {
    const plan = await review(
      {
        'src/old.ts': `${fn('first')}export const keep = 1;\n`,
        'src/a.ts': 'export const a = 1;\n',
      },
      {
        'src/old.ts': 'export const keep = 1;\n',
        'src/a.ts': `export const a = 1;\n${fn('first')}`,
      },
    );
    expect(kinds(plan, 'src/old.ts')).toEqual(['move']);
    expect(kinds(plan, 'src/a.ts')).toEqual(['move']);
  });
});

describe('reordered lines', () => {
  it('are a real change, not formatting: order can change behavior', async () => {
    const app = (first: string, second: string) =>
      `import { app } from './app';\n\napp.use(${first});\napp.use(${second});\napp.listen(3000);\n`;
    const plan = await review(
      { 'src/main.ts': app('auth', 'cors') },
      { 'src/main.ts': app('cors', 'auth') },
    );
    expect(kinds(plan, 'src/main.ts')).toEqual(['logic']);
  });
});

describe('test code and changed test helpers', () => {
  it('links a new test to the test entity it imports, never application code to tests', async () => {
    const plan = await review(
      { 'src/repo.ts': 'export function save(x: object): object {\n  return x;\n}\n' },
      {
        // Application code that (wrongly) reaches into a test entity is not linked to it.
        'src/report.ts':
          "import { Order } from '../test/orders/entity/Order';\n\nexport function describeOrder(o: Order): string {\n  return String(o.total);\n}\n",
        'test/orders/entity/Order.ts': 'export class Order {\n  id = 0;\n  total = 0;\n}\n',
        'test/orders/orders.test.ts':
          "import { Order } from './entity/Order';\n\ndescribe('orders', () => {\n  it('keeps the total', () => {\n    const o = new Order();\n    expect(o.total).toBe(0);\n  });\n});\n",
      },
    );
    const name = (id: string) => plan.symbols.find((s) => s.id === id)!.qualifiedName;
    // The new describe block is one symbol: it creates an Order and reads its total.
    const toOrder = plan.edges.filter((e) => name(e.to) === 'Order');
    expect(toOrder.map((e) => [e.type, name(e.from)])).toEqual([
      ['calls', "describe('orders')"],
      ['uses-type', "describe('orders')"],
    ]);
  });
});
