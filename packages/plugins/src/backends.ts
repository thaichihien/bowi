/**
 * What the framework plugins of Python, Go, Java, Kotlin and C# share (M17): test paths, the
 * changed symbol a decorator or annotation is on, links from a route registration to its handler
 * and from a migration to the entity fields it changes, and route and access-control hints.
 */

import type { ChangedSymbol, FileChange, HintDraft, PluginEdge } from '@bowi/core';
import type { DecoratorUse } from '@bowi/lang';
import { Changes, shown, where } from './shared.ts';

/** Test files of these languages, as the layer rules read them (SYM-4). */
export const BACKEND_TEST_PATH =
  /(^|\/)(test|tests|testing|__tests__|spec|e2e)\/|(^|\/)(test_[^/]*|conftest)\.py$|_test\.(py|go)$|(^|\/)src\/([a-z][A-Za-z]*Test|testFixtures)\/|(^|\/)[^/]*\.(Unit|Integration)?Tests?\/|(Tests?|IT|IntegrationTests?)\.(java|kt|cs)$/;

/** Whether a file is code of one of the languages and not a test. */
export const isCode = (file: FileChange, languages: ReadonlySet<string>) =>
  !!file.language && languages.has(file.language) && !BACKEND_TEST_PATH.test(file.path);

/**
 * The changed member `name` of a class: `OrderController.create`, or an overload of it
 * (`OrderController.create(Order)`, M16).
 */
export function member(c: Changes, fileId: string, className: string, name: string) {
  const qualified = `${className}.${name}`;
  return (
    c.symbol(fileId, qualified) ??
    c.logic.find((s) => s.fileId === fileId && s.qualifiedName.startsWith(`${qualified}(`))
  );
}

/**
 * The changed symbol a decorator is on: the method (or the function, in Python and Go), else a
 * new class holding it, whose members are part of it. Undefined when that code is unchanged.
 */
export function decorated(c: Changes, fileId: string, d: DecoratorUse): ChangedSymbol | undefined {
  const { kind, name, className } = d.target;
  if (kind === 'class') return c.symbol(fileId, name);
  if (!className) return c.symbol(fileId, name);
  const cls = c.symbol(fileId, className);
  return member(c, fileId, className, name) ?? (cls?.change === 'added' ? cls : undefined);
}

/** "New route: POST /orders" on a new handler, "Route handler changed: …" on a changed one. */
export function handlerRouteHint(handler: ChangedSymbol, what: string): HintDraft {
  const isNew = handler.change === 'added';
  return {
    ruleId: 'public-route',
    severity: isNew ? 'attention' : 'info',
    message: isNew ? `New route: ${what}` : `Route handler changed: ${what}`,
    symbolId: handler.id,
  };
}

/** "Access control changed: `@PreAuthorize("hasRole('ADMIN')")` on `OrderController.create()`". */
export function accessHint(symbol: ChangedSymbol, written: string): HintDraft {
  return {
    ruleId: 'auth',
    severity: 'attention',
    message: `Access control changed: \`${written}\` on ${shown(symbol)}`,
    symbolId: symbol.id,
  };
}

/**
 * A decorator as the PR writes it: its added line when that holds only the decorator
 * (`[Authorize(Roles = "Admin")]`), else its name with the names and strings passed to it.
 */
export function written(c: Changes, fileId: string, d: DecoratorUse): string {
  const line = c.addedText(fileId, d.line)?.trim();
  if (
    line &&
    line.length <= 100 &&
    /^(@|\[)/.test(line) &&
    !/[{;]|\b(def|fun|public|private|protected)\b/.test(line)
  )
    return line;
  const args = [...d.refs, ...d.args.map((a) => `"${a}"`)].join(', ');
  const use = `${d.name}${args ? `(${args})` : ''}`;
  return c.fileById.get(fileId)?.language === 'csharp' ? `[${use}]` : `@${use}`;
}

/** The changed class or interface `name` in another file, else its first changed member. */
export function typeTarget(c: Changes, name: string, exceptFileId: string) {
  const others = c.logic.filter((s) => s.fileId !== exceptFileId);
  return (
    others.find(
      (s) => s.qualifiedName === name && (s.kind === 'class' || s.kind === 'interface'),
    ) ?? others.find((s) => s.qualifiedName.startsWith(`${name}.`))
  );
}

/** Joins route parts with single slashes: `/api/orders` + `{id}` → `/api/orders/{id}`. */
export function joinRoute(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/**
 * Routes registered on changed lines (`r.Post("/orders", …)`, `path('billing/', …)`), compared
 * with the removed lines of the same hunk, like the `public-route` rule: "New route: POST
 * /orders", else "Route changed: …". `routesOn` returns the routes a line registers.
 */
export function lineRouteHints(
  c: Changes,
  isRouteFile: (file: FileChange) => boolean,
  routesOn: (text: string) => string[],
): HintDraft[] {
  const hints: HintDraft[] = [];
  for (const h of c.input.hunks) {
    const file = c.fileById.get(h.fileId);
    if (h.kind !== 'logic' || !file || !isRouteFile(file)) continue;
    const routes = (kind: 'add' | 'del') =>
      h.lines.flatMap((l) => (l.kind === kind && !COMMENT.test(l.text) ? routesOn(l.text) : []));
    const before = new Set(routes('del'));
    for (const route of new Set(routes('add'))) {
      const changed = before.has(route);
      hints.push({
        ruleId: 'public-route',
        severity: changed ? 'info' : 'attention',
        message: changed ? `Route changed: ${route}` : `New route: ${route}`,
        hunkId: h.id,
      });
    }
  }
  return hints;
}

const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;

/**
 * A changed line that registers a route depends on the changed handler it names
 * (`r.Post("/orders", handlers.CreateOrder)`, `path('billing/', views.billing)`): the graph
 * does not follow a function passed as `module.name`. A name several changed files define
 * resolves to the ones in files the line's file imports, else in its own folder.
 */
export function handlerEdges(
  c: Changes,
  isRouteFile: (file: FileChange) => boolean,
  routeOn: (text: string) => string | undefined,
): PluginEdge[] {
  const byName = new Map<string, ChangedSymbol[]>();
  for (const s of c.logic) {
    if (s.kind !== 'function' && s.kind !== 'method' && s.kind !== 'class') continue;
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line, text } of c.changedLines()) {
    if (!isRouteFile(c.fileById.get(fileId)!) || COMMENT.test(text)) continue;
    const route = routeOn(text);
    if (route === undefined) continue;
    for (const r of c.refsAt(fileId, line)) {
      if (r.kind !== 'name' && r.kind !== 'member') continue;
      const to = handlerNamed(c, byName.get(r.name) ?? [], fileId);
      const key = `${symbol.id} ${to?.id}`;
      if (!to || seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: symbol.id,
        to: to.id,
        text: `${where(c, symbol)} routes ${route ? `\`${route}\` ` : ''}to ${where(c, to)}`,
        locations: [{ fileId, line }],
      });
    }
  }
  return edges;
}

function handlerNamed(
  c: Changes,
  candidates: ChangedSymbol[],
  fileId: string,
): ChangedSymbol | undefined {
  const others = candidates.filter((s) => s.fileId !== fileId);
  if (others.length <= 1) return others[0];
  const imported = c.importsOf(fileId);
  const dirOf = (id: string) => {
    const path = c.fileById.get(id)!.path;
    return path.slice(0, path.lastIndexOf('/') + 1);
  };
  const near = others.filter(
    (s) =>
      imported.has(s.fileId) ||
      [...imported].some((id) => dirOf(id) === dirOf(s.fileId)) ||
      dirOf(s.fileId) === dirOf(fileId),
  );
  return near.length === 1 ? near[0] : undefined;
}

/**
 * A migration that names a field an entity adds (`paid_at`, `PaidAt`, `paidAt` as
 * `paid_at`) depends on the entity: EF Core, Django, Flyway and Liquibase migrations, like the
 * NestJS entity columns. Entities are the changed classes of data files of the languages.
 */
export function fieldColumnEdges(c: Changes, languages: ReadonlySet<string>): PluginEdge[] {
  const columns: {
    entity: ChangedSymbol;
    /** The entity class, as the evidence names it. */
    shownAs: string;
    name: string;
    fileId: string;
    line: number;
  }[] = [];
  const dataFiles = new Set(
    c.input.files.filter((f) => f.layer === 'data' && isCode(f, languages)).map((f) => f.id),
  );
  const fieldsAt = new Map<string, Map<number, string>>();
  for (const id of dataFiles) {
    const byLine = new Map<number, string>();
    for (const f of c.input.sources.get(id)?.new?.fields ?? []) byLine.set(f.line, f.name);
    fieldsAt.set(id, byLine);
  }
  for (const { symbol, fileId, line, text } of c.changedLines()) {
    // Constants and static members are not columns: `public const int Manage = 4`.
    if (!dataFiles.has(fileId) || CONSTANT.test(text)) continue;
    // A field, or a C# property, which is a member symbol: `public DateTime? PaidAt { get; set; }`.
    const property =
      symbol.change === 'added' && new RegExp(`\\b${symbol.name}\\s*(\\{|=>)`).test(text);
    const field = fieldsAt.get(fileId)?.get(line) ?? (property ? symbol.name : undefined);
    if (!field) continue;
    const dot = symbol.qualifiedName.lastIndexOf('.');
    const className = property && dot > 0 ? symbol.qualifiedName.slice(0, dot) : undefined;
    const entity = (className && c.symbol(fileId, className)) || symbol;
    const shownAs = className ? `\`${className}\`` : shown(entity);
    for (const name of new Set([field, snake(field)])) {
      if (name.length >= 4) columns.push({ entity, shownAs, name, fileId, line });
    }
  }
  if (columns.length === 0) return [];
  const migrations = new Set(c.input.files.filter((f) => f.layer === 'schema').map((f) => f.id));
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line, text } of c.changedLines()) {
    if (!migrations.has(fileId)) continue;
    for (const col of columns) {
      const key = `${symbol.id} ${col.entity.id}`;
      if (seen.has(key) || col.fileId === fileId || !wordIn(text, col.name)) continue;
      seen.add(key);
      edges.push({
        from: symbol.id,
        to: col.entity.id,
        text: `${where(c, symbol)} changes \`${col.name}\` of ${col.shownAs}`,
        locations: [
          { fileId, line },
          { fileId: col.fileId, line: col.line },
        ],
      });
    }
  }
  return edges;
}

const CONSTANT = /^\s*([\w@]+\s+)*(const|static)\s/;

const wordIn = (text: string, word: string) =>
  new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`, 'i').test(text);

export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}
