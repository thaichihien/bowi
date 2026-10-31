/**
 * Supported languages (PARSE-2) and how a file path maps to one.
 */

export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'json' | 'yaml' | 'markdown';

interface LanguageSpec {
  grammar: string;
  query: string;
  extensions: string[];
}

export const LANGUAGES: Record<LanguageId, LanguageSpec> = {
  typescript: {
    grammar: 'tree-sitter-typescript.wasm',
    query: 'typescript.scm',
    extensions: ['.ts', '.mts', '.cts'],
  },
  tsx: { grammar: 'tree-sitter-tsx.wasm', query: 'typescript.scm', extensions: ['.tsx'] },
  // The JavaScript grammar parses JSX too.
  javascript: {
    grammar: 'tree-sitter-javascript.wasm',
    query: 'javascript.scm',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
  },
  json: { grammar: 'tree-sitter-json.wasm', query: 'json.scm', extensions: ['.json'] },
  yaml: { grammar: 'tree-sitter-yaml.wasm', query: 'yaml.scm', extensions: ['.yaml', '.yml'] },
  // Block structure only (sections, paragraphs, lists); inline markup stays text.
  markdown: {
    grammar: 'tree-sitter-markdown.wasm',
    query: 'markdown.scm',
    extensions: ['.md', '.markdown'],
  },
};

/** Language for a path by extension, or undefined when Bowi has no grammar for it (tier 0). */
export function languageForPath(path: string): LanguageId | undefined {
  if (path.endsWith('.d.ts')) return 'typescript';
  const dot = path.lastIndexOf('.');
  if (dot <= path.lastIndexOf('/')) return undefined;
  const ext = path.slice(dot).toLowerCase();
  for (const [id, spec] of Object.entries(LANGUAGES) as [LanguageId, LanguageSpec][]) {
    if (spec.extensions.includes(ext)) return id;
  }
  return undefined;
}
