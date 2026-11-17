/**
 * Single-file components (M14): `.vue`, `.svelte` and `.astro` files. Their scripts (Vue and
 * Svelte `<script>` blocks, Astro's frontmatter and `<script>` tags) are parsed with the
 * TypeScript grammar in place: everything else is blanked out, so symbols and references keep
 * their lines. The markup stays text, with two additions:
 *
 * - references for what it uses: component tags (`<UserCard>`, `<user-card>` → `UserCard`) and
 *   names in bindings and expressions (`@click="save"`, `{count}`, `{{ total }}`);
 * - content lines and fingerprints that see markup changes, so a template-only change is never
 *   taken for formatting. Whitespace in markup does not count, so rewrapped tags still are.
 */

import { createHash } from 'node:crypto';
import type { LanguageId } from './languages.ts';
import type { ParsedSource } from './parse.ts';
import type { Reference } from './references.ts';

/** Script blocks: `<script>`, `<script setup lang="ts">`, `<script context="module">`. */
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
/** Scripts in another language than JavaScript: JSON-LD, templates. */
const NOT_SCRIPT = /\btype\s*=\s*["'](?!module|text\/javascript|application\/javascript|ts)/i;
const PASCAL_TAG = /<([A-Z][A-Za-z0-9_]*)/g;
const KEBAB_TAG = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g;
/** Expressions in markup: Vue bindings and directives, `{{ }}`, Svelte and Astro `{ }`. */
const EXPRESSION =
  /(?:[:@#]|\bv-[\w-]+|\bon:[\w-]+|\bbind:[\w-]+|\buse:[\w-]+)(?:[\w.:-]*)\s*=\s*"([^"]*)"|\{\{([\s\S]*?)\}\}|\{([^{}]*)\}/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
/** Words of the markup languages, never names of the component's own code. */
const KEYWORDS = new Set([
  'if',
  'else',
  'each',
  'as',
  'await',
  'then',
  'catch',
  'key',
  'true',
  'false',
  'null',
  'undefined',
  'in',
  'of',
  'typeof',
  'new',
  'return',
  'const',
  'let',
  'html',
  'debug',
  'snippet',
  'render',
]);

type Parse = (language: LanguageId, text: string) => Promise<ParsedSource>;

export async function parseComponent(
  language: LanguageId,
  text: string,
  parse: Parse,
): Promise<ParsedSource> {
  const ranges = scriptRanges(language, text);
  const masked = mask(text, ranges);
  const script = await parse('typescript', masked);

  const lines = text.split('\n');
  const lineStarts: number[] = [];
  let at = 0;
  for (const l of lines) {
    lineStarts.push(at);
    at += l.length + 1;
  }
  // A line is markup unless all of its non-blank text is script.
  const isMarkup = (n: number): boolean => {
    const start = lineStarts[n - 1];
    if (start === undefined) return false;
    const raw = lines[n - 1]!;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i]!.trim() === '') continue;
      const pos = start + i;
      if (!ranges.some(([s, e]) => pos >= s && pos < e)) return true;
    }
    return false;
  };
  const markup = new Map<number, string>();
  for (let n = 1; n <= lines.length; n++) {
    const raw = lines[n - 1]!;
    if (raw.trim() !== '' && isMarkup(n)) markup.set(n, raw);
  }
  const markupText = (from: number, to: number) => {
    const parts: string[] = [];
    for (let n = from; n <= to; n++) {
      const raw = markup.get(n);
      if (raw !== undefined) parts.push(raw);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

  return {
    ...script,
    language,
    references: [...script.references, ...markupReferences(markup)],
    fingerprint: hash(`${script.fingerprint}\n${markupText(1, lines.length)}`),
    isContentLine: (n) => markup.has(n) || script.isContentLine(n),
    coverFingerprint: (from, to) =>
      hash(`${script.coverFingerprint(from, to)}\n${markupText(from, to)}`),
  };
}

/** Character ranges `[start, end)` of the script code in a component file. */
export function scriptRanges(language: LanguageId, text: string): [number, number][] {
  const ranges: [number, number][] = [];
  if (language === 'astro') {
    // Frontmatter: from a first line `---` to the next line `---`.
    const open = /^\uFEFF?\s*---[ \t]*\r?\n/.exec(text);
    if (open) {
      const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(open[0].length));
      if (close) ranges.push([open[0].length, open[0].length + close.index + 1]);
    }
  }
  for (const m of text.matchAll(SCRIPT_BLOCK)) {
    if (NOT_SCRIPT.test(m[1] ?? '')) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    ranges.push([start, start + m[2]!.length]);
  }
  return ranges;
}

/** The text with everything outside `ranges` blanked, line breaks kept. */
function mask(text: string, ranges: [number, number][]): string {
  const out = text.split('');
  let r = 0;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < out.length; i++) {
    while (r < sorted.length && i >= sorted[r]![1]) r++;
    const inside = r < sorted.length && i >= sorted[r]![0];
    if (!inside && out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  }
  return out.join('');
}

function markupReferences(markup: Map<number, string>): Reference[] {
  const refs: Reference[] = [];
  for (const [line, raw] of markup) {
    for (const m of raw.matchAll(PASCAL_TAG)) refs.push({ name: m[1]!, kind: 'name', line });
    for (const m of raw.matchAll(KEBAB_TAG)) {
      const name = m[1]!.replace(/(^|-)([a-z0-9])/g, (_a, _d, c: string) => c.toUpperCase());
      refs.push({ name, kind: 'name', line });
    }
    for (const m of raw.matchAll(EXPRESSION)) {
      const code = (m[1] ?? m[2] ?? m[3] ?? '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ');
      for (const id of code.matchAll(IDENTIFIER)) {
        const name = id[0];
        if (KEYWORDS.has(name) || /^[#/:@]/.test(name)) continue;
        // `user.name`: the first name is what the component's code declares.
        const before = code[id.index - 1];
        refs.push({ name, kind: before === '.' ? 'member' : 'name', line });
      }
    }
  }
  return refs;
}
