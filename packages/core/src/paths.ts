/**
 * Reading order of file paths, shared by the engine (files within a step) and the page (its file
 * trees and lists). Browser-safe: it imports nothing but the determinism helpers.
 *
 * A migration's up comes before its down (owner, 2026-11-24): `…/up.sql` before `…/down.sql`
 * (Hasura), `0001_add_users.up.sql` before `0001_add_users.down.sql` (golang-migrate), whatever
 * the extension. Only a pair moves: an up file whose down is not among the paths keeps its place.
 */

import { compareStrings } from './determinism.ts';

/** `up` as the last word of a file name, before its extensions. */
const UP = /(^|[/._-])(up)((?:\.[A-Za-z0-9]+)+)$/i;

/**
 * For each up file whose down file is among `paths`, the down file's path: the up file sorts as
 * if it had that name, right before it.
 */
export function upBeforeDown(paths: Iterable<string>): Map<string, string> {
  const all = new Set(paths);
  const alias = new Map<string, string>();
  for (const path of all) {
    const m = UP.exec(path);
    if (!m) continue;
    const word = m[2]!;
    const down = word === 'UP' ? 'DOWN' : word.startsWith('U') ? 'Down' : 'down';
    const partner = `${path.slice(0, m.index)}${m[1]}${down}${m[3]}`;
    if (all.has(partner)) alias.set(path, partner);
  }
  return alias;
}

/**
 * A comparator of `paths` by `compare` (default: code-unit order), with each migration's up file
 * right before its down file.
 */
export function readingOrder(
  paths: Iterable<string>,
  compare: (a: string, b: string) => number = compareStrings,
): (a: string, b: string) => number {
  const alias = upBeforeDown(paths);
  return (a, b) =>
    compare(alias.get(a) ?? a, alias.get(b) ?? b) ||
    Number(alias.has(b)) - Number(alias.has(a)) ||
    compareStrings(a, b);
}
