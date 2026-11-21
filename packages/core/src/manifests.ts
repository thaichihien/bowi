/**
 * Dependencies a PR adds in Python and Go manifests (M15), which have no grammar here:
 * `requirements*.txt`, `pyproject.toml` (PEP 621, dependency groups, Poetry), `Pipfile` and
 * `go.mod`. A name counts when an added line declares it in a dependency list and no removed
 * line of the file names it (a version bump is not a new dependency). Go's `// indirect`
 * requirements are left out: the code does not import them.
 */

import type { NewDependency } from './plugin.ts';
import type { Hunk } from './types.ts';

const MANIFEST = /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod)$/;

export function isLineManifest(path: string): boolean {
  return MANIFEST.test(path);
}

/** Dependencies declared on the file's added lines, in line order. */
export function addedDependencies(path: string, newText: string, hunks: Hunk[]): NewDependency[] {
  const added = new Set<number>();
  const removedNames = new Set<string>();
  const declared = declarations(path, newText);
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') added.add(l.newNo!);
      if (l.kind === 'del') {
        const name = nameOnLine(path, l.text);
        if (name) removedNames.add(name);
      }
    }
  }
  const out: NewDependency[] = [];
  for (const d of declared) {
    if (!added.has(d.line) || removedNames.has(d.name)) continue;
    if (!out.some((x) => x.name === d.name)) out.push({ name: d.name, dev: d.dev });
  }
  return out;
}

interface Declaration {
  name: string;
  dev: boolean;
  /** 1-based. */
  line: number;
}

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const PEP508 = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(==|>=|<=|~=|!=|===|>|<|@|;|$)/;
const QUOTED = /^\s*["']([A-Za-z0-9][A-Za-z0-9._-]*)/;
const KEY_VALUE = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/;
const GO_REQUIRE = /^\s*(?:require\s+)?([A-Za-z0-9][\w.~-]*\.[\w.~-]+(?:\/[\w.~-]+)*)\s+v\d/;
const DEV_NAME = /(^|[-_.])(dev|test|tests|testing|lint|docs?|typing)([-_.]|$)/i;

/** The dependency a line names in this kind of manifest, ignoring where it is (removed lines). */
function nameOnLine(path: string, text: string): string | undefined {
  const name = base(path);
  if (name === 'go.mod') return GO_REQUIRE.exec(text)?.[1];
  if (name.endsWith('.txt')) return requirement(text);
  return (QUOTED.exec(text) ?? KEY_VALUE.exec(text))?.[1]?.toLowerCase();
}

function requirement(text: string): string | undefined {
  const t = text.trim();
  if (!t || t.startsWith('#') || t.startsWith('-')) return undefined;
  return PEP508.exec(t)?.[1]?.toLowerCase();
}

function declarations(path: string, text: string): Declaration[] {
  const name = base(path);
  const lines = text.split('\n');
  const out: Declaration[] = [];
  if (name.endsWith('.txt')) {
    const dev = DEV_NAME.test(name.replace(/\.txt$/, ''));
    lines.forEach((l, i) => {
      const n = requirement(l);
      if (n) out.push({ name: n, dev, line: i + 1 });
    });
    return out;
  }
  if (name === 'go.mod') {
    let block = false;
    lines.forEach((l, i) => {
      const t = l.trim();
      if (/^require\s*\($/.test(t)) block = true;
      else if (block && t === ')') block = false;
      else if ((block || /^require\s/.test(t)) && !/\/\/\s*indirect\b/.test(t)) {
        const m = GO_REQUIRE.exec(t);
        if (m) out.push({ name: m[1]!, dev: false, line: i + 1 });
      }
    });
    return out;
  }
  // TOML: pyproject.toml and Pipfile.
  let section = '';
  let array: { dev: boolean } | undefined;
  lines.forEach((l, i) => {
    const t = l.replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(t);
    if (header) {
      section = header[1]!.trim();
      array = undefined;
      return;
    }
    if (array) {
      const m = QUOTED.exec(t);
      if (m) out.push({ name: m[1]!.toLowerCase(), dev: array.dev, line: i + 1 });
      if (t.includes(']')) array = undefined;
      return;
    }
    const kv = KEY_VALUE.exec(t);
    if (!kv) return;
    const key = kv[1]!;
    const list = listSection(section, key);
    if (list && /=\s*\[/.test(t)) {
      array = list;
      // One-line array: `dependencies = ["a", "b"]`.
      for (const m of t.slice(t.indexOf('[') + 1).matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g))
        out.push({ name: m[1]!.toLowerCase(), dev: list.dev, line: i + 1 });
      if (t.includes(']')) array = undefined;
      return;
    }
    const table = tableSection(section);
    if (table && key !== 'python')
      out.push({ name: key.toLowerCase(), dev: table.dev, line: i + 1 });
  });
  return out;
}

/** A key whose value is a list of requirement strings. */
function listSection(section: string, key: string): { dev: boolean } | undefined {
  if (section === 'project' && key === 'dependencies') return { dev: false };
  if (section === 'project.optional-dependencies') return { dev: DEV_NAME.test(key) };
  if (section === 'dependency-groups') return { dev: true };
  return undefined;
}

/** A table whose keys are dependency names. */
function tableSection(section: string): { dev: boolean } | undefined {
  if (section === 'tool.poetry.dependencies' || section === 'packages') return { dev: false };
  if (section === 'tool.poetry.dev-dependencies' || section === 'dev-packages')
    return { dev: true };
  const group = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(section);
  if (group) return { dev: group[1] !== 'main' };
  return undefined;
}
