/**
 * git commands behind the Snapshot's history and search methods (GRAPH-6, GRAPH-7, GRAPH-11),
 * shared by the local and GitHub sources. Like DIFF_FLAGS, the flags here pin the output so the
 * user's git config (grep.column, blame.ignoreRevsFile, …) cannot change or break it.
 */

import type { GrepMatch } from '@bowi/core';

const GREP_CONFIG = [
  '-c',
  'grep.lineNumber=false',
  '-c',
  'grep.column=false',
  '-c',
  'grep.fullName=false',
  '-c',
  'grep.extendedRegexp=false',
  '-c',
  'grep.patternType=basic',
  '-c',
  'grep.fallbackToNoIndex=false',
  '-c',
  'color.grep=never',
];
/** Longer lines are minified or data, never a readable reference. */
const MAX_LINE = 1000;

/**
 * `git grep` for whole words in files with the given extensions: the working tree (with
 * untracked files) when `rev` is undefined, else that commit's tree.
 */
export function grepArgs(
  words: string[],
  extensions: string[],
  rev: string | undefined,
  excludes: string[] = [],
): string[] {
  return [
    ...GREP_CONFIG,
    'grep',
    '-n',
    '-I',
    '-w',
    '-F',
    '-z',
    '--full-name',
    '--no-color',
    ...words.flatMap((w) => ['-e', w]),
    ...(rev ? [rev] : ['--untracked']),
    '--',
    ...extensions.map((e) => `:(top,glob)**/*${e}`),
    ':(top,glob,exclude)**/node_modules/**',
    ...excludes.map((p) => `:(top,literal,exclude)${p}`),
  ];
}

/** Parses `git grep -n -z` output (`path\0line\0text`, path prefixed `rev:` for a tree). */
export function parseGrep(stdout: string, rev?: string): GrepMatch[] {
  const prefix = rev ? `${rev}:` : '';
  const out: GrepMatch[] = [];
  for (const record of stdout.split('\n')) {
    if (!record) continue;
    const a = record.indexOf('\0');
    const b = record.indexOf('\0', a + 1);
    if (a < 0 || b < 0) continue;
    // A working-tree file checked out with CRLF (Windows) keeps its `\r` in git grep's output.
    const raw = record.slice(b + 1);
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text.length > MAX_LINE) continue;
    let path = record.slice(0, a);
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
    out.push({ path, line: Number(record.slice(a + 1, b)), text });
  }
  return out;
}

export const BLAME_CONFIG = [
  '-c',
  'blame.ignoreRevsFile=',
  '-c',
  'blame.markUnblamableLines=false',
];

/**
 * SHA per final line from `git blame --porcelain`. Lines from the range's boundary (the merge
 * base or older) and lines not committed yet (all-zero SHA) are null.
 */
export function parseBlame(stdout: string): (string | null)[] {
  const shaOfLine: string[] = [];
  const boundary = new Set<string>();
  let current = '';
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (m) {
      current = m[1]!;
      shaOfLine[Number(m[2]) - 1] = current;
    } else if (line === 'boundary') boundary.add(current);
  }
  return Array.from(shaOfLine, (sha) =>
    !sha || boundary.has(sha) || /^0+$/.test(sha) ? null : sha,
  );
}

/** `git log` arguments listing the paths each non-merge commit changed, newest first. */
export function historyArgs(rev: string, limit: number): string[] {
  return [
    'log',
    '--no-show-signature',
    '--no-merges',
    '--no-renames',
    `--max-count=${limit}`,
    '--format=%x1e',
    '--name-only',
    rev,
    '--',
  ];
}

export function parseHistory(stdout: string): string[][] {
  return stdout
    .split('\x1e')
    .slice(1)
    .map((record) => record.split('\n').filter(Boolean));
}
