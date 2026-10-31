/**
 * Glue changes (§15 #57): an added import line, or a constructor parameter that injects a
 * dependency (`private readonly events: EventEmitter2,`), exists only for the code in the same
 * file that uses the name it introduces. Such a hunk has no links of its own worth following
 * (the import names a module, the parameter an external type), so clustering would place it by a
 * weak link, e.g. two files that often changed together, far from the code it serves.
 *
 * A unit is glue when all its hunks are import or injection hunks of a TypeScript/JavaScript
 * file and some other unit's changed lines in the same file use one of the introduced names.
 * Clustering then merges it into the unit that uses those names most (cluster.ts).
 * Only TypeScript/JavaScript syntax is recognized; anything else is clustered as usual.
 */

import type { ChangedSymbol, FileChange, Hunk } from '../types.ts';

const SCRIPT_LANGUAGES = new Set(['typescript', 'tsx', 'javascript']);
const NOT_NAMES = new Set(['import', 'from', 'type', 'as', 'default', 'export', 'typeof']);

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
  if (!SCRIPT_LANGUAGES.has(fileById.get(h.fileId)!.language ?? '')) return undefined;
  const symbols = h.symbolIds.filter((id) => unit.includes(id)).map((id) => symbolById.get(id)!);
  const changed = h.lines.filter((l) => l.kind !== 'context' && l.text.trim() !== '');
  if (changed.length === 0 || symbols.length !== 1) return undefined;
  const [symbol] = symbols as [ChangedSymbol];

  if (symbol.kind === 'file') {
    const importLines = importLineIndexes(h);
    if (!h.lines.every((l, i) => l.kind === 'context' || !l.text.trim() || importLines.has(i)))
      return undefined;
    return changed.flatMap((l) => importedNames(l.text));
  }
  if (symbol.name === 'constructor') {
    const names: string[] = [];
    for (const l of changed) {
      const m = INJECTED.exec(l.text);
      if (!m) return undefined;
      names.push(m[1]!);
    }
    return names;
  }
  return undefined;
}

/** `private readonly events: EventEmitter2,` or `@InjectRepository(X) private repo: Repository<X>,` */
const INJECTED =
  /^\s*(?:@[\w$.]+\([^)]*\)\s*)*(?:(?:private|protected|public|readonly)\s+)+([A-Za-z_$][\w$]*)\??\s*:\s*[^;=]+,?\s*$/;

/**
 * Lines of the hunk that belong to import statements: `import … from '…'`, and the lines of a
 * multi-line import, also when the hunk starts inside one (a list of names ending in `} from`).
 */
function importLineIndexes(h: Hunk): Set<number> {
  const out = new Set<number>();
  let open = false;
  h.lines.forEach((l, i) => {
    const t = l.text.trim();
    if (!open && /^import\b/.test(t)) {
      out.add(i);
      open = !/(\bfrom\s*['"][^'"]*['"]|^import\s*['"][^'"]*['"])\s*;?$/.test(t);
    } else if (open) {
      out.add(i);
      if (/\bfrom\s*['"][^'"]*['"]\s*;?$/.test(t)) open = false;
    } else if (/^\}\s*from\s*['"][^'"]*['"]\s*;?$/.test(t)) {
      // The end of an import whose start is before the hunk: claim the name list above it.
      out.add(i);
      for (let j = i - 1; j >= 0 && NAME_LINE.test(h.lines[j]!.text); j--) out.add(j);
    }
  });
  return out;
}

/** One line of an import's name list: `  OrderEventCollector,` or `  type X as Y,`. */
const NAME_LINE = /^\s*(?:type\s+)?[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*,?\s*$/;

function importedNames(line: string): string[] {
  const code = codeOf(line);
  return [...code.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((m) => m[0])
    .filter((n, i, all) => !NOT_NAMES.has(n) && all.indexOf(n) === i);
}

/** A line without its string literals: `from 'node:events'` does not use a field `events`. */
function codeOf(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
}

function escape(s: string): string {
  return s.replace(/[$]/g, '\\$');
}
