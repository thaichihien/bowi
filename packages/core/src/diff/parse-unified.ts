/**
 * Unified diff parser (DIFF-2, DIFF-3).
 *
 * Input: the text of `git diff` with `a/` / `b/` prefixes. Output: one ParsedFile per
 * `diff --git` section, in input order, with hunks and per-line old/new numbers. Handles added,
 * deleted, renamed, copied, mode-only and binary files, C-quoted paths and the
 * "\ No newline at end of file" marker. Pure: no I/O.
 */

import type { DiffLine } from '../types.ts';

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@`, usually the enclosing function line chosen by git. */
  section: string;
  lines: DiffLine[];
}

export interface ParsedFile {
  oldPath: string | null;
  newPath: string | null;
  kind: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: ParsedHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): ParsedFile[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();

  const files: ParsedFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith('diff --git ')) {
      i++;
      continue;
    }
    const start = i++;
    const file: ParsedFile = {
      oldPath: null,
      newPath: null,
      kind: 'modified',
      binary: false,
      hunks: [],
    };
    let minusPath: string | null | undefined;
    let plusPath: string | null | undefined;

    // Extended header lines, up to the first hunk or the next file.
    while (
      i < lines.length &&
      !lines[i]!.startsWith('diff --git ') &&
      !lines[i]!.startsWith('@@ ')
    ) {
      const h = lines[i++]!;
      if (h.startsWith('new file mode ')) {
        file.kind = 'added';
        file.newMode = h.slice(14);
      } else if (h.startsWith('deleted file mode ')) {
        file.kind = 'deleted';
        file.oldMode = h.slice(18);
      } else if (h.startsWith('old mode ')) file.oldMode = h.slice(9);
      else if (h.startsWith('new mode ')) file.newMode = h.slice(9);
      else if (h.startsWith('rename from ')) {
        file.kind = 'renamed';
        file.oldPath = unquote(h.slice(12));
      } else if (h.startsWith('rename to ')) file.newPath = unquote(h.slice(10));
      else if (h.startsWith('copy from ')) {
        file.kind = 'copied';
        file.oldPath = unquote(h.slice(10));
      } else if (h.startsWith('copy to ')) file.newPath = unquote(h.slice(8));
      else if (h.startsWith('similarity index ')) file.similarity = parseInt(h.slice(17), 10) / 100;
      else if (h.startsWith('Binary files ') || h === 'GIT binary patch') file.binary = true;
      else if (h.startsWith('--- ')) minusPath = headerPath(h.slice(4), 'a/');
      else if (h.startsWith('+++ ')) plusPath = headerPath(h.slice(4), 'b/');
      else if (h.startsWith('index ')) {
        const mode = h.split(' ')[2];
        if (mode && !file.oldMode && !file.newMode) file.oldMode = file.newMode = mode;
      }
    }

    // Path priority: rename/copy lines, then ---/+++ lines, then the `diff --git` line.
    if (file.kind !== 'renamed' && file.kind !== 'copied') {
      if (minusPath !== undefined || plusPath !== undefined) {
        file.oldPath = minusPath ?? null;
        file.newPath = plusPath ?? null;
      } else {
        const [a, b] = gitLinePaths(lines[start]!.slice(11));
        file.oldPath = a;
        file.newPath = b;
      }
      if (file.kind === 'added') file.oldPath = null;
      if (file.kind === 'deleted') file.newPath = null;
      if (file.kind === 'modified' && file.oldPath === null) file.kind = 'added';
      if (file.kind === 'modified' && file.newPath === null) file.kind = 'deleted';
    }

    // Hunks.
    while (i < lines.length && lines[i]!.startsWith('@@ ')) {
      const m = HUNK_HEADER.exec(lines[i]!);
      if (!m) throw new Error(`Malformed hunk header: ${lines[i]}`);
      i++;
      const hunk: ParsedHunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '',
        lines: [],
      };
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      let oldLeft = hunk.oldLines;
      let newLeft = hunk.newLines;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i]!.startsWith('\\'))) {
        const l = lines[i++]!;
        const marker = l[0];
        if (marker === '\\') {
          const last = hunk.lines.at(-1);
          if (last) last.noEol = true;
        } else if (marker === '+') {
          hunk.lines.push({ kind: 'add', text: l.slice(1), newNo: newNo++ });
          newLeft--;
        } else if (marker === '-') {
          hunk.lines.push({ kind: 'del', text: l.slice(1), oldNo: oldNo++ });
          oldLeft--;
        } else if (marker === ' ' || l === '') {
          hunk.lines.push({ kind: 'context', text: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
          oldLeft--;
          newLeft--;
        } else {
          throw new Error(`Unexpected line in hunk: ${l}`);
        }
      }
      file.hunks.push(hunk);
    }
    files.push(file);
  }
  return files;
}

/** Path from a `---` / `+++` line: `/dev/null` → null, otherwise strip quotes, prefix and tab. */
function headerPath(raw: string, prefix: string): string | null {
  // git appends a tab after names that contain a space.
  const value = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (value === '/dev/null') return null;
  const path = unquote(value);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Paths from `diff --git a/x b/y`. Only reached for files without ---/+++ lines (mode-only,
 * pure rename handled earlier, binary, empty added files), where old and new names are equal
 * unless quoted.
 */
function gitLinePaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    const a = unquote(rest.slice(0, end));
    const b = unquote(rest.slice(end + 1));
    return [strip(a, 'a/'), strip(b, 'b/')];
  }
  if (rest.endsWith('"')) {
    const bStart = rest.lastIndexOf(' "');
    return [strip(rest.slice(0, bStart), 'a/'), strip(unquote(rest.slice(bStart + 1)), 'b/')];
  }
  // "a/P b/P": both halves are the same length.
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  return [strip(a, 'a/'), strip(rest.slice(half + 1), 'b/')];
}

function strip(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function quotedEnd(s: string): number {
  for (let j = 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return s.length;
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Undoes git's C-style path quoting, including octal-escaped UTF-8 bytes. */
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let j = 0; j < body.length; j++) {
    const c = body[j]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[++j]!;
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(body.slice(j, j + 3), 8));
      j += 2;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
