/**
 * Dependencies a PR adds in Python and Go manifests (M15), which have no grammar here:
 * `requirements*.txt`, `pyproject.toml` (PEP 621, dependency groups, Poetry), `Pipfile` and
 * `go.mod`. A name counts when an added line declares it in a dependency list and no removed
 * line of the file names it (a version bump is not a new dependency). Go's `// indirect`
 * requirements are left out: the code does not import them.
 *
 * Java, Kotlin and C# (M16): Maven's `pom.xml` (the `artifactId` of a `<dependency>`, test scope
 * as dev), Gradle's `build.gradle(.kts)` (`implementation("g:a:v")`, `libs.x.y` from a version
 * catalog, test configurations as dev), the catalog `gradle/libs.versions.toml` (`[libraries]`),
 * and NuGet's `PackageReference` / `PackageVersion` in `*.csproj` and `Directory.Packages.props`
 * (a test project's as dev).
 */

import type { NewDependency } from './plugin.ts';
import type { Hunk } from './types.ts';

const MANIFEST =
  /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|pom\.xml|build\.gradle(\.kts)?|libs\.versions\.toml|[^/]*\.csproj|Directory\.Packages\.props)$/;

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

const POM_ARTIFACT = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/;
/** `implementation("g:a:v")`, `testImplementation 'g:a'`, `api(platform("g:a:v"))`. */
const GRADLE_COORDINATE =
  /^\s*(\w+)\s*\(?\s*(?:(?:platform|enforcedPlatform)\s*\(\s*)?["']([^"':\s]+:[^"':\s]+)(?::[^"']*)?["']/;
/** `implementation(libs.bytes)`, `ksp(libs.hilt.compiler)`. */
const GRADLE_CATALOG = /^\s*(\w+)\s*\(?\s*(?:(?:platform|enforcedPlatform)\s*\(\s*)?libs\.([\w.]+)/;
const GRADLE_CONFIG =
  /^(implementation|api|compileOnly|runtimeOnly|annotationProcessor|kapt|ksp|[a-z]\w*(Implementation|Api|CompileOnly|RuntimeOnly))$/;
const GRADLE_DEV = /^(test|androidTest|testFixtures|debug)|Test[A-Z]/;
const NUGET = /<Package(?:Reference|Version)\s+(?:Update|Include)\s*=\s*"([^"]+)"/;

/** A catalog alias as written in the build file's `libs.x.y`: `x-y` in the catalog. */
const alias = (ref: string) => ref.replace(/\./g, '-');

/** The dependency a line names in this kind of manifest, ignoring where it is (removed lines). */
function nameOnLine(path: string, text: string): string | undefined {
  const name = base(path);
  if (name === 'go.mod') return GO_REQUIRE.exec(text)?.[1];
  if (name === 'pom.xml') return POM_ARTIFACT.exec(text)?.[1];
  if (/^build\.gradle/.test(name)) {
    const m = GRADLE_COORDINATE.exec(text) ?? GRADLE_CATALOG.exec(text);
    if (!m || !GRADLE_CONFIG.test(m[1]!)) return undefined;
    return m[2]!.includes(':') ? m[2] : alias(m[2]!);
  }
  if (name === 'libs.versions.toml') return catalogEntry(text)?.name;
  if (name.endsWith('.csproj') || name.endsWith('.props')) return NUGET.exec(text)?.[1];
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
  if (name === 'pom.xml') return pomDependencies(lines);
  if (/^build\.gradle/.test(name)) {
    lines.forEach((l, i) => {
      const m = GRADLE_COORDINATE.exec(l) ?? GRADLE_CATALOG.exec(l);
      if (!m || !GRADLE_CONFIG.test(m[1]!)) return;
      const dep = m[2]!.includes(':') ? m[2]! : alias(m[2]!);
      out.push({ name: dep, dev: GRADLE_DEV.test(m[1]!), line: i + 1 });
    });
    return out;
  }
  if (name.endsWith('.csproj') || name.endsWith('.props')) {
    const dev = /(^|\/)tests?\/|Tests?(\.\w+)?\.csproj$/i.test(path);
    lines.forEach((l, i) => {
      const m = NUGET.exec(l);
      if (m) out.push({ name: m[1]!, dev, line: i + 1 });
    });
    return out;
  }
  if (name === 'libs.versions.toml') {
    let libraries = false;
    lines.forEach((l, i) => {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(l);
      if (header) libraries = header[1]!.trim() === 'libraries';
      else if (libraries) {
        const entry = catalogEntry(l);
        if (entry) out.push({ name: entry.name, dev: false, line: i + 1 });
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

/**
 * The `<artifactId>` of each `<dependency>` (not of plugins, exclusions or the project), on its
 * line; `<scope>test</scope>` makes it dev.
 */
function pomDependencies(lines: string[]): Declaration[] {
  const out: Declaration[] = [];
  let open: Declaration | undefined;
  let excluded = 0;
  lines.forEach((l, i) => {
    if (/<exclusion>/.test(l)) excluded++;
    if (/<\/exclusion>/.test(l)) excluded--;
    if (/<dependency>/.test(l)) open = { name: '', dev: false, line: 0 };
    if (open && excluded === 0) {
      const artifact = POM_ARTIFACT.exec(l)?.[1];
      if (artifact && !open.name) Object.assign(open, { name: artifact, line: i + 1 });
      if (/<scope>\s*test\s*<\/scope>/.test(l)) open.dev = true;
    }
    if (/<\/dependency>/.test(l)) {
      if (open?.name) out.push(open);
      open = undefined;
    }
  });
  return out;
}

/**
 * A `[libraries]` entry of a Gradle version catalog: `bytes = "com.acme:bytes:3.9.0"`,
 * `bytes = { module = "com.acme:bytes", … }` or `{ group = "…", name = "…" }`, named
 * `group:artifact`.
 */
function catalogEntry(line: string): { name: string } | undefined {
  const t = line.replace(/#.*$/, '');
  const m = /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(t);
  if (!m) return undefined;
  const value = m[2]!;
  const coordinate =
    /^["']([^"':\s]+:[^"':\s]+)/.exec(value)?.[1] ??
    /\bmodule\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
  if (coordinate) return { name: coordinate };
  const group = /\bgroup\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
  const artifact = /\bname\s*=\s*["']([^"']+)["']/.exec(value)?.[1];
  return group && artifact ? { name: `${group}:${artifact}` } : undefined;
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
