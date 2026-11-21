/**
 * What the engine needs to know about a programming language beyond its grammar (M15): which
 * files can use each other, how imports resolve, how test files are named, which lines are glue,
 * and how to find unchanged code that uses a changed symbol. Languages of one family can use
 * each other's code (TypeScript imports JavaScript and Vue components).
 *
 * Files of no family (Markdown, JSON, YAML, text) keep the JavaScript family's rules where a
 * rule applies to every file (test file names, import lines in the shared-literal check), as
 * they always did.
 *
 * Packages (M16): Go's package is its directory (`packageOf`); Java, Kotlin and C# declare
 * theirs in the file (`declaresPackage`, read from `ParsedSource.packageName`). Either way the
 * files of one package see each other without imports.
 */

import type { DiffLine, FileChange } from '../types.ts';

/** Returns the ID of the changed file a specifier refers to, if any. */
export type ImportResolver = (fromPath: string, specifier: string) => string | undefined;

/** What the outside-reference search needs about a file (head version). */
export interface FileFacts {
  /** Names brought in by import statements. */
  imported: Set<string>;
  /** 1-based lines that belong to import statements. */
  importLines: Set<number>;
  /** Every identifier in the file's code (not in comments or strings). */
  words: Set<string>;
  /** The file's lines with comments and string contents blanked. */
  codeLines: string[];
  /** The package the file declares, in a language that declares one (Java, Kotlin, C#). */
  package?: string;
}

export interface LanguageFamily {
  id: string;
  /** Parsed languages (`FileChange.language`) of the family. */
  languages: ReadonlySet<string>;
  /** Source file extensions, searched for outside references. */
  extensions: string[];
  /**
   * Resolves a file's import specifiers to the changed files. `packages` has the package each
   * changed file declares, for families that declare them.
   */
  createImportResolver(files: FileChange[], packages: ReadonlyMap<string, string>): ImportResolver;
  /** The file stem a test file's stem tests (`x.spec` → `x`); the stem itself when it is none. */
  testSubject(stem: string): string;
  /** Lines of a hunk that belong to import statements. */
  importLineIndexes(lines: DiffLine[]): Set<number>;
  /** Names an import line brings in. */
  importedNames(line: string): string[];
  /**
   * An import may bring in names it does not write (C#'s `using Acme.Core.Services`): a hunk of
   * such imports serves the code that changes in its file.
   */
  importsUnnamed?: boolean;
  /** A constructor parameter that injects a dependency; group 1 is the parameter's name. */
  injectedParameter?: RegExp;
  /** The name of a class's constructor method, if the language has one. */
  constructorName?: string;
  /** Whether a symbol is a constructor (Java and C# name it after its class), if not by name. */
  isConstructor?(name: string, qualifiedName: string): boolean;
  /**
   * Whether an overloaded function's qualified name carries its parameter types,
   * `UserService.save(User)`; its name, which calls use, stays `save`.
   */
  overloads?: boolean;
  /** A line without its string literals. */
  codeOf(line: string): string;
  /** First and last line of an import, whose literals (module paths) link nothing. */
  importLine: RegExp;
  /** Text with comments and string contents blanked, line breaks kept. */
  codeOnly(text: string): string;
  /** Identifiers in code. */
  identifiers(code: string): string[];
  /** Whether a symbol name can be searched for as an identifier. */
  isName(name: string): boolean;
  /** Whether code calls a method `name` on something: `.name(`. */
  callsMethod(code: string, name: string): boolean;
  fileFacts(text: string): FileFacts;
  /**
   * Whether code in another file (`fromPath`) can use a top-level `name` defined in `path`,
   * whose file declares `targetPackage`. Without it: the file imports the name.
   */
  canUse?(
    facts: FileFacts,
    fromPath: string,
    path: string,
    name: string,
    targetPackage: string | undefined,
  ): boolean;
  /**
   * The package a file belongs to, when files of a package see each other without imports and
   * an import brings in the whole package (Go: its directory).
   */
  packageOf?(path: string): string;
  /** The package is the one the file declares: Java's and Kotlin's `package`, C#'s namespace. */
  declaresPackage?: boolean;
  /** The package an import brings in whole, if it does: Java's `a.b.*`, C#'s `using A.B`. */
  packageImport?(specifier: string): string | undefined;
  /**
   * Whether code in package `from` sees package `to` without an import; without it, only its
   * own package (C#: also the namespaces enclosing it).
   */
  seesPackage?(from: string, to: string): boolean;
}
