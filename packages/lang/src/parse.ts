/**
 * Parses one version of one file into a ParsedSource (PARSE-1).
 *
 * The tree stays alive inside the ParsedSource so that hunk ranges can be fingerprinted later;
 * call dispose() when done (trees live in WebAssembly memory).
 */

import type { Tree } from 'web-tree-sitter';
import { codeLines, coverFingerprint, fingerprint } from './fingerprint.ts';
import type { LanguageId } from './languages.ts';
import { loadLanguage } from './loader.ts';
import { indexNames, type NameIndex } from './references.ts';
import { extractSymbols, type SourceSymbol } from './symbols.ts';

export interface ParsedSource extends NameIndex {
  language: LanguageId;
  /** True when the parser had to recover from syntax errors; callers fall back to text (PARSE-4). */
  hasError: boolean;
  symbols: SourceSymbol[];
  /** Formatting-insensitive fingerprint of the whole file. */
  fingerprint: string;
  /** Whether a 1-based line holds code (not blank, not only comments). */
  isCodeLine(line: number): boolean;
  /** Formatting-insensitive fingerprint of the code on 1-based lines `start..end`. */
  coverFingerprint(startLine: number, endLine: number): string;
  dispose(): void;
}

export async function parseSource(language: LanguageId, text: string): Promise<ParsedSource> {
  const { parser, query } = await loadLanguage(language);
  const tree: Tree | null = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${language}`);
  const root = tree.rootNode;
  const lines = codeLines(root);
  return {
    language,
    hasError: root.hasError,
    symbols: extractSymbols(root, query, language, text),
    ...indexNames(root),
    fingerprint: fingerprint(root),
    isCodeLine: (line) => lines.has(line),
    coverFingerprint: (startLine, endLine) => coverFingerprint(root, startLine - 1, endLine - 1),
    dispose: () => tree.delete(),
  };
}
