/**
 * Lazily initializes web-tree-sitter and loads vendored grammars and queries, once per process.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query } from 'web-tree-sitter';
import { LANGUAGES, type LanguageId } from './languages.ts';

export interface LoadedLanguage {
  parser: Parser;
  query: Query;
}

let init: Promise<void> | undefined;
const loaded = new Map<LanguageId, Promise<LoadedLanguage>>();

// Works from both src/ and dist/: grammars/ and queries/ sit next to them in the package.
const asset = (dir: string, file: string) =>
  fileURLToPath(new URL(`../${dir}/${file}`, import.meta.url));

export function loadLanguage(id: LanguageId): Promise<LoadedLanguage> {
  let entry = loaded.get(id);
  if (!entry) {
    entry = (async () => {
      init ??= Parser.init();
      await init;
      const spec = LANGUAGES[id];
      const language = await Language.load(asset('grammars', spec.grammar));
      const parser = new Parser();
      parser.setLanguage(language);
      const query = new Query(language, readFileSync(asset('queries', spec.query), 'utf8'));
      return { parser, query };
    })();
    loaded.set(id, entry);
  }
  return entry;
}
