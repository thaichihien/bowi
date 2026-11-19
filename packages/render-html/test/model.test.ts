import { describe, expect, it } from 'vitest';
import type { DiffLine } from '@bowi/core';
import {
  comparePaths,
  dayLabel,
  diffBlocks,
  formatTimestamp,
  initials,
  midSplit,
  relativeTime,
  splitRows,
} from '../ui/model.ts';

describe('middle cut of long names (M20)', () => {
  it('keeps the start and the extension of a name', () => {
    expect(midSplit('1730_add_email_verified.ts')).toEqual({
      a: '1730_add_email_ve',
      b: 'rified.ts',
    });
    // Short names are all "end": nothing to cut.
    expect(midSplit('README.md')).toEqual({ a: '', b: 'README.md' });
    expect(midSplit('Makefile')).toEqual({ a: '', b: 'Makefile' });
    // A long extension keeps a few characters before it.
    expect(midSplit('app.component.stories.tsx').b).toBe('tories.tsx');
  });

  it('keeps a short file name whole at the end of a path', () => {
    expect(midSplit('src/migrations/1730_add_email.ts')).toEqual({
      a: 'src/migrations/',
      b: '1730_add_email.ts',
    });
  });
});

describe('GitHub file order', () => {
  it('puts subfolders before files at every level, then sorts by name', () => {
    const paths = ['README.md', 'src/z.ts', 'src/a/b.ts', 'package.json', 'test/x.ts', 'src/a.ts'];
    expect(paths.sort(comparePaths)).toEqual([
      'src/a/b.ts',
      'src/a.ts',
      'src/z.ts',
      'test/x.ts',
      'README.md',
      'package.json',
    ]);
  });
});

describe('diffBlocks', () => {
  it('splits five squares by the share of added and deleted lines', () => {
    expect(diffBlocks(115, 25)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(diffBlocks(8, 0)).toEqual(['add', 'add', 'add', 'add', 'add']);
    expect(diffBlocks(1, 1)).toEqual(['add', 'del', 'none', 'none', 'none']);
    expect(diffBlocks(500, 1)).toEqual(['add', 'add', 'add', 'add', 'del']);
    expect(diffBlocks(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none']);
  });
});

describe('splitRows', () => {
  const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text });
  const view = (lines: DiffLine[]) =>
    splitRows(lines).map((r) => `${r.left?.text ?? '·'} | ${r.right?.text ?? '·'}`);

  it('pairs a run of deletions with the additions after it', () => {
    expect(
      view([
        line('context', 'a'),
        line('del', 'b1'),
        line('del', 'b2'),
        line('add', 'B1'),
        line('context', 'c'),
      ]),
    ).toEqual(['a | a', 'b1 | B1', 'b2 | ·', 'c | c']);
  });

  it('handles only additions, only deletions and more additions than deletions', () => {
    expect(view([line('add', 'x'), line('add', 'y')])).toEqual(['· | x', '· | y']);
    expect(view([line('del', 'x')])).toEqual(['x | ·']);
    expect(view([line('del', 'x'), line('add', 'X'), line('add', 'Y')])).toEqual([
      'x | X',
      '· | Y',
    ]);
  });
});

describe('times', () => {
  const now = Date.parse('2026-01-07T12:00:00Z');

  it('says how long ago, in words', () => {
    expect(relativeTime('2026-01-07T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-01-07T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-01-06T10:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-01-05T10:00:00+07:00', now)).toBe('2 days ago');
    expect(relativeTime('2025-03-01T00:00:00Z', now)).toBe('10 months ago');
    expect(relativeTime('not a date', now)).toBe('');
  });

  it('formats the exact time and the day in a time zone', () => {
    expect(formatTimestamp('2026-01-05T10:00:00Z', 'UTC')).toBe('Jan 5, 2026, 10:00 AM UTC');
    expect(formatTimestamp('2026-01-05T10:00:00Z', 'Asia/Ho_Chi_Minh')).toBe(
      'Jan 5, 2026, 5:00 PM GMT+7',
    );
    expect(dayLabel('2026-01-05T20:00:00Z', 'UTC')).toBe('Jan 5, 2026');
    expect(dayLabel('2026-01-05T20:00:00Z', 'Asia/Ho_Chi_Minh')).toBe('Jan 6, 2026');
  });

  it('makes initials for avatars', () => {
    expect(initials('Bowi Fixtures')).toBe('BF');
    expect(initials('octocat')).toBe('O');
    expect(initials('')).toBe('?');
  });
});
