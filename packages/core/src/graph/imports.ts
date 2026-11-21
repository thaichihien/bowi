/**
 * Resolves import specifiers to changed files, so that a call is only linked to a changed symbol
 * the calling file can actually see (GRAPH-1 "import path match where resolvable"). How a
 * specifier resolves depends on the importing file's language family (languages/).
 */

import { languageForPath } from '@bowi/lang';
import { DEFAULT_FAMILY, familyOf, type ImportResolver } from '../languages/index.ts';
import type { FileChange } from '../types.ts';

export type { ImportResolver } from '../languages/index.ts';

/**
 * Returns the ID of the changed file a specifier refers to, if any. `packages`: the package each
 * changed file declares (Java, Kotlin, C#), by file ID.
 */
export function createImportResolver(
  files: FileChange[],
  packages: ReadonlyMap<string, string> = new Map(),
): ImportResolver {
  const resolvers = new Map<string, ImportResolver>();
  return (fromPath, specifier) => {
    const family = familyOf(languageForPath(fromPath)) ?? DEFAULT_FAMILY;
    let resolve = resolvers.get(family.id);
    if (!resolve) {
      resolve = family.createImportResolver(files, packages);
      resolvers.set(family.id, resolve);
    }
    return resolve(fromPath, specifier);
  };
}
