/**
 * Parses one version of one file into a ParsedSource (PARSE-1).
 *
 * The tree stays alive inside the ParsedSource so that hunk ranges can be fingerprinted later;
 * call dispose() when done (trees live in WebAssembly memory).
 */

import type { Node, Tree } from 'web-tree-sitter';
import { codeLines, contentLines, coverFingerprint, fingerprint } from './fingerprint.ts';
import { parseComponent } from './component.ts';
import { COMPONENT_LANGUAGES, type LanguageId } from './languages.ts';
import { loadLanguage } from './loader.ts';
import { indexNames, type NameIndex } from './references.ts';
import { indexCSharp } from './references-csharp.ts';
import { indexGo } from './references-go.ts';
import { indexJava } from './references-java.ts';
import { indexKotlin } from './references-kotlin.ts';
import { indexPython } from './references-python.ts';
import { extractSymbols, type SourceSymbol } from './symbols.ts';

export interface ParsedSource extends NameIndex {
  language: LanguageId;
  /** True when the parser had to recover from syntax errors; callers fall back to text (PARSE-4). */
  hasError: boolean;
  symbols: SourceSymbol[];
  /** Formatting-insensitive fingerprint of the whole file. */
  fingerprint: string;
  /** Whether a 1-based line holds code or comment text (is not blank). */
  isContentLine(line: number): boolean;
  /** Whether a 1-based line holds code: a token that is not a comment. */
  isCodeLine(line: number): boolean;
  /** Formatting-insensitive fingerprint of the code on 1-based lines `start..end`. */
  coverFingerprint(startLine: number, endLine: number): string;
  dispose(): void;
}

export async function parseSource(language: LanguageId, text: string): Promise<ParsedSource> {
  if (COMPONENT_LANGUAGES.has(language)) return parseComponent(language, text, parseSource);
  const { parser, query } = await loadLanguage(language);
  const tree: Tree | null = parser.parse(
    language === 'typescript' || language === 'tsx' ? withoutTypeStar(text) : text,
  );
  if (!tree) throw new Error(`tree-sitter returned no tree for ${language}`);
  const root = tree.rootNode;
  const lines = contentLines(root);
  const code = codeLines(root);
  return {
    language,
    hasError: root.hasError,
    symbols: extractSymbols(root, query, language, text),
    ...(INDEXES[language] ?? indexNames)(root),
    fingerprint: fingerprint(root),
    isContentLine: (line) => lines.has(line),
    isCodeLine: (line) => code.has(line),
    coverFingerprint: (startLine, endLine) => coverFingerprint(root, startLine - 1, endLine - 1),
    dispose: () => tree.delete(),
  };
}

/** The name index of languages with one of their own; the others use TypeScript's. */
const INDEXES: Partial<Record<LanguageId, (root: Node) => NameIndex>> = {
  python: indexPython,
  go: indexGo,
  java: indexJava,
  kotlin: indexKotlin,
  csharp: indexCSharp,
};

/**
 * `export type * from './a'` (TS 5.0) with `type` blanked: the grammar (0.23.2, the latest on
 * npm) cannot parse it and would turn the whole file to text (§15 #11). Lines and columns stay.
 */
function withoutTypeStar(text: string): string {
  return text.replace(
    /\bexport(\s+)type(\s+)\*/g,
    (_m, a: string, b: string) => `export${a}    ${b}*`,
  );
}
