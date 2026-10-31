import { describe, expect, it } from 'vitest';
import { createImportResolver } from '../src/graph/imports.ts';
import { literalsIn } from '../src/graph/literals.ts';
import { buildSteps, topoOrder } from '../src/group/steps.ts';
import {
  AnalysisError,
  assertPartition,
  type ChangeEdge,
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

describe('buildSteps', () => {
  const file = (id: string, path: string, layer: FileChange['layer']): FileChange => ({
    id,
    path,
    status: 'modified',
    parseStatus: 'ok',
    layer,
    additions: 1,
    deletions: 0,
    generated: false,
  });
  const hunk = (fileId: string): Hunk => ({
    id: `${fileId}:h0`,
    fileId,
    header: '',
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [],
    kind: 'logic',
    symbolIds: [`${fileId}#s`],
  });
  const calls = (from: string, to: string): ChangeEdge => ({
    from: `${from}#s`,
    to: `${to}#s`,
    type: 'calls',
    weight: 1,
    evidence: { text: '', locations: [] },
  });
  const steps = (files: FileChange[], edges: ChangeEdge[]) =>
    buildSteps(
      'g1',
      files.map((f) => hunk(f.id)),
      new Map(files.map((f) => [f.id, f])),
      edges,
    ).steps.map((s) => s.id);

  // workflow-orchestrator#90: services call a new helper whose layer used to come last.
  const service = file('f2', 'src/workflow/services/workflow-data.service.ts', 'service');
  const action = file('f0', 'src/action/common/to-failed.action.ts', 'unknown');
  const helper = file('f1', 'src/workflow/mark-failed.ts', 'unknown');

  it('reads a step before the steps that call it, whatever its layer (GRP-7)', () => {
    expect(steps([service, action, helper], [calls('f2', 'f1'), calls('f0', 'f1')])).toEqual([
      'g1:unknown',
      'g1:service',
    ]);
  });

  it('keeps the layer order without dependencies, or when steps use each other', () => {
    expect(steps([service, helper], [])).toEqual(['g1:service', 'g1:unknown']);
    expect(steps([service, helper], [calls('f2', 'f1'), calls('f1', 'f2')])).toEqual([
      'g1:service',
      'g1:unknown',
    ]);
  });

  it('puts helpers before services', () => {
    const util = file('f1', 'src/workflow/helpers/mark-failed.helper.ts', 'util');
    expect(steps([service, util], [])).toEqual(['g1:util', 'g1:service']);
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
