/**
 * What the engine needs to know about a programming language beyond its grammar (M15): which
 * files can use each other, how imports resolve, how test files are named, which lines are glue,
 * and how to find unchanged code that uses a changed symbol. Languages of one family can use
 * each other's code (TypeScript imports JavaScript and Vue components).
 *
 * Files of no family (Markdown, JSON, YAML, text) keep the JavaScript family's rules where a
 * rule applies to every file (test file names, import lines in the shared-literal check), as
 * they always did.
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
}

export interface LanguageFamily {
  id: string;
  /** Parsed languages (`FileChange.language`) of the family. */
  languages: ReadonlySet<string>;
  /** Source file extensions, searched for outside references. */
  extensions: string[];
  /** Resolves a file's import specifiers to the changed files. */
  createImportResolver(files: FileChange[]): ImportResolver;
  /** The file stem a test file's stem tests (`x.spec` → `x`); the stem itself when it is none. */
  testSubject(stem: string): string;
  /** Lines of a hunk that belong to import statements. */
  importLineIndexes(lines: DiffLine[]): Set<number>;
  /** Names an import line brings in. */
  importedNames(line: string): string[];
  /** A constructor parameter that injects a dependency; group 1 is the parameter's name. */
  injectedParameter?: RegExp;
  /** The name of a class's constructor method, if the language has one. */
  constructorName?: string;
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
   * Whether code in another file (`fromPath`) can use a top-level `name` defined in `path`.
   * Without it: the file imports the name.
   */
  canUse?(facts: FileFacts, fromPath: string, path: string, name: string): boolean;
  /**
   * The package a file belongs to, when files of a package see each other without imports and
   * an import brings in the whole package (Go: its directory).
   */
  packageOf?(path: string): string;
}
