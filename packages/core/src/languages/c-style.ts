/**
 * Comments and strings of the C-style languages of M16 (Java, Kotlin, C#): `//` and `/* *\/`
 * comments, `"…"` strings and `'x'` characters with backslash escapes, and `"""…"""` text
 * blocks. Kotlin's block comments nest; C#'s verbatim strings (`@"…"`) escape a quote by
 * doubling it and may span lines, and its raw strings open with three or more quotes.
 */

export interface CStyleOptions {
  /** Kotlin: `/* /* *\/ *\/` is one comment. */
  nestedComments?: boolean;
  /** C#: `@"…"` (also `$@"…"`, `@$"…"`). */
  verbatimStrings?: boolean;
}

/** The text with comments and string contents blanked (line breaks kept). */
export function codeOnlyCStyle(text: string, options: CStyleOptions = {}): string {
  const out = [...text];
  const n = out.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const quotesAt = (i: number) => {
    let e = i;
    while (out[e] === '"') e++;
    return e - i;
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
      let depth = 1;
      let e = i + 2;
      while (e < n && depth > 0) {
        if (out[e] === '*' && out[e + 1] === '/') {
          depth--;
          e += 2;
        } else if (options.nestedComments && out[e] === '/' && out[e + 1] === '*') {
          depth++;
          e += 2;
        } else e++;
      }
      blank(i, e);
      i = e;
    } else if (c === '"' && quotesAt(i) >= 3) {
      // A text block or raw string ends at the same run of quotes.
      const run = quotesAt(i);
      const close = '"'.repeat(run);
      let e = text.indexOf(close, i + run);
      if (e === -1) e = n;
      blank(i + run, e);
      i = e + run;
    } else if (c === '"' && options.verbatimStrings && isVerbatim(out, i)) {
      let e = i + 1;
      while (e < n && !(out[e] === '"' && out[e + 1] !== '"')) e += out[e] === '"' ? 2 : 1;
      blank(i + 1, e);
      i = e + 1;
    } else if (c === '"' || c === "'") {
      let e = i + 1;
      while (e < n && out[e] !== c && out[e] !== '\n') e += out[e] === '\\' ? 2 : 1;
      blank(i + 1, e);
      i = e + 1;
    } else i++;
  }
  return out.join('');
}

/** A C# string preceded by `@`, `$@` or `@$`. */
function isVerbatim(out: string[], quote: number): boolean {
  const a = out[quote - 1];
  const b = out[quote - 2];
  return a === '@' || (a === '$' && b === '@');
}

/** A line without its string and character literals. */
export function codeOfCStyle(line: string): string {
  return line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
}

const IDENTIFIER = /[A-Za-z_]\w*/g;

export const identifiersCStyle = (code: string): string[] => code.match(IDENTIFIER) ?? [];

/** `Name` without dots from an `a.b.Name` path. */
export const lastSegment = (dotted: string): string => dotted.slice(dotted.lastIndexOf('.') + 1);

/** A path without its extension: `src/a/User.java` → `src/a/User`. */
export function withoutExtension(path: string, extensions: readonly string[]): string | undefined {
  const ext = extensions.find((e) => path.endsWith(e));
  return ext ? path.slice(0, -ext.length) : undefined;
}
