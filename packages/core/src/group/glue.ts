/**
 * Glue changes (§15 #57): an added import line, or a constructor parameter that injects a
 * dependency (`private readonly events: EventEmitter2,`), exists only for the code in the same
 * file that uses the name it introduces. Such a hunk has no links of its own worth following
 * (the import names a module, the parameter an external type), so clustering would place it by a
 * weak link, e.g. two files that often changed together, far from the code it serves.
 *
 * A unit is glue when all its hunks are import or injection hunks of a file of a language
 * family (languages/) and some other unit's changed lines in the same file use one of the
 * introduced names. Clustering then merges it into the unit that uses those names most
 * (cluster.ts). Files of no family are clustered as usual.
 */

import { familyOf } from '../languages/index.ts';
import type { ChangedSymbol, FileChange, Hunk } from '../types.ts';

/**
 * For each glue unit (by index), the units in the same file that use what it introduces, most
 * changed lines using it first (ties by unit order). Users may be glue too: an import of
 * `EventEmitter2` is used by the constructor parameter it types, whose field the methods use.
 */
export function glueUnits(
  units: string[][],
  hunks: Hunk[],
  symbolById: Map<string, ChangedSymbol>,
  fileById: Map<string, FileChange>,
): Map<number, number[]> {
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const hunksOfUnit = units.map((u) => [
    ...new Set(u.flatMap((id) => symbolById.get(id)!.hunkIds)),
  ]);

  const out = new Map<number, number[]>();
  units.forEach((unit, i) => {
    const unitHunks = hunksOfUnit[i]!.map((id) => hunkById.get(id)!);
    const names = new Set<string>();
    for (const h of unitHunks) {
      const introduced = introducedNames(h, unit, symbolById, fileById);
      if (!introduced) return;
      introduced.forEach((n) => names.add(n));
    }
    if (names.size === 0) return;
    const files = new Set(unitHunks.map((h) => h.fileId));
    const word = new RegExp(`(?<![\\w$])(${[...names].map(escape).join('|')})(?![\\w$])`);
    const uses = units.map((_, j) =>
      j === i
        ? 0
        : hunksOfUnit[j]!.reduce((n, id) => {
            const h = hunkById.get(id)!;
            if (!files.has(h.fileId)) return n;
            const { codeOf } = familyOf(fileById.get(h.fileId)!.language)!;
            return (
              n + h.lines.filter((l) => l.kind !== 'context' && word.test(codeOf(l.text))).length
            );
          }, 0),
    );
    const users = uses
      .map((n, j) => ({ n, j }))
      .filter((u) => u.n > 0)
      .sort((a, b) => b.n - a.n || a.j - b.j)
      .map((u) => u.j);
    if (users.length > 0) out.set(i, users);
  });
  return out;
}

/**
 * Names an import or injection hunk introduces (added or removed), or undefined when the hunk is
 * anything else.
 */
function introducedNames(
  h: Hunk,
  unit: string[],
  symbolById: Map<string, ChangedSymbol>,
  fileById: Map<string, FileChange>,
): string[] | undefined {
  const family = familyOf(fileById.get(h.fileId)!.language);
  if (!family) return undefined;
  const symbols = h.symbolIds.filter((id) => unit.includes(id)).map((id) => symbolById.get(id)!);
  const changed = h.lines.filter((l) => l.kind !== 'context' && l.text.trim() !== '');
  if (changed.length === 0 || symbols.length !== 1) return undefined;
  const [symbol] = symbols as [ChangedSymbol];

  if (symbol.kind === 'file') {
    const importLines = family.importLineIndexes(h.lines);
    if (!h.lines.every((l, i) => l.kind === 'context' || !l.text.trim() || importLines.has(i)))
      return undefined;
    return changed.flatMap((l) => family.importedNames(l.text));
  }
  if (family.injectedParameter && symbol.name === family.constructorName) {
    const names: string[] = [];
    for (const l of changed) {
      const m = family.injectedParameter.exec(l.text);
      if (!m) return undefined;
      names.push(m[1]!);
    }
    return names;
  }
  return undefined;
}

function escape(s: string): string {
  return s.replace(/[$]/g, '\\$');
}
