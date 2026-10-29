/**
 * Generated-file detection (NOISE-1).
 *
 * A file is generated when its path matches a built-in or configured pattern, when
 * `.gitattributes` marks it `linguist-generated`, or when one of its first lines carries a
 * generator marker (see GENERATED_MARKER).
 */

import picomatch from 'picomatch';

/** Built-in patterns; they match at any depth (a monorepo has many lockfiles and dist/ folders). */
export const BUILTIN_GENERATED = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  '*.snap',
  '*.min.js',
  '*.min.css',
  'dist/**',
  '*.gen.ts',
  '*.generated.*',
];

// Split so that this file does not mark itself.
const GENERATED_MARKER = new RegExp(['@gener', 'ated\\b|DO NOT ', 'EDIT'].join(''));
const HEADER_LINES = 5;

export interface GeneratedMatcher {
  /** Why the path is generated ("matches *.snap", ".gitattributes linguist-generated"), or null. */
  byPath(path: string): string | null;
}

export function createGeneratedMatcher(
  configPatterns: string[],
  gitattributes: string | null,
): GeneratedMatcher {
  const opts = { dot: true };
  const builtin = BUILTIN_GENERATED.map((p) => ({ p, m: picomatch(`**/${p}`, opts) }));
  const configured = configPatterns.map((p) => ({ p, m: picomatch(p, opts) }));
  const attributes = parseGitattributes(gitattributes ?? '');

  return {
    byPath(path) {
      // .gitattributes: the last matching line wins, and can also un-mark a path.
      let attr: boolean | undefined;
      for (const a of attributes) if (a.match(path)) attr = a.generated;
      if (attr === false) return null;
      if (attr === true) return '.gitattributes linguist-generated';
      for (const { p, m } of [...configured, ...builtin]) if (m(path)) return `matches ${p}`;
      return null;
    },
  };
}

export function hasGeneratedHeader(text: string): boolean {
  let end = 0;
  for (let i = 0; i < HEADER_LINES && end !== -1; i++) end = text.indexOf('\n', end + 1);
  return GENERATED_MARKER.test(end === -1 ? text : text.slice(0, end));
}

interface AttributeRule {
  match: (path: string) => boolean;
  generated: boolean;
}

/** Reads `linguist-generated` rules from a root `.gitattributes` file. */
function parseGitattributes(text: string): AttributeRule[] {
  const rules: AttributeRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (!pattern) continue;
    let generated: boolean | undefined;
    for (const a of attrs) {
      if (a === 'linguist-generated' || a === 'linguist-generated=true') generated = true;
      else if (a === '-linguist-generated' || a === 'linguist-generated=false') generated = false;
    }
    if (generated === undefined) continue;
    // gitattributes: a pattern without a slash matches at any depth; a leading slash anchors it.
    const glob = pattern.startsWith('/')
      ? pattern.slice(1)
      : pattern.includes('/')
        ? pattern
        : `**/${pattern}`;
    const m = picomatch(glob, { dot: true });
    const dir = picomatch(`${glob.replace(/\/$/, '')}/**`, { dot: true });
    rules.push({ match: (p) => m(p) || dir(p), generated });
  }
  return rules;
}
