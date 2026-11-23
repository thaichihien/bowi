/**
 * What the framework plugins share (PLG-1, M14): detection from package.json, lookups over the
 * changed code, routes from file paths, and the edges and hints several frameworks need
 * (components used in markup, constructor injection, new pages and API routes).
 */

import {
  createImportResolver,
  type ChangedSymbol,
  type FileChange,
  type HintDraft,
  type PluginEdge,
  type PluginGraphInput,
  type PluginRepo,
} from '@bowi/core';
import type { ParsedSource, Reference } from '@bowi/lang';

export const SCRIPT_LANGUAGES = new Set([
  'typescript',
  'tsx',
  'javascript',
  'vue',
  'svelte',
  'astro',
]);
export const COMPONENT_LANGUAGES = new Set(['vue', 'svelte', 'astro']);
export const TEST_PATH =
  /(^|\/)(test|tests|__tests__|e2e|spec)\/|\.(spec|test|e2e-spec|stories)\.[cm]?[jt]sx?$/;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Whether package.json text names one of the packages as a dependency. */
export function dependsOn(text: string, names: readonly string[]): boolean {
  try {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) =>
      names.some((name) => pkg[field]?.[name] !== undefined),
    );
  } catch {
    return false;
  }
}

/** The root package.json, and the nearest one of each changed file (monorepos), uses a package. */
export async function usesPackage(repo: PluginRepo, names: readonly string[]): Promise<boolean> {
  for (const dir of changedFolders(repo)) {
    const text = await readEither(repo, dir ? `${dir}/package.json` : 'package.json');
    if (text && dependsOn(text, names)) return true;
  }
  return false;
}

/** The folders of the changed files and every folder above them, the root first. */
function changedFolders(repo: PluginRepo): string[] {
  const dirs = new Set<string>(['']);
  for (const f of repo.files) {
    const parts = f.path.split('/').slice(0, -1);
    for (let i = parts.length; i > 0; i--) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}

/**
 * Files read during detection, per analysis (keyed by its list of changed files): every plugin
 * looks for the same manifests, and each missing one costs a git call.
 */
const detectionReads = new WeakMap<readonly FileChange[], Map<string, Promise<string | null>>>();

function readEither(repo: PluginRepo, path: string): Promise<string | null> {
  let reads = detectionReads.get(repo.files);
  if (!reads) detectionReads.set(repo.files, (reads = new Map()));
  let text = reads.get(path);
  if (!text) {
    text = (async () => (await repo.readFile('new', path)) ?? (await repo.readFile('old', path)))();
    reads.set(path, text);
  }
  return text;
}

/** Whether the change touches a file matching `paths`: the plugins of a language need one. */
export const changesAny = (repo: PluginRepo, paths: RegExp) =>
  repo.files.some((f) => paths.test(f.path));

/**
 * Whether a build manifest in the root or in the folder of a changed file (or above it) says the
 * project uses a framework (M17): `pom.xml`, `go.mod`, `pyproject.toml`, … `names` may hold
 * `{dir}`, the folder's own name, for `Api/Api.csproj`.
 */
export async function manifestSays(
  repo: PluginRepo,
  names: readonly string[],
  pattern: RegExp,
): Promise<boolean> {
  for (const dir of changedFolders(repo)) {
    const own = dir.slice(dir.lastIndexOf('/') + 1);
    for (const name of names) {
      if (name.includes('{dir}') && !own) continue;
      const file = name.replace('{dir}', own);
      const text = await readEither(repo, dir ? `${dir}/${file}` : file);
      if (text && pattern.test(text)) return true;
    }
  }
  return false;
}

/** How many changed files `codeSays` reads at most. */
const CODE_FILES_READ = 200;

/**
 * Whether changed code of a language says the project uses a framework: an import of it
 * (`from django`, `import org.springframework.…`), for projects whose manifest is elsewhere.
 */
export async function codeSays(
  repo: PluginRepo,
  extensions: RegExp,
  pattern: RegExp,
): Promise<boolean> {
  const paths = repo.files
    .map((f) => f.path)
    .filter((p) => extensions.test(p))
    .sort()
    .slice(0, CODE_FILES_READ);
  for (const path of paths) {
    const text = await readEither(repo, path);
    if (text && pattern.test(text)) return true;
  }
  return false;
}

/** The parsed version a layer is read from: the head, else the base of a deleted file. */
export const sourceOf = (sources: { old?: ParsedSource; new?: ParsedSource } | undefined) =>
  sources?.new ?? sources?.old;

export const exportsNamed = (src: ParsedSource, names: readonly string[]) =>
  src.symbols.some((s) => s.exported && s.parent === null && names.includes(s.name));

export const importsFrom = (src: ParsedSource, pattern: RegExp) =>
  src.imports.some((i) => pattern.test(i.source));

export const calls = (src: ParsedSource, names: readonly string[]) =>
  src.references.some((r) => r.kind === 'call' && names.includes(r.name));

/** Lookups over the changed code that the rules of every plugin need. */
export class Changes {
  readonly input: PluginGraphInput;
  readonly logic: ChangedSymbol[];
  readonly fileById: Map<string, FileChange>;
  private readonly byQualified = new Map<string, ChangedSymbol>();
  private readonly addedLines = new Map<string, Map<number, string>>();
  private readonly refsByLine = new Map<string, Map<number, Reference[]>>();
  private imported: Map<string, Set<string>> | undefined;
  private resolve: ((from: string, specifier: string) => string | undefined) | undefined;

  constructor(input: PluginGraphInput) {
    this.input = input;
    this.fileById = new Map(input.files.map((f) => [f.id, f]));
    const hunkKind = new Map(input.hunks.map((h) => [h.id, h.kind]));
    this.logic = input.symbols.filter((s) => s.hunkIds.some((id) => hunkKind.get(id) === 'logic'));
    for (const s of this.logic) this.byQualified.set(`${s.fileId}#${s.qualifiedName}`, s);
    for (const h of input.hunks) {
      if (h.kind !== 'logic') continue;
      const added = this.addedLines.get(h.fileId) ?? new Map<number, string>();
      for (const l of h.lines) if (l.kind === 'add') added.set(l.newNo!, l.text);
      this.addedLines.set(h.fileId, added);
    }
  }

  /** Parsed head version of each changed file of the languages (script files by default). */
  *codeFiles(
    languages: ReadonlySet<string> = SCRIPT_LANGUAGES,
  ): Generator<{ file: FileChange; src: ParsedSource }> {
    for (const file of this.input.files) {
      const src = this.input.sources.get(file.id)?.new;
      if (src && file.language && languages.has(file.language)) yield { file, src };
    }
  }

  symbol(fileId: string, qualifiedName: string): ChangedSymbol | undefined {
    return this.byQualified.get(`${fileId}#${qualifiedName}`);
  }

  /** The changed symbol for a class member, else the class, else the class's first changed member. */
  owner(fileId: string, className: string, member?: string): ChangedSymbol | undefined {
    return (
      (member ? this.symbol(fileId, `${className}.${member}`) : undefined) ??
      this.symbol(fileId, className) ??
      this.logic.find((s) => s.fileId === fileId && s.qualifiedName.startsWith(`${className}.`))
    );
  }

  /** Changed symbols of a class by its name, anywhere in the PR (the class itself first). */
  classTargets(name: string, exceptFileId: string): ChangedSymbol | undefined {
    const inOtherFiles = this.logic.filter((s) => s.fileId !== exceptFileId);
    return (
      inOtherFiles.find((s) => s.qualifiedName === name && s.kind === 'class') ??
      inOtherFiles.find((s) => s.qualifiedName.startsWith(`${name}.`))
    );
  }

  /**
   * The symbol that stands for a whole changed file: its file-level change if it has one, else
   * its first changed symbol. Undefined when the file has no logic change.
   */
  fileSymbol(fileId: string): ChangedSymbol | undefined {
    const mine = this.logic.filter((s) => s.fileId === fileId);
    return mine.find((s) => s.kind === 'file') ?? mine[0];
  }

  isAdded(fileId: string, line: number): boolean {
    return this.addedLines.get(fileId)?.has(line) ?? false;
  }

  /** The text of a line the PR adds, if it adds it. */
  addedText(fileId: string, line: number): string | undefined {
    return this.addedLines.get(fileId)?.get(line);
  }

  /** Changed symbol owning a changed line of a hunk, with the line's text. */
  *changedLines(): Generator<{
    symbol: ChangedSymbol;
    fileId: string;
    line: number;
    text: string;
  }> {
    const byId = new Map(this.logic.map((s) => [s.id, s]));
    for (const h of this.input.hunks) {
      if (h.kind !== 'logic') continue;
      const owners = this.input.lineSymbols.get(h.id) ?? [];
      for (const [i, l] of h.lines.entries()) {
        const symbol = byId.get(owners[i] ?? '');
        if (l.kind === 'add' && symbol)
          yield { symbol, fileId: h.fileId, line: l.newNo!, text: l.text };
      }
    }
  }

  /** References on one line of a file's head version. */
  refsAt(fileId: string, line: number): Reference[] {
    let byLine = this.refsByLine.get(fileId);
    if (!byLine) {
      byLine = new Map();
      for (const r of this.input.sources.get(fileId)?.new?.references ?? []) {
        byLine.set(r.line, [...(byLine.get(r.line) ?? []), r]);
      }
      this.refsByLine.set(fileId, byLine);
    }
    return byLine.get(line) ?? [];
  }

  /** The changed file a name was imported from, in a file's head version. */
  importedFrom(fileId: string, name: string): string | undefined {
    const file = this.fileById.get(fileId);
    const imp = this.input.sources.get(fileId)?.new?.imports.find((i) => i.names.includes(name));
    if (!file || !imp) return undefined;
    this.resolve ??= createImportResolver(this.input.files);
    // Python's `from .routers import orders` may name a module of the package (M17).
    const submodule =
      file.language === 'python'
        ? this.resolve(file.path, `${imp.source}${imp.source.endsWith('.') ? '' : '.'}${name}`)
        : undefined;
    return submodule ?? this.resolve(file.path, imp.source);
  }

  /** The changed files a file imports, in its head version. */
  importsOf(fileId: string): Set<string> {
    if (!this.imported) {
      const resolve = createImportResolver(this.input.files);
      this.imported = new Map();
      for (const f of this.input.files) {
        const set = new Set<string>();
        for (const imp of this.input.sources.get(f.id)?.new?.imports ?? []) {
          const id = resolve(f.path, imp.source);
          if (id) set.add(id);
        }
        this.imported.set(f.id, set);
      }
    }
    return this.imported.get(fileId) ?? new Set();
  }
}

/** "`page.vue`" for a file-level change, "`save()` in `page.vue`" for a symbol. */
export const where = (c: Changes, s: ChangedSymbol) => {
  const path = `\`${c.fileById.get(s.fileId)!.path}\``;
  return s.kind === 'file' ? path : `${shown(s)} in ${path}`;
};

/** A symbol in evidence text, or what a file-level change is: `path`. */
export const shown = (s: ChangedSymbol) =>
  s.kind === 'file'
    ? 'the file'
    : s.kind === 'method' || s.kind === 'function'
      ? `\`${s.qualifiedName}()\``
      : `\`${s.qualifiedName}\``;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stem = (path: string) => baseName(path).replace(/\.[^.]+$/, '');
export const pascal = (name: string) =>
  name.replace(/(^|[-_\s.]+)([a-zA-Z0-9])/g, (_a, _s, c: string) => c.toUpperCase());

/** The tag a component file is used by: `user-card.vue` and `UserCard.svelte` → `UserCard`. */
export function componentName(path: string): string {
  return pascal(stem(path));
}

/**
 * Components used in markup (`<UserCard>`) by changed lines, linked to the changed component
 * file. Templates are not code the graph stage can follow, and a component file has no symbol
 * named after it. `names` maps the tag names to files; `autoImported` files need no import
 * (Nuxt). Changed import lines of such a file count as uses too.
 */
export function componentEdges(
  c: Changes,
  names: Map<string, string>,
  autoImported: (fileId: string) => boolean = () => false,
): PluginEdge[] {
  if (names.size === 0) return [];
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  const add = (from: ChangedSymbol, toFile: string, line: number, how: string) => {
    const to = c.fileSymbol(toFile);
    const key = `${from.id} ${to?.id}`;
    if (!to || to.fileId === from.fileId || seen.has(key)) return;
    seen.add(key);
    edges.push({
      from: from.id,
      to: to.id,
      text: `${where(c, from)} ${how}`,
      locations: [{ fileId: from.fileId, line }],
    });
  };
  const byFile = new Map([...names].map(([name, id]) => [id, name]));
  for (const { symbol, fileId, line } of c.changedLines()) {
    for (const r of c.refsAt(fileId, line)) {
      const target = names.get(r.name);
      if (!target || r.kind === 'declaration') continue;
      if (!c.importsOf(fileId).has(target) && !autoImported(target)) continue;
      add(symbol, target, line, `uses \`<${r.name}>\``);
    }
    const src = c.input.sources.get(fileId)?.new;
    for (const imp of src?.imports ?? []) {
      if (imp.line !== line) continue;
      for (const target of c.importsOf(fileId)) {
        const name = byFile.get(target);
        if (name && imp.names.includes(name)) add(symbol, target, line, `imports \`${name}\``);
      }
    }
  }
  return edges;
}

/**
 * Changed lines that mount a router or plugin imported from another changed file
 * (`app.use('/users', usersRouter)`, `app.include_router(users)`): `mounts` are the calls that do.
 */
export function mountEdges(c: Changes, mounts: ReadonlySet<string>): PluginEdge[] {
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line } of c.changedLines()) {
    const refs = c.refsAt(fileId, line);
    if (!refs.some((r) => r.kind === 'call' && mounts.has(r.name))) continue;
    for (const r of refs) {
      if (r.kind !== 'name' && r.kind !== 'member') continue;
      const target = c.importedFrom(fileId, r.name);
      const to = target && target !== fileId ? c.fileSymbol(target) : undefined;
      const key = `${symbol.id} ${to?.id}`;
      if (!to || seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: symbol.id,
        to: to.id,
        text: `${where(c, symbol)} mounts \`${r.name}\` from \`${c.fileById.get(target!)!.path}\``,
        locations: [{ fileId, line }],
      });
    }
  }
  return edges;
}

/** Wrapper types whose type argument is the real dependency: `Repository<User>`. */
const WRAPPER_TYPES = new Set(['Repository', 'Model', 'Queue', 'Promise', 'Array', 'Partial']);

/**
 * A class that starts injecting a changed class depends on it: the constructor parameter is new
 * in this PR (`constructor(private mail: MailService)`). Injections that were already there say
 * nothing about this change; the calls through them are `calls` edges.
 */
export function injectionEdges(c: Changes): PluginEdge[] {
  const edges: PluginEdge[] = [];
  for (const { file, src } of c.codeFiles()) {
    for (const cls of src.classes) {
      const from = c.owner(file.id, cls.name, 'constructor');
      if (!from) continue;
      for (const p of cls.constructorParams) {
        if (!c.isAdded(file.id, p.line)) continue;
        const types = p.types.filter((t) => !WRAPPER_TYPES.has(t) || p.types.length === 1);
        for (const type of types) {
          const to = c.classTargets(type, file.id);
          if (!to) continue;
          edges.push({
            from: from.id,
            to: to.id,
            text: `\`${cls.name}\` injects \`${type}\``,
            locations: [{ fileId: file.id, line: p.line }],
          });
        }
      }
    }
  }
  return edges;
}

/**
 * One segment of a file-system route: `[id]` → `:id`, `[[id]]` → `:id?`, `[...rest]` →
 * `*rest`, `[id=uuid]` → `:id`. Route groups `(auth)` and parallel slots `@modal` are not part
 * of the address: undefined.
 */
export function routeSegment(segment: string): string | undefined {
  if (/^\(.*\)$/.test(segment) || segment.startsWith('@')) return undefined;
  return segment
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, '*$1?')
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')
    .replace(/\[\[([^\]=]+)(=[^\]]+)?\]\]/g, ':$1?')
    .replace(/\[([^\]=]+)(=[^\]]+)?\]/g, ':$1');
}

/** `/settings/:id` from the folders (and file name) under a routes folder. */
export function routePath(segments: string[]): string {
  const parts = segments.map(routeSegment).filter((s): s is string => !!s && s !== 'index');
  return `/${parts.join('/')}`;
}

/** Path below the first `marker` folder (`app/`, `src/routes/`), split into segments. */
export function under(path: string, marker: RegExp): string[] | undefined {
  const m = marker.exec(path);
  if (!m) return undefined;
  return path.slice(m.index + m[0].length).split('/');
}

/** HTTP methods a route module exports: `export async function GET`, `export const POST`. */
export function exportedMethods(src: ParsedSource | undefined): string[] {
  if (!src) return [];
  return HTTP_METHODS.filter((m) =>
    src.symbols.some(
      (s) => s.exported && s.parent === null && (s.name === m || s.name === m.toLowerCase()),
    ),
  );
}

/**
 * "New page: /settings/billing" for an added page, "New API route: GET, POST /api/users" or
 * "API route changed: …" for API routes. Changed pages say nothing: most PRs change some.
 */
export function routeHint(
  c: Changes,
  file: FileChange,
  route: string,
  kind: 'page' | 'api',
  methods: string[] = [],
): HintDraft | undefined {
  const symbol = c.fileSymbol(file.id);
  if (!symbol) return undefined;
  const isNew = file.status === 'added';
  if (kind === 'page') {
    return isNew
      ? { ruleId: 'public-route', severity: 'info', message: `New page: ${route}`, fileId: file.id }
      : undefined;
  }
  const what = `${methods.length ? `${methods.join(', ')} ` : ''}${route}`;
  return {
    ruleId: 'public-route',
    severity: isNew ? 'attention' : 'info',
    message: isNew ? `New API route: ${what}` : `API route changed: ${what}`,
    fileId: file.id,
  };
}
