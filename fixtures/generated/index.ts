/**
 * Fixtures generated from code (requirement.md §12.1 #2–#5). Each is a small NestJS-style
 * TypeScript repo (or Ruby for #5) with a base commit and one head commit.
 */

import type { FixtureSpec } from '../lib/git-repo.ts';

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const pad = (i: number) => String(i).padStart(2, '0');

/**
 * #2 hub-change: `Logger.log(message)` becomes `Logger.log(level, message)` and 20 modules in
 * different folders update their call; one unrelated invoicing feature also logs with the new
 * signature. The refactor and the feature must stay separate groups.
 */
export const hubChange: FixtureSpec = (() => {
  const logger = (newSig: boolean) =>
    [
      "export type Level = 'info' | 'warn' | 'error';",
      '',
      'export class Logger {',
      newSig ? '  log(level: Level, message: string): void {' : '  log(message: string): void {',
      newSig ? '    console.log(`[${level}] ${message}`);' : '    console.log(message);',
      '  }',
      '}',
      '',
    ].join('\n');
  const module = (i: number, newSig: boolean) =>
    [
      "import { Logger } from '../../logger';",
      '',
      `export class Module${pad(i)}Service {`,
      '  constructor(private readonly logger: Logger) {}',
      '',
      `  run${pad(i)}(input: number): number {`,
      `    const result = input * ${i};`,
      newSig
        ? `    this.logger.log('info', 'module ${i} ran');`
        : `    this.logger.log('module ${i} ran');`,
      '    return result;',
      '  }',
      '}',
      '',
    ].join('\n');
  const base: Record<string, string> = { 'src/logger.ts': logger(false) };
  const head: Record<string, string> = { 'src/logger.ts': logger(true) };
  for (const i of range(20)) {
    base[`src/modules/m${pad(i)}/m${pad(i)}.service.ts`] = module(i, false);
    head[`src/modules/m${pad(i)}/m${pad(i)}.service.ts`] = module(i, true);
  }
  base['src/billing/billing.module.ts'] = "export const BILLING = 'billing';\n";
  head['src/billing/tax.ts'] = [
    'export function computeTax(amount: number, rate: number): number {',
    '  return Math.round(amount * rate * 100) / 100;',
    '}',
    '',
  ].join('\n');
  head['src/billing/invoice.service.ts'] = [
    "import { Logger } from '../logger';",
    "import { computeTax } from './tax';",
    '',
    'export interface Invoice {',
    '  total: number;',
    '  tax: number;',
    '}',
    '',
    'export class InvoiceService {',
    '  constructor(private readonly logger: Logger) {}',
    '',
    '  createInvoice(amount: number): Invoice {',
    '    const tax = computeTax(amount, 0.2);',
    "    this.logger.log('info', 'invoice created');",
    '    return { total: amount + tax, tax };',
    '  }',
    '}',
    '',
  ].join('\n');
  head['test/invoice.service.spec.ts'] = [
    "import { InvoiceService } from '../src/billing/invoice.service';",
    '',
    "describe('InvoiceService', () => {",
    "  it('adds tax to the total', () => {",
    '    const service = new InvoiceService({ log: () => {} } as never);',
    '    expect(service.createInvoice(100).total).toBe(120);',
    '  });',
    '});',
    '',
  ].join('\n');
  return {
    name: 'hub-change',
    baseBranch: 'main',
    headBranch: 'feature/log-levels',
    base: [{ message: 'base', files: base }],
    head: [{ message: 'Add log levels and invoicing', files: head }],
  };
})();

/** #3 no-links: 8 unrelated small edits in different folders. */
export const noLinks: FixtureSpec = (() => {
  const areas = [
    'auth',
    'billing',
    'catalog',
    'search',
    'profile',
    'reports',
    'shipping',
    'support',
  ];
  const file = (area: string, value: number) =>
    [`export function ${area}Limit(): number {`, `  return ${value};`, '}', ''].join('\n');
  const base = Object.fromEntries(
    areas.map((a, i) => [`src/${a}/${a}.config.ts`.replace('.config', '.limits'), file(a, 10 + i)]),
  );
  const head = Object.fromEntries(
    areas.map((a, i) => [`src/${a}/${a}.config.ts`.replace('.config', '.limits'), file(a, 20 + i)]),
  );
  return {
    name: 'no-links',
    baseBranch: 'main',
    headBranch: 'chore/limits',
    base: [{ message: 'base', files: base }],
    head: [{ message: 'Raise limits', files: head }],
  };
})();

/** #4 rename-refactor: class `UserRepo` renamed to `UserRepository` across 10 files. */
export const renameRefactor: FixtureSpec = (() => {
  const repo = (name: string) =>
    [
      `export class ${name} {`,
      '  private readonly rows = new Map<string, { id: string; name: string }>();',
      '',
      '  find(id: string) {',
      '    return this.rows.get(id);',
      '  }',
      '}',
      '',
    ].join('\n');
  const consumer = (i: number, name: string) =>
    [
      `import { ${name} } from '../users/user.repo';`,
      '',
      `export class Feature${pad(i)} {`,
      `  constructor(private readonly users: ${name}) {}`,
      '',
      `  label${pad(i)}(id: string): string {`,
      `    return this.users.find(id)?.name ?? 'feature ${i}';`,
      '  }',
      '}',
      '',
    ].join('\n');
  const base: Record<string, string> = { 'src/users/user.repo.ts': repo('UserRepo') };
  const head: Record<string, string> = { 'src/users/user.repo.ts': repo('UserRepository') };
  for (const i of range(9)) {
    base[`src/features/feature${pad(i)}.ts`] = consumer(i, 'UserRepo');
    head[`src/features/feature${pad(i)}.ts`] = consumer(i, 'UserRepository');
  }
  return {
    name: 'rename-refactor',
    baseBranch: 'main',
    headBranch: 'refactor/user-repository',
    base: [{ message: 'base', files: base }],
    head: [{ message: 'Rename UserRepo to UserRepository', files: head }],
  };
})();

/** #5 unsupported-language: Ruby changes, which Bowi has no grammar for. */
export const unsupportedLanguage: FixtureSpec = {
  name: 'unsupported-language',
  baseBranch: 'main',
  headBranch: 'feature/ruby',
  base: [
    {
      message: 'base',
      files: {
        'app/models/order.rb': 'class Order\n  def total\n    items.sum(&:price)\n  end\nend\n',
        'app/services/checkout.rb':
          'class Checkout\n  def call(order)\n    order.total\n  end\nend\n',
        'config/routes.rb': 'Rails.application.routes.draw do\n  resources :orders\nend\n',
      },
    },
  ],
  head: [
    {
      message: 'Add discounts',
      files: {
        'app/models/order.rb':
          'class Order\n  def total\n    items.sum(&:price) - discount_amount\n  end\n\n  def discount_amount\n    0\n  end\nend\n',
        'app/services/checkout.rb':
          'class Checkout\n  def call(order)\n\n    order.total\n  end\nend\n',
        'config/routes.rb':
          'Rails.application.routes.draw do\n  resources :orders\n  resources :discounts\nend\n',
        'app/models/discount.rb':
          'class Discount\n  def apply_discount(total)\n    total\n  end\nend\n',
      },
    },
  ],
};
