/**
 * Python (M15). Modules are files: `app/mail/service.py` is `app.mail.service`, a package's
 * `__init__.py` is the package itself. Imports are relative (`from .mail import send`, one dot
 * per level) or absolute, matched against the end of a changed file's path, since the import
 * root (`src/`, the project folder) is not known. Tests are `test_*.py` and `*_test.py`.
 */

import { posix } from 'node:path';
import type { DiffLine, FileChange } from '../types.ts';
import type { FileFacts, ImportResolver, LanguageFamily } from './family.ts';

const EXTENSIONS = ['.py', '.pyi'];

function createImportResolver(files: FileChange[]): ImportResolver {
  const byPath = new Map<string, string>();
  for (const f of files) {
    if (!EXTENSIONS.some((e) => f.path.endsWith(e))) continue;
    byPath.set(f.path, f.id);
    if (f.oldPath) byPath.set(f.oldPath, f.id);
  }
  const candidates = (module: string) => [
    ...EXTENSIONS.map((e) => `${module}${e}`),
    ...EXTENSIONS.map((e) => `${module}/__init__${e}`),
  ];
  return (fromPath, specifier) => {
    const dots = /^\.*/.exec(specifier)![0].length;
    const rest = specifier.slice(dots).replace(/\./g, '/');
    if (dots > 0) {
      let dir = posix.dirname(fromPath);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      const module = rest ? posix.join(dir, rest) : dir;
      for (const c of rest ? candidates(module) : EXTENSIONS.map((e) => `${dir}/__init__${e}`)) {
        const id = byPath.get(c.startsWith('./') ? c.slice(2) : c);
        if (id) return id;
      }
      return undefined;
    }
    // Absolute: the module path ends a changed file's path (the import root is not known).
    for (const c of candidates(rest)) {
      for (const [path, id] of byPath) if (path === c || path.endsWith(`/${c}`)) return id;
    }
    return undefined;
  };
}

/** `from x import (` opens an import that ends at `)`. */
function importLineIndexes(lines: DiffLine[]): Set<number> {
  const out = new Set<number>();
  let open = false;
  lines.forEach((l, i) => {
    const t = l.text.trim();
    if (!open && IMPORT_LINE.test(l.text)) {
      out.add(i);
      open = /\(\s*(#.*)?$/.test(t) && !t.includes(')');
    } else if (open) {
      out.add(i);
      if (t.includes(')')) open = false;
    }
  });
  return out;
}

const NOT_NAMES = new Set(['import', 'from', 'as']);

/** Names an import line binds: after `import`, or a line of a parenthesized name list. */
function importedNames(line: string): string[] {
  const code = codeOf(line).replace(/#.*$/, '');
  const m = /^\s*(?:from\s+\S+\s+)?import\s+(.*)$/.exec(code);
  return [...(m ? m[1]! : code).matchAll(/[A-Za-z_]\w*/g)]
    .map((x) => x[0])
    .filter((n, i, all) => !NOT_NAMES.has(n) && all.indexOf(n) === i);
}

/** A line without its string literals. */
function codeOf(line: string): string {
  return line.replace(/([rbfuRBFU]{0,2})(['"])(?:\\.|(?!\2).)*\2/g, '""');
}

const IMPORT_LINE = /^\s*(import\s|from\s+\S+\s+import\b)/;

const IDENTIFIER = /[A-Za-z_]\w*/g;
const identifiers = (code: string): string[] => code.match(IDENTIFIER) ?? [];

function callsMethod(code: string, name: string): boolean {
  return new RegExp(`\\.\\s*${name}\\s*\\(`).test(code);
}

/**
 * The text with comments and string contents blanked (line breaks kept), so a name in a
 * docstring or a test's message is not a use. f-strings are blanked whole.
 */
function codeOnly(text: string): string {
  const out = [...text];
  const n = out.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = out[i]!;
    if (c === '#') {
      let e = i;
      while (e < n && out[e] !== '\n') e++;
      blank(i, e);
      i = e;
    } else if (c === "'" || c === '"') {
      const triple = out[i + 1] === c && out[i + 2] === c;
      const q = triple ? c.repeat(3) : c;
      let e = i + q.length;
      while (e < n) {
        if (out[e] === '\\') e += 2;
        else if (triple ? text.startsWith(q, e) : out[e] === c || out[e] === '\n') break;
        else e++;
      }
      blank(i + q.length, e);
      i = e + (triple ? 3 : 1);
    } else i++;
  }
  return out.join('');
}

/** `from x import a, b as c` (also across lines in parentheses) and `import x.y as z`. */
const IMPORT_RE = /^[ \t]*from\s+\S+\s+import\s+(\([^)]*\)|[^\n]*)|^[ \t]*import\s+([^\n]*)/gm;

function fileFacts(text: string): FileFacts {
  const code = codeOnly(text);
  const imported = new Set<string>();
  const importLines = new Set<number>();
  for (const m of code.matchAll(IMPORT_RE)) {
    const names = m[1] ?? m[2] ?? '';
    for (const part of names.replace(/[()]/g, ' ').split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      const bound = alias ?? name?.split('.')[0];
      if (bound && /^[A-Za-z_]\w*$/.test(bound)) imported.add(bound);
    }
    const first = code.slice(0, m.index).split('\n').length;
    const count = m[0].split('\n').length;
    for (let k = 0; k < count; k++) importLines.add(first + k);
  }
  return { imported, importLines, words: new Set(identifiers(code)), codeLines: code.split('\n') };
}

export const python: LanguageFamily = {
  id: 'python',
  languages: new Set(['python']),
  extensions: EXTENSIONS,
  createImportResolver,
  testSubject: (stem) => stem.replace(/^test_|_test$/, ''),
  importLineIndexes,
  importedNames,
  codeOf,
  importLine: IMPORT_LINE,
  codeOnly,
  identifiers,
  isName: (name) => /^[A-Za-z_]\w*$/.test(name),
  callsMethod,
  fileFacts,
};
