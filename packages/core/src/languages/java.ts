/**
 * Java and Kotlin (M16): one family, since each uses the other's classes. A file declares its
 * package (`package org.acme.users`); the files of a package see each other without imports,
 * also across source roots (`src/main/java` and `src/test/java`). An import names a class
 * (`org.acme.User`, resolved to the file `User.java` or `User.kt` declaring package `org.acme`,
 * else to a path ending `org/acme/User.java`), a member of one (`import static
 * org.acme.Util.check`, the longest prefix naming a file), a whole package (`org.acme.*`), or in
 * Kotlin a top-level function or property (`netlib.internal.closeQuietly`), which brings in its
 * package. Tests are `*Test`, `*Tests`, `*IT` and `*IntegrationTest`.
 */

import { posix } from 'node:path';
import type { DiffLine, FileChange } from '../types.ts';
import {
  codeOfCStyle,
  codeOnlyCStyle,
  identifiersCStyle,
  lastSegment,
  withoutExtension,
} from './c-style.ts';
import type { FileFacts, ImportResolver, LanguageFamily } from './family.ts';

const EXTENSIONS = ['.java', '.kt', '.kts'];

function createImportResolver(
  files: FileChange[],
  packages: ReadonlyMap<string, string>,
): ImportResolver {
  // `org.acme.User` → the file `User.*` declaring package `org.acme`; and files by path.
  const byName = new Map<string, string>();
  const byPath: [string, string][] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const stem = withoutExtension(f.path, EXTENSIONS);
    if (stem === undefined) continue;
    byPath.push([stem, f.id]);
    const pkg = packages.get(f.id);
    const name = pkg === undefined ? posix.basename(stem) : `${pkg}.${posix.basename(stem)}`;
    if (!byName.has(name)) byName.set(name, f.id);
  }
  return (_fromPath, specifier) => {
    const parts = specifier.replace(/\.\*$/, '').split('.');
    for (let k = parts.length; k >= 2; k--) {
      const name = parts.slice(0, k).join('.');
      const id = byName.get(name);
      if (id) return id;
      const tail = name.replace(/\./g, '/');
      const hit = byPath.find(([stem]) => stem === tail || stem.endsWith(`/${tail}`));
      if (hit) return hit[1];
    }
    return undefined;
  };
}

/**
 * The package an import brings in whole: `org.acme.*`, and Kotlin's import of a top-level
 * function or property (a lower-case last name), which lives in some file of its package.
 */
function packageImport(specifier: string): string | undefined {
  if (specifier.endsWith('.*')) return specifier.slice(0, -2);
  const dot = specifier.lastIndexOf('.');
  return dot > 0 && /^[a-z]/.test(specifier.slice(dot + 1)) ? specifier.slice(0, dot) : undefined;
}

const IMPORT_LINE = /^\s*(import|package)\s/;

/** `import a.b.C`, `import static a.b.C.m`, `import a.b.*`, Kotlin's `import a.b.C as D`. */
const IMPORT = /^\s*import\s+(?:static\s+)?(\w+(?:\.\w+)*(?:\.\*)?)(?:\s+as\s+(\w+))?/;

function importLineIndexes(lines: DiffLine[]): Set<number> {
  const out = new Set<number>();
  lines.forEach((l, i) => {
    if (/^\s*import\s/.test(l.text)) out.add(i);
  });
  return out;
}

/** `import org.acme.User;` → `User`; `import a.b.C as D` → `D`; a whole package → none. */
function importedNames(line: string): string[] {
  const m = IMPORT.exec(line);
  if (!m || m[1]!.endsWith('*')) return [];
  return [m[2] ?? lastSegment(m[1]!)];
}

function callsMethod(code: string, name: string): boolean {
  // `.name(…)`, Kotlin's `.name { … }` with a trailing lambda, and `::name` references.
  return new RegExp(`\\.\\s*${name}\\s*(<[^>]*>\\s*)?[({]|::\\s*${name}\\b`).test(code);
}

const codeOnly = (text: string) => codeOnlyCStyle(text, { nestedComments: true });

function fileFacts(text: string): FileFacts {
  const code = codeOnly(text);
  const imported = new Set<string>();
  const importLines = new Set<number>();
  let pkg: string | undefined;
  code.split('\n').forEach((line, i) => {
    const p = /^\s*package\s+([\w.]+)/.exec(line);
    if (p && pkg === undefined) pkg = p[1];
    const m = IMPORT.exec(line);
    if (!m) return;
    importLines.add(i + 1);
    // Whole packages stay as written (`org.acme.*`): canUse looks them up.
    imported.add(m[1]!.endsWith('*') ? m[1]! : (m[2] ?? lastSegment(m[1]!)));
  });
  return {
    imported,
    importLines,
    words: new Set(identifiersCStyle(code)),
    codeLines: code.split('\n'),
    ...(pkg !== undefined && { package: pkg }),
  };
}

export const java: LanguageFamily = {
  id: 'java',
  languages: new Set(['java', 'kotlin']),
  extensions: EXTENSIONS,
  createImportResolver,
  testSubject: (stem) => stem.replace(/(?<=.)(IntegrationTests?|Tests?|IT)$/, ''),
  importLineIndexes,
  importedNames,
  // Java names a constructor after its class, Kotlin's secondary ones are `constructor`.
  isConstructor: (name, qualifiedName) => {
    const parts = qualifiedName.replace(/\(.*\)$/, '').split('.');
    return name === 'constructor' || (parts.length >= 2 && parts.at(-2) === parts.at(-1));
  },
  overloads: true,
  codeOf: codeOfCStyle,
  importLine: IMPORT_LINE,
  codeOnly,
  identifiers: identifiersCStyle,
  isName: (name) => /^[A-Za-z_]\w*$/.test(name),
  callsMethod,
  fileFacts,
  // In the same package, or a file importing the name or the whole package.
  canUse: (facts, _fromPath, _path, name, targetPackage) =>
    (targetPackage !== undefined && facts.package === targetPackage) ||
    facts.imported.has(name) ||
    (targetPackage !== undefined && facts.imported.has(`${targetPackage}.*`)),
  declaresPackage: true,
  packageImport,
};
