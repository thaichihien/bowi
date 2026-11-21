/**
 * C# (M16). Namespaces are not tied to files: a file declares its namespace
 * (`namespace Acme.Core.Services;`), and code sees the types of its own namespace, of the
 * namespaces enclosing it, and of those it names with `using`, in any file. So a partial class
 * split over two files is one namespace's: each part sees the other's members. A `using static`
 * or alias names a type, resolved to the file named after it in its namespace, as C# projects
 * name files after their type. Global usings and the SDK's implicit ones only reach the file
 * that writes them. Tests are `*Tests` and `*Test`.
 */

import { posix } from 'node:path';
import type { DiffLine, FileChange } from '../types.ts';
import { codeOfCStyle, codeOnlyCStyle, identifiersCStyle, withoutExtension } from './c-style.ts';
import type { FileFacts, ImportResolver, LanguageFamily } from './family.ts';

const EXTENSIONS = ['.cs'];

function createImportResolver(
  files: FileChange[],
  packages: ReadonlyMap<string, string>,
): ImportResolver {
  // `Acme.Core.Entities.User` → the file `User.cs` declaring namespace `Acme.Core.Entities`.
  const byName = new Map<string, string>();
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const stem = withoutExtension(f.path, EXTENSIONS);
    const ns = packages.get(f.id);
    if (stem === undefined || ns === undefined) continue;
    // `UserService.Partial.cs` is a part of `UserService`.
    const name = `${ns}.${posix.basename(stem).split('.')[0]}`;
    if (!byName.has(name)) byName.set(name, f.id);
  }
  return (_fromPath, specifier) => byName.get(specifier);
}

/** `using X.Y;`, `using static X.Y.T;`, `using A = X.Y;`, `global using X;`. */
const USING = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([\w.]+(?:<[^;]*>)?)\s*;/;

const IMPORT_LINE =
  /^\s*((?:global\s+)?using\s+(?:static\s+)?[\w.]+\s*(=\s*[\w.<>, ]+)?;|namespace\s)/;

function importLineIndexes(lines: DiffLine[]): Set<number> {
  const out = new Set<number>();
  lines.forEach((l, i) => {
    if (USING.test(l.text)) out.add(i);
  });
  return out;
}

/** Only an alias brings in a name; a namespace's types are not known from the line. */
function importedNames(line: string): string[] {
  const alias = USING.exec(line)?.[1];
  return alias ? [alias] : [];
}

/** `.Name` is a call, a method group or a property: all of them are uses. */
function callsMethod(code: string, name: string): boolean {
  return new RegExp(`\\.\\s*${name}\\b`).test(code);
}

const codeOnly = (text: string) => codeOnlyCStyle(text, { verbatimStrings: true });

function fileFacts(text: string): FileFacts {
  const code = codeOnly(text);
  const imported = new Set<string>();
  const importLines = new Set<number>();
  let ns: string | undefined;
  code.split('\n').forEach((line, i) => {
    const n = /^\s*namespace\s+([\w.]+)/.exec(line);
    if (n && ns === undefined) ns = n[1];
    const m = USING.exec(line);
    if (!m) return;
    importLines.add(i + 1);
    // Namespaces and static types as written, aliases by their name.
    imported.add(m[2]!);
    if (m[1]) imported.add(m[1]);
  });
  return {
    imported,
    importLines,
    words: new Set(identifiersCStyle(code)),
    codeLines: code.split('\n'),
    ...(ns !== undefined && { package: ns }),
  };
}

/** Code in `from` sees its own namespace and those enclosing it. */
const seesPackage = (from: string, to: string) => from === to || from.startsWith(`${to}.`);

export const csharp: LanguageFamily = {
  id: 'csharp',
  languages: new Set(['csharp']),
  extensions: EXTENSIONS,
  createImportResolver,
  testSubject: (stem) => stem.replace(/(?<=.)(IntegrationTests?|Tests?)$/, ''),
  importLineIndexes,
  importedNames,
  importsUnnamed: true,
  isConstructor: (_name, qualifiedName) => {
    const parts = qualifiedName.replace(/\(.*\)$/, '').split('.');
    return parts.length >= 2 && parts.at(-2) === parts.at(-1);
  },
  overloads: true,
  codeOf: codeOfCStyle,
  importLine: IMPORT_LINE,
  codeOnly,
  identifiers: identifiersCStyle,
  isName: (name) => /^[A-Za-z_]\w*$/.test(name),
  callsMethod,
  fileFacts,
  // A file without a namespace is seen everywhere; else by namespace or `using`.
  canUse: (facts, _fromPath, _path, name, targetPackage) =>
    targetPackage === undefined ||
    (facts.package !== undefined && seesPackage(facts.package, targetPackage)) ||
    facts.imported.has(targetPackage) ||
    facts.imported.has(name) ||
    facts.imported.has(`${targetPackage}.${name}`),
  declaresPackage: true,
  packageImport: (specifier) => specifier,
  seesPackage,
};
