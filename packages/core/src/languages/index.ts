/**
 * Language families (M15): see family.ts. A file's family comes from its parsed language.
 */

import { csharp } from './csharp.ts';
import type { LanguageFamily } from './family.ts';
import { go } from './go.ts';
import { java } from './java.ts';
import { javascript } from './javascript.ts';
import { python } from './python.ts';

export type { FileFacts, ImportResolver, LanguageFamily } from './family.ts';
export { csharp } from './csharp.ts';
export { go } from './go.ts';
export { java } from './java.ts';
export { javascript } from './javascript.ts';
export { python } from './python.ts';

export const FAMILIES: readonly LanguageFamily[] = [javascript, python, go, java, csharp];

/** The family rules that apply to every file fall back to. */
export const DEFAULT_FAMILY: LanguageFamily = javascript;

/** The family of a parsed language, or undefined for data and docs (JSON, YAML, Markdown, text). */
export function familyOf(language: string | undefined): LanguageFamily | undefined {
  return language === undefined ? undefined : FAMILIES.find((f) => f.languages.has(language));
}
