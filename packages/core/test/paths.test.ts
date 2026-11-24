import { describe, expect, it } from 'vitest';
import { readingOrder, upBeforeDown } from '../src/paths.ts';

describe('a migration’s up before its down (owner, 2026-11-24)', () => {
  it('pairs up and down files, whatever the extension or naming', () => {
    const paths = [
      'hasura/migrations/default/1776_add_fields/down.sql',
      'hasura/migrations/default/1776_add_fields/up.sql',
      'migrations/0001_users.down.sql',
      'migrations/0001_users.up.sql',
      'db/V2_orders_UP.SQL',
      'db/V2_orders_DOWN.SQL',
      'src/setup.ts',
      'src/down.ts',
    ];
    expect([...upBeforeDown(paths)]).toEqual([
      [
        'hasura/migrations/default/1776_add_fields/up.sql',
        'hasura/migrations/default/1776_add_fields/down.sql',
      ],
      ['migrations/0001_users.up.sql', 'migrations/0001_users.down.sql'],
      ['db/V2_orders_UP.SQL', 'db/V2_orders_DOWN.SQL'],
    ]);
  });

  it('puts the up file right before its down, and leaves the rest in path order', () => {
    const paths = [
      'm/1/up.sql',
      'm/1/down.sql',
      'm/1/check.sql',
      'm/1/e.sql',
      'm/2/up.yaml',
      'm/0001_a.up.sql',
      'm/0001_a.down.sql',
    ];
    expect([...paths].sort(readingOrder(paths))).toEqual([
      'm/0001_a.up.sql',
      'm/0001_a.down.sql',
      'm/1/check.sql',
      'm/1/up.sql',
      'm/1/down.sql',
      'm/1/e.sql',
      'm/2/up.yaml',
    ]);
  });
});
