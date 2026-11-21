/**
 * Go (M15). A package is a directory: its files see each other without imports, and an import
 * (`"github.com/acme/app/internal/auth"`) brings in the whole package. The module path from
 * `go.mod` is not read; an import path is matched against the end of a changed file's
 * directory, longest first. Tests are `*_test.go`.
 */

import { posix } from 'node:path';
import type { DiffLine, FileChange } from '../types.ts';
import type { FileFacts, ImportResolver, LanguageFamily } from './family.ts';

const EXTENSIONS = ['.go'];

function createImportResolver(files: FileChange[]): ImportResolver {
  // Changed Go files by directory, longest directory first, files in path order.
  const byDir = new Map<string, string>();
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!f.path.endsWith('.go')) continue;
    const dir = posix.dirname(f.path);
    if (!byDir.has(dir)) byDir.set(dir, f.id);
  }
  const dirs = [...byDir.keys()].filter((d) => d !== '.').sort((a, b) => b.length - a.length);
  return (_fromPath, specifier) => {
    const dir = dirs.find((d) => specifier === d || specifier.endsWith(`/${d}`));
    return dir === undefined ? undefined : byDir.get(dir);
  };
}

/** `import "x"`, and the lines of an `import ( … )` block. */
function importLineIndexes(lines: DiffLine[]): Set<number> {
  const out = new Set<number>();
  let open = false;
  lines.forEach((l, i) => {
    const t = l.text.trim();
    if (!open && /^import\b/.test(t)) {
      out.add(i);
      open = /^import\s*\($/.test(t);
    } else if (open) {
      out.add(i);
      if (t === ')') open = false;
    } else if (IMPORT_SPEC.test(t)) {
      // A line of an import block whose start is before the hunk.
      out.add(i);
    }
  });
  return out;
}

/** One line of an import block: `"fmt"` or `svc "github.com/acme/app/svc"`. */
const IMPORT_SPEC = /^(?:[A-Za-z_.]\w*\s+)?"[^"]+"$/;

/** The name an import line brings in: its alias, else the path's last segment. */
function importedNames(line: string): string[] {
  const m = /(?:^|\s|\()(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/.exec(
    line.trim().replace(/^import\s*/, ''),
  );
  if (!m) return [];
  const name = m[1] ?? m[2]!.slice(m[2]!.lastIndexOf('/') + 1);
  return name === '_' || name === '.' ? [] : [name];
}

/** A line without its string literals. */
function codeOf(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
}

const IMPORT_LINE = /^\s*(import\b|(?:[A-Za-z_.]\w*\s+)?"[^"]+"\s*$)/;

const IDENTIFIER = /[A-Za-z_]\w*/g;
const identifiers = (code: string): string[] => code.match(IDENTIFIER) ?? [];

function callsMethod(code: string, name: string): boolean {
  return new RegExp(`\\.\\s*${name}\\s*(\\[[^\\]]*\\])?\\s*\\(`).test(code);
}

/** The text with comments and string contents blanked (line breaks kept). */
function codeOnly(text: string): string {
  const out = [...text];
  const n = out.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = out[i]!;
    if (c === '/' && out[i + 1] === '/') {
      let e = i;
      while (e < n && out[e] !== '\n') e++;
      blank(i, e);
      i = e;
    } else if (c === '/' && out[i + 1] === '*') {
      let e = i + 2;
      while (e < n && !(out[e] === '*' && out[e + 1] === '/')) e++;
      blank(i, e + 2);
      i = e + 2;
    } else if (c === '`') {
      let e = i + 1;
      while (e < n && out[e] !== '`') e++;
      blank(i + 1, e);
      i = e + 1;
    } else if (c === '"' || c === "'") {
      let e = i + 1;
      while (e < n && out[e] !== c && out[e] !== '\n') e += out[e] === '\\' ? 2 : 1;
      blank(i + 1, e);
      i = e + 1;
    } else i++;
  }
  return out.join('');
}

/** Imported package paths, and the lines of import declarations. */
function fileFacts(text: string): FileFacts {
  const imported = new Set<string>();
  const importLines = new Set<number>();
  const lines = text.split('\n');
  let open = false;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const path = /"([^"]+)"/.exec(t)?.[1];
    if (!open && /^import\b/.test(t)) {
      importLines.add(i + 1);
      open = /^import\s*\($/.test(t);
      if (path) imported.add(path);
    } else if (open) {
      importLines.add(i + 1);
      if (t === ')') open = false;
      else if (path) imported.add(path);
    }
  });
  const code = codeOnly(text);
  return { imported, importLines, words: new Set(identifiers(code)), codeLines: code.split('\n') };
}

export const go: LanguageFamily = {
  id: 'go',
  languages: new Set(['go']),
  extensions: EXTENSIONS,
  createImportResolver,
  testSubject: (stem) => stem.replace(/_test$/, ''),
  importLineIndexes,
  importedNames,
  codeOf,
  importLine: IMPORT_LINE,
  codeOnly,
  identifiers,
  isName: (name) => /^[A-Za-z_]\w*$/.test(name),
  callsMethod,
  fileFacts,
  // In the same package, or a file that imports the package (its directory ends the path).
  canUse: (facts, fromPath, path) => {
    const dir = posix.dirname(path);
    if (posix.dirname(fromPath) === dir) return true;
    return [...facts.imported].some((p) => p === dir || p.endsWith(`/${dir}`));
  },
  packageOf: (path) => posix.dirname(path),
};
