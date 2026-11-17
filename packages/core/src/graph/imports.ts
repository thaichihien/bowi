/**
 * Resolves import specifiers to changed files, so that a call is only linked to a changed symbol
 * the calling file can actually see (GRAPH-1 "import path match where resolvable").
 */

import { posix } from 'node:path';
import type { FileChange } from '../types.ts';

const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.vue',
  '.svelte',
  '.astro',
];

export type ImportResolver = (fromPath: string, specifier: string) => string | undefined;

/** Returns the ID of the changed file a specifier refers to, if any. */
export function createImportResolver(files: FileChange[]): ImportResolver {
  const byPath = new Map<string, string>();
  for (const f of files) {
    byPath.set(f.path, f.id);
    if (f.oldPath) byPath.set(f.oldPath, f.id);
  }
  const withoutExt = new Map<string, string>();
  for (const [path, id] of byPath) withoutExt.set(stripExt(path), id);

  return (fromPath, specifier) => {
    if (specifier.startsWith('.')) {
      const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
      // TypeScript ESM imports name the compiled file: `./x.js` means `./x.ts`.
      const stem = /\.[cm]?jsx?$/.test(base) ? stripExt(base) : base;
      for (const candidate of [
        base,
        ...EXTENSIONS.map((e) => stem + e),
        ...EXTENSIONS.map((e) => `${base}/index${e}`),
      ]) {
        const id = byPath.get(candidate);
        if (id) return id;
      }
      return undefined;
    }
    // Path aliases such as `@/mail/mail.service`: match the trailing path segments.
    if (!specifier.includes('/')) return undefined;
    // SvelteKit's `$lib` is `src/lib`.
    const tail = stripExt(specifier.replace(/^[@~#]\//, '').replace(/^\$lib\//, 'lib/'));
    for (const [path, id] of withoutExt) {
      if (path === tail || path.endsWith(`/${tail}`)) return id;
    }
    return undefined;
  };
}

/** Removes a source-file extension; `mail.service` keeps its `.service`. */
function stripExt(path: string): string {
  const ext = EXTENSIONS.find((e) => path.endsWith(e));
  return ext ? path.slice(0, -ext.length) : path;
}
