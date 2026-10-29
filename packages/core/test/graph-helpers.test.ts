import { describe, expect, it } from 'vitest';
import { createImportResolver } from '../src/graph/imports.ts';
import { literalsIn } from '../src/graph/literals.ts';
import { topoOrder } from '../src/group/steps.ts';
import {
  AnalysisError,
  assertPartition,
  type FileChange,
  type Group,
  type Hunk,
} from '../src/index.ts';

describe('topoOrder', () => {
  it('puts dependencies first and keeps ties in the given order', () => {
    const deps: Record<string, string[]> = {
      api: ['service'],
      service: ['data'],
      data: [],
      docs: [],
    };
    expect(topoOrder(['api', 'docs', 'service', 'data'], (n) => deps[n]!)).toEqual([
      'docs',
      'data',
      'service',
      'api',
    ]);
  });

  it('keeps a cycle together', () => {
    const deps: Record<string, string[]> = { a: ['b'], b: ['a'], c: [], d: ['a'] };
    expect(topoOrder(['d', 'c', 'a', 'b'], (n) => deps[n]!)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('literalsIn', () => {
  it('finds distinctive kebab and snake case literals', () => {
    expect(literalsIn("  @Column({ name: 'email_verified', default: false })")).toEqual([
      'email_verified',
    ]);
    expect(literalsIn('const link = `${url}/auth/verify-email?token=${t}`;')).toEqual([
      'verify-email',
    ]);
  });

  it('ignores imports, short tokens, dates and stoplisted words', () => {
    expect(literalsIn("import { x } from '@nestjs/common-utils';")).toEqual([]);
    expect(literalsIn("headers['Content-Type'] = 'a-b'; v = '2026-01-01'")).toEqual([]);
  });
});

describe('createImportResolver', () => {
  const files = ['src/mail/mail.service.ts', 'src/users/index.ts', 'src/a/b.tsx'].map(
    (path, i) => ({ id: `f${i}`, path }) as FileChange,
  );
  const resolve = createImportResolver(files);

  it('resolves relative specifiers with and without extensions', () => {
    expect(resolve('src/auth/auth.service.ts', '../mail/mail.service')).toBe('f0');
    expect(resolve('src/auth/auth.service.ts', '../mail/mail.service.js')).toBe('f0');
    expect(resolve('src/auth/auth.service.ts', '../users')).toBe('f1');
    expect(resolve('src/a/c.ts', './b')).toBe('f2');
    expect(resolve('src/auth/auth.service.ts', '../mail/other')).toBeUndefined();
  });

  it('matches path aliases by trailing segments, never bare packages', () => {
    expect(resolve('src/x.ts', '@/mail/mail.service')).toBe('f0');
    expect(resolve('src/x.ts', 'typeorm')).toBeUndefined();
  });
});

describe('assertPartition', () => {
  const hunks = [{ id: 'f0:h0' }, { id: 'f0:h1' }] as Hunk[];
  const group = (...hunkIds: string[][]) =>
    ({
      id: 'g',
      steps: hunkIds.map((ids, i) => ({ id: `g:${i}`, hunkIds: ids })),
    }) as unknown as Group;

  it('accepts every hunk exactly once', () => {
    expect(() => assertPartition([group(['f0:h0'], ['f0:h1'])], hunks)).not.toThrow();
  });

  it('rejects missing and duplicated hunks with exit code 3', () => {
    expect(() => assertPartition([group(['f0:h0'])], hunks)).toThrow(AnalysisError);
    expect(() => assertPartition([group(['f0:h0', 'f0:h1'], ['f0:h1'])], hunks)).toThrow(/both/);
    try {
      assertPartition([], hunks);
    } catch (e) {
      expect((e as AnalysisError).exitCode).toBe(3);
    }
  });
});
