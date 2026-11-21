/**
 * Distinctive literals for `shared-literal` and `docs-mentions` edges (GRAPH-5, GRAPH-8).
 *
 * A literal is a kebab-case or snake_case word of at least 6 characters: route segments
 * (`verify-email`), table and column names (`email_verified`), queue, event and config keys.
 * Plain words and camelCase identifiers are too common to say two changes belong together.
 */

import { DEFAULT_FAMILY } from '../languages/index.ts';

const LITERAL = /[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+/g;
const MIN_LENGTH = 6;

/** Common tokens that link unrelated code. */
const STOPLIST = new Set([
  'utf-8',
  'content-type',
  'content-length',
  'x-requested-with',
  'use-strict',
  'no-unused-vars',
  'eslint-disable',
  'eslint-disable-next-line',
  'ts-ignore',
  'ts-expect-error',
  'ts-nocheck',
  'prettier-ignore',
  'max-len',
  'e2e-spec',
  'node_modules',
  'created_at',
  'updated_at',
  'deleted_at',
  'user_id',
  'application-json',
  'text-html',
]);

/**
 * Literals in one line. Import lines are skipped (module paths say nothing about which changes
 * belong together; imports are resolved anyway): `importLine` is the line's language family's.
 */
export function literalsIn(line: string, importLine = DEFAULT_FAMILY.importLine): string[] {
  if (importLine.test(line)) return [];
  const found = new Set<string>();
  for (const m of line.matchAll(LITERAL)) {
    const token = m[0];
    // Require letters on both sides of a separator: skips dates, versions and `__dirname`.
    if (token.length < MIN_LENGTH || !/[a-z]{2}/i.test(token)) continue;
    const lower = token.toLowerCase();
    if (STOPLIST.has(lower)) continue;
    found.add(lower);
  }
  return [...found];
}
