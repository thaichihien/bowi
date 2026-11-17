/**
 * Stage 8: outside references (GRAPH-11, UI-8): unchanged code that uses a changed symbol.
 *
 * Input: snapshot (its `grep`), files, hunks, symbols and parsed sources. Output: at most
 * `outsideRefs.maxPerSymbol` references per changed symbol, and how many were found in all.
 *
 * The head version is searched for each changed symbol's name as a whole word, then matches are
 * kept only when they are plausible uses, not just the same word:
 * - not on a line the PR adds, not inside a changed symbol (that code is in the review already),
 *   not in an import, a comment or a string, not in a generated file;
 * - a method `C.m` is called as `.m(` in a file that names `C` (an import, a type, an injection);
 * - a function, class, type or constant is used in its own file or in a file that imports it.
 * References in other files come first, then the symbol's own file; within that, by path.
 */

import type { ParsedSource } from '@bowi/lang';
import { compareStrings } from '../determinism.ts';
import { createGeneratedMatcher } from '../noise/generated.ts';
import type { GrepMatch, Snapshot } from '../snapshot.ts';
import type { Stage } from '../stage.ts';
import type { ChangedSymbol, FileChange, Hunk, OutsideReference } from '../types.ts';
import type { FileSources } from './parse.ts';

export interface RefsStageInput {
  snapshot: Snapshot;
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  sources: Map<string, FileSources>;
}

export interface RefsStageOutput {
  outsideRefs: OutsideReference[];
  /** References found per symbol ID before the per-symbol limit. */
  counts: Map<string, number>;
}

/** Languages whose files can call each other: TypeScript imports JavaScript and back. */
const CODE_LANGUAGES = new Set(['typescript', 'tsx', 'javascript', 'vue', 'svelte', 'astro']);
export const CODE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
];
const SEARCHED_KINDS = new Set<ChangedSymbol['kind']>([
  'function',
  'method',
  'class',
  'interface',
  'type',
  'variable',
]);
const SEARCHED_CHANGES = new Set<ChangedSymbol['change']>([
  'body',
  'signature',
  'renamed',
  'deleted',
]);
/** Shorter names match too much unrelated code. */
const MIN_NAME_LENGTH = 3;
/** Files read to check imports, over all symbols; more is a warning, not an error. */
const MAX_FILES_READ = 400;
const MAX_EXCERPT = 200;

interface Target {
  symbol: ChangedSymbol;
  /** The name callers use: the old name for renamed and deleted symbols. */
  name: string;
  /** For methods: the class name callers must mention. */
  owner?: string;
  path: string;
}

export const refsStage: Stage<RefsStageInput, RefsStageOutput> = async (input, ctx) => {
  const { snapshot, files, hunks, symbols, sources } = input;
  const limit = ctx.config.outsideRefs.maxPerSymbol;
  const empty = { outsideRefs: [], counts: new Map<string, number>() };
  if (limit === 0 || !snapshot.grep) return empty;

  const fileById = new Map(files.map((f) => [f.id, f]));
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const targets = symbols.flatMap((s) => {
    const t = targetOf(s, fileById.get(s.fileId)!, sources.get(s.fileId), hunkById);
    return t ? [t] : [];
  });
  if (targets.length === 0) return empty;

  let matches: GrepMatch[];
  try {
    matches = await snapshot.grep(
      [...new Set(targets.map((t) => t.name))].sort(compareStrings),
      CODE_EXTENSIONS,
    );
  } catch (e) {
    ctx.warn(
      `Could not search for outside references (${e instanceof Error ? e.message : String(e)})`,
    );
    return empty;
  }

  // What is already in the review: lines the PR adds, and changed symbols' code.
  const added = new Set<string>();
  for (const h of hunks) {
    const path = fileById.get(h.fileId)!.path;
    for (const l of h.lines) if (l.kind === 'add') added.add(`${path}:${l.newNo}`);
  }
  const changedRanges = new Map<string, [number, number][]>();
  for (const s of symbols) {
    if (s.kind === 'file' || s.change === 'deleted') continue;
    const sym = sources
      .get(s.fileId)
      ?.new?.symbols.find((x) => x.qualifiedName === s.qualifiedName);
    if (!sym) continue;
    const path = fileById.get(s.fileId)!.path;
    changedRanges.set(path, [...(changedRanges.get(path) ?? []), [sym.startLine, sym.endLine]]);
  }
  const generated = createGeneratedMatcher(
    ctx.config.generated,
    await snapshot.readFile('new', '.gitattributes'),
  );
  const inReview = (m: GrepMatch) =>
    added.has(`${m.path}:${m.line}`) ||
    (changedRanges.get(m.path) ?? []).some(([a, b]) => m.line >= a && m.line <= b);

  const byName = new Map<string, Target[]>();
  for (const t of targets) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);

  // Line-level candidates per target, then file-level checks (imports) on the files they are in.
  const candidates = new Map<Target, GrepMatch[]>();
  const sorted = [...matches].sort((a, b) => compareStrings(a.path, b.path) || a.line - b.line);
  for (const m of sorted) {
    if (inReview(m) || generated.byPath(m.path)) continue;
    // A first cut on the line alone; block comments need the whole file (below).
    const code = codeOnly(m.text);
    for (const token of new Set(identifiers(code))) {
      for (const t of byName.get(token) ?? []) {
        if (t.owner && !callsMethod(code, t.name)) continue;
        candidates.set(t, [...(candidates.get(t) ?? []), m]);
      }
    }
  }

  const facts = new Map<string, FileFacts | null>();
  let skippedFiles = 0;
  const factsOf = async (path: string): Promise<FileFacts | null> => {
    if (facts.has(path)) return facts.get(path)!;
    if (facts.size >= MAX_FILES_READ) {
      skippedFiles++;
      return null;
    }
    const text = await snapshot.readFile('new', path);
    const f = text === null ? null : fileFacts(text);
    facts.set(path, f);
    return f;
  };

  const fileIdOfPath = new Map(files.map((f) => [f.path, f.id]));
  const outsideRefs: OutsideReference[] = [];
  const counts = new Map<string, number>();
  for (const t of targets) {
    const kept: { m: GrepMatch; rank: number }[] = [];
    for (const m of candidates.get(t) ?? []) {
      const f = await factsOf(m.path);
      if (!f || f.importLines.has(m.line)) continue;
      const code = f.codeLines[m.line - 1] ?? '';
      const uses = t.owner ? callsMethod(code, t.name) : identifiers(code).includes(t.name);
      if (!uses) continue;
      const sameFile = m.path === t.path;
      if (t.owner) {
        if (!sameFile && !f.words.has(t.owner)) continue;
      } else if (!sameFile && !f.imported.has(t.name)) continue;
      kept.push({ m, rank: sameFile ? 1 : 0 });
    }
    if (kept.length === 0) continue;
    counts.set(t.symbol.id, kept.length);
    kept.sort((a, b) => a.rank - b.rank);
    // One per file first, so five callers in one file do not hide the others.
    const seen = new Set<string>();
    const first = kept.filter((k) => !seen.has(k.m.path) && seen.add(k.m.path));
    const rest = kept.filter((k) => !first.includes(k));
    const chosen = [...first, ...rest]
      .slice(0, limit)
      .sort((a, b) => a.rank - b.rank || compareStrings(a.m.path, b.m.path) || a.m.line - b.m.line);
    for (const { m } of chosen) {
      const ref: OutsideReference = {
        symbolId: t.symbol.id,
        path: m.path,
        line: m.line,
        excerpt: excerpt(m.text),
      };
      const fileId = fileIdOfPath.get(m.path);
      if (fileId) ref.fileId = fileId;
      outsideRefs.push(ref);
    }
  }
  if (skippedFiles > 0) {
    ctx.warn(
      `Outside references: stopped reading after ${MAX_FILES_READ} files; some callers may be missing`,
    );
  }
  return { outsideRefs, counts };
};

function targetOf(
  s: ChangedSymbol,
  file: FileChange,
  src: FileSources | undefined,
  hunkById: Map<string, Hunk>,
): Target | undefined {
  if (!SEARCHED_KINDS.has(s.kind) || !SEARCHED_CHANGES.has(s.change)) return undefined;
  if (!file.language || !CODE_LANGUAGES.has(file.language) || file.generated) return undefined;
  if (s.layer === 'test' || s.layer === 'docs' || s.layer === 'config') return undefined;
  if (s.hunkIds.every((id) => hunkById.get(id)!.kind !== 'logic')) return undefined;

  let qualified = s.qualifiedName;
  let path = file.path;
  if (s.change === 'renamed' || s.change === 'deleted') {
    const old = oldSymbol(s, src?.old);
    if (!old) return undefined;
    qualified = old.qualifiedName;
    path = file.oldPath ?? file.path;
  }
  const parts = qualified.split('.');
  // Top-level symbols and methods of top-level classes; test blocks and deeper nesting are not
  // called by name from elsewhere.
  if (parts.length > 2 || (parts.length === 2 && s.kind !== 'method')) return undefined;
  const name = parts.at(-1)!;
  if (name.length < MIN_NAME_LENGTH || name === 'constructor' || !/^[A-Za-z_$][\w$]*$/.test(name))
    return undefined;
  const target: Target = { symbol: s, name, path };
  if (parts.length === 2) target.owner = parts[0]!;
  return target;
}

function oldSymbol(s: ChangedSymbol, old: ParsedSource | undefined) {
  if (!old) return undefined;
  if (s.change === 'deleted') return old.symbols.find((x) => x.qualifiedName === s.qualifiedName);
  return old.symbols.find((x) => x.kind === s.kind && x.signature === s.oldSignature);
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const identifiers = (code: string): string[] => code.match(IDENTIFIER) ?? [];

function callsMethod(code: string, name: string): boolean {
  return new RegExp(`\\.\\s*${name.replace(/\$/g, '\\$')}\\s*(<[^>]*>)?\\s*\\(`).test(code);
}

/**
 * The text with comments and the contents of strings blanked out (line breaks kept), so a name
 * in a doc comment or a test title is not a use. Template literals keep their `${…}` code.
 * Regular expression literals are not recognized; a `//` inside one cuts the line short.
 */
export function codeOnly(text: string): string {
  const out = [...text];
  const n = out.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const templates: number[] = []; // brace depth at each open `${`
  let depth = 0;
  // Blanks template text from `i` to the closing backtick or the next `${`; returns the next index.
  const template = (i: number): number => {
    let j = i;
    while (j < n && out[j] !== '`' && !(out[j] === '$' && out[j + 1] === '{'))
      j += out[j] === '\\' ? 2 : 1;
    blank(i, j);
    if (j < n && out[j] === '$') {
      templates.push(++depth);
      return j + 2;
    }
    return j + 1;
  };
  let i = 0;
  while (i < n) {
    const c = out[i]!;
    if (c === '/' && out[i + 1] === '/') {
      let e = i;
      while (e < n && out[e] !== '\n') e++;
      blank(i, e);
      i = e;
    } else if (c === '/' && out[i + 1] === '*') {
      let e = i + 2;
      while (e < n && !(out[e] === '*' && out[e + 1] === '/')) e++;
      blank(i, e + 2);
      i = e + 2;
    } else if (c === "'" || c === '"') {
      let e = i + 1;
      while (e < n && out[e] !== c && out[e] !== '\n') e += out[e] === '\\' ? 2 : 1;
      blank(i + 1, e);
      i = e + 1;
    } else if (c === '`') {
      i = template(i + 1);
    } else if (c === '}' && templates.at(-1) === depth) {
      templates.pop();
      depth--;
      i = template(i + 1);
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
  }
  return out.join('');
}

interface FileFacts {
  /** Names brought in by import statements (or require destructuring). */
  imported: Set<string>;
  /** 1-based lines that belong to import statements. */
  importLines: Set<number>;
  /** Every identifier in the file's code (not in comments or strings). */
  words: Set<string>;
  /** The file's lines with comments and string contents blanked. */
  codeLines: string[];
}

const IMPORT_RE =
  /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*['"][^'"]+['"]|^[ \t]*(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(/gm;

function fileFacts(text: string): FileFacts {
  const imported = new Set<string>();
  const importLines = new Set<number>();
  for (const m of text.matchAll(IMPORT_RE)) {
    for (const w of m[0].match(/[A-Za-z_$][\w$]*/g) ?? []) imported.add(w);
    const first = text.slice(0, m.index).split('\n').length;
    const count = m[0].split('\n').length;
    for (let i = 0; i < count; i++) importLines.add(first + i);
  }
  const code = codeOnly(text);
  return {
    imported,
    importLines,
    words: new Set(identifiers(code)),
    codeLines: code.split('\n'),
  };
}

function excerpt(text: string): string {
  const t = text.trim();
  return t.length > MAX_EXCERPT ? `${t.slice(0, MAX_EXCERPT - 1)}…` : t;
}
