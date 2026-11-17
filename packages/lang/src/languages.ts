/**
 * Supported languages (PARSE-2) and how a file path maps to one.
 */

export type LanguageId =
  'typescript' | 'tsx' | 'javascript' | 'json' | 'yaml' | 'markdown' | 'vue' | 'svelte' | 'astro';

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
  // Single-file components (M14): their scripts are parsed as TypeScript, the rest is text
  // (component.ts).
  vue: { grammar: 'tree-sitter-typescript.wasm', query: 'typescript.scm', extensions: ['.vue'] },
  svelte: {
    grammar: 'tree-sitter-typescript.wasm',
    query: 'typescript.scm',
    extensions: ['.svelte'],
  },
  astro: {
    grammar: 'tree-sitter-typescript.wasm',
    query: 'typescript.scm',
    extensions: ['.astro'],
  },
  // Block structure only (sections, paragraphs, lists); inline markup stays text.
  markdown: {
    grammar: 'tree-sitter-markdown.wasm',
    query: 'markdown.scm',
    extensions: ['.md', '.markdown'],
  },
};

/** Languages whose files hold scripts inside markup: `.vue`, `.svelte`, `.astro`. */
export const COMPONENT_LANGUAGES: ReadonlySet<LanguageId> = new Set(['vue', 'svelte', 'astro']);

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
