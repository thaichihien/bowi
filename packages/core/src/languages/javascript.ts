/**
 * TypeScript and JavaScript, with the scripts of Vue, Svelte and Astro components (M14): one
 * family, since each imports the others. The first language family (M15); its rules are those
 * the engine always had.
 */

import { posix } from 'node:path';
import type { DiffLine, FileChange } from '../types.ts';
import type { FileFacts, ImportResolver, LanguageFamily } from './family.ts';

const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.vue',
  '.svelte',
  '.astro',
];

const CODE_EXTENSIONS = [
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

function createImportResolver(files: FileChange[]): ImportResolver {
  const byPath = new Map<string, string>();
  for (const f of files) {
    byPath.set(f.path, f.id);
    if (f.oldPath) byPath.set(f.oldPath, f.id);
  }
  const withoutExt = new Map<string, string>();
  for (const [path, id] of byPath) withoutExt.set(stripExt(path), id);

  return (fromPath, specifier) => {
    if (specifier.startsWith('.')) {
      const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
      // TypeScript ESM imports name the compiled file: `./x.js` means `./x.ts`.
      const stem = /\.[cm]?jsx?$/.test(base) ? stripExt(base) : base;
      for (const candidate of [
        base,
        ...EXTENSIONS.map((e) => stem + e),
        ...EXTENSIONS.map((e) => `${base}/index${e}`),
      ]) {
        const id = byPath.get(candidate);
        if (id) return id;
      }
      return undefined;
    }
    // Path aliases such as `@/mail/mail.service`: match the trailing path segments.
    if (!specifier.includes('/')) return undefined;
    // SvelteKit's `$lib` is `src/lib`.
    const tail = stripExt(specifier.replace(/^[@~#]\//, '').replace(/^\$lib\//, 'lib/'));
    for (const [path, id] of withoutExt) {
      if (path === tail || path.endsWith(`/${tail}`)) return id;
    }
    return undefined;
  };
}

/** Removes a source-file extension; `mail.service` keeps its `.service`. */
function stripExt(path: string): string {
  const ext = EXTENSIONS.find((e) => path.endsWith(e));
  return ext ? path.slice(0, -ext.length) : path;
}

const NOT_NAMES = new Set(['import', 'from', 'type', 'as', 'default', 'export', 'typeof']);

/** `private readonly events: EventEmitter2,` or `@InjectRepository(X) private repo: Repository<X>,` */
const INJECTED =
  /^\s*(?:@[\w$.]+\([^)]*\)\s*)*(?:(?:private|protected|public|readonly)\s+)+([A-Za-z_$][\w$]*)\??\s*:\s*[^;=]+,?\s*$/;

/**
 * Lines of the hunk that belong to import statements: `import … from '…'`, and the lines of a
 * multi-line import, also when the hunk starts inside one (a list of names ending in `} from`).
 */
function importLineIndexes(lines: DiffLine[]): Set<number> {
  const out = new Set<number>();
  let open = false;
  lines.forEach((l, i) => {
    const t = l.text.trim();
    if (!open && /^import\b/.test(t)) {
      out.add(i);
      open = !/(\bfrom\s*['"][^'"]*['"]|^import\s*['"][^'"]*['"])\s*;?$/.test(t);
    } else if (open) {
      out.add(i);
      if (/\bfrom\s*['"][^'"]*['"]\s*;?$/.test(t)) open = false;
    } else if (/^\}\s*from\s*['"][^'"]*['"]\s*;?$/.test(t)) {
      // The end of an import whose start is before the hunk: claim the name list above it.
      out.add(i);
      for (let j = i - 1; j >= 0 && NAME_LINE.test(lines[j]!.text); j--) out.add(j);
    }
  });
  return out;
}

/** One line of an import's name list: `  OrderEventCollector,` or `  type X as Y,`. */
const NAME_LINE = /^\s*(?:type\s+)?[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*,?\s*$/;

function importedNames(line: string): string[] {
  const code = codeOf(line);
  return [...code.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((m) => m[0])
    .filter((n, i, all) => !NOT_NAMES.has(n) && all.indexOf(n) === i);
}

/** A line without its string literals: `from 'node:events'` does not use a field `events`. */
function codeOf(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
}

// First and last line of an import or re-export, also when it spans lines (`} from "./x"`):
// module paths say nothing about which changes belong together (imports are resolved anyway).
const IMPORT_LINE =
  /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|\}\s*from\s*['"]|.*\brequire\s*\()/;

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
function codeOnly(text: string): string {
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

export const javascript: LanguageFamily = {
  id: 'javascript',
  languages: new Set(['typescript', 'tsx', 'javascript', 'vue', 'svelte', 'astro']),
  extensions: CODE_EXTENSIONS,
  createImportResolver,
  testSubject: (stem) => stem.replace(/\.(spec|test|e2e-spec)$/, ''),
  importLineIndexes,
  importedNames,
  injectedParameter: INJECTED,
  constructorName: 'constructor',
  codeOf,
  importLine: IMPORT_LINE,
  codeOnly,
  identifiers,
  isName: (name) => /^[A-Za-z_$][\w$]*$/.test(name),
  callsMethod,
  fileFacts,
};
