/**
 * Review hints (HINT-1, HINT-2): informational labels that point a reviewer at changes worth a
 * second look. They never block, score or change the exit code. Framework-specific hints (e.g.
 * NestJS routes and guards) come from plugins, under the same rule IDs.
 *
 * v0.1 rules: database migration; new or changed route; changed signature with outside callers;
 * behavior changed inside moved code; new direct dependency; authentication or authorization
 * code touched.
 */

import type { ChangedSymbol, HintDraft, HintRule } from '@bowi/core';

const MIGRATION_PATH = /(^|\/)migrations?\/|(^|\/)[^/]*migration[^/]*$/i;
/**
 * Express, Fastify, Koa and similar: `router.post('/login', …)`. Not on a decorator
 * (`@app.get('/login')`): the FastAPI and Flask plugins read those with their handler (M17).
 */
const ROUTE_CALL =
  /^(?!\s*@).*?\b(?:app|router|server|route|routes|fastify|api)\.(get|post|put|patch|delete|all)\(\s*['"`](\/[^'"`]*)['"`]/i;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
/** Path parts that usually mean authentication or authorization code. */
const AUTH_PATH =
  /(^|[/._-])(auth|authn|authz|oauth2?|login|logout|signin|signup|session|sessions|passwords?|permissions?|rbac|acl|guards?|jwt|sso|saml|mfa|2fa|credentials?)([/._-]|$)/i;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shown = (s: ChangedSymbol) =>
  s.kind === 'method' || s.kind === 'function'
    ? `\`${s.qualifiedName}()\``
    : `\`${s.qualifiedName}\``;

export const migrationRule: HintRule = {
  id: 'migration',
  run({ files, hunks, sources }) {
    return files.flatMap((f): HintDraft[] => {
      if (f.layer !== 'schema' || !hunks.some((h) => h.fileId === f.id && h.kind === 'logic'))
        return [];
      const src = sources.get(f.id);
      const isMigration =
        MIGRATION_PATH.test(f.path) ||
        [src?.new, src?.old].some((v) =>
          v?.classes.some((c) => c.implements.includes('MigrationInterface')),
        );
      if (!isMigration) return [];
      return [
        {
          ruleId: 'migration',
          severity: 'attention',
          message: `Database migration: ${f.path.slice(f.path.lastIndexOf('/') + 1)}`,
          fileId: f.id,
        },
      ];
    });
  },
};

export const routeRule: HintRule = {
  id: 'public-route',
  run({ files, hunks }) {
    const hints: HintDraft[] = [];
    // Test servers and docs examples define routes too; they are not the app's API.
    const appFiles = new Set(
      files.filter((f) => f.layer !== 'test' && f.layer !== 'docs').map((f) => f.id),
    );
    for (const h of hunks) {
      if (h.kind !== 'logic' || !appFiles.has(h.fileId)) continue;
      const routes = (kind: 'add' | 'del') =>
        h.lines.flatMap((l) => {
          const m = l.kind === kind && !COMMENT_LINE.test(l.text) ? ROUTE_CALL.exec(l.text) : null;
          return m ? [`${m[1]!.toUpperCase()} ${m[2]}`] : [];
        });
      const before = new Set(routes('del'));
      for (const route of new Set(routes('add'))) {
        hints.push({
          ruleId: 'public-route',
          severity: before.has(route) ? 'info' : 'attention',
          message: before.has(route) ? `Route changed: ${route}` : `New route: ${route}`,
          hunkId: h.id,
        });
      }
    }
    return hints;
  },
};

export const outsideCallersRule: HintRule = {
  id: 'signature-outside-callers',
  run({ symbols, outsideRefCounts }) {
    return symbols.flatMap((s): HintDraft[] => {
      const n = outsideRefCounts.get(s.id) ?? 0;
      if (n === 0) return [];
      const refs = plural(n, 'unchanged reference');
      const message =
        s.change === 'signature'
          ? `${shown(s)} changed its signature; ${refs} outside this PR`
          : s.change === 'renamed'
            ? `${shown(s)} was renamed; ${refs} outside this PR use the old name`
            : s.change === 'deleted'
              ? `${shown(s)} was removed; ${refs} outside this PR still use it`
              : undefined;
      return message
        ? [{ ruleId: 'signature-outside-callers', severity: 'attention', message, symbolId: s.id }]
        : [];
    });
  },
};

export const movedBehaviorRule: HintRule = {
  id: 'moved-behavior',
  run({ hunks, symbols }) {
    const byId = new Map(hunks.map((h) => [h.id, h]));
    const symbolById = new Map(symbols.map((s) => [s.id, s]));
    return hunks.flatMap((h): HintDraft[] => {
      // The destination half (it adds the code) carries the hint.
      if (h.kind !== 'move' || !h.move || !h.lines.some((l) => l.kind === 'add')) return [];
      const other = byId.get(h.move.pairHunkId);
      const n = Math.max(
        h.move.changedLineIndexes.length,
        other?.move?.changedLineIndexes.length ?? 0,
      );
      if (n === 0) return [];
      const s = symbolById.get(h.symbolIds[0] ?? '');
      return [
        {
          ruleId: 'moved-behavior',
          severity: 'attention',
          message: `${plural(n, 'line')} changed inside moved code${s ? ` ${shown(s)}` : ''}`,
          hunkId: h.id,
        },
      ];
    });
  },
};

export const newDependencyRule: HintRule = {
  id: 'new-dependency',
  run({ newDependencies }) {
    return [...newDependencies].flatMap(([fileId, deps]) =>
      deps.map((d): HintDraft => ({
        ruleId: 'new-dependency',
        severity: 'attention',
        message: `New ${d.dev ? 'dev dependency' : 'dependency'}: ${d.name}`,
        fileId,
      })),
    );
  },
};

export const authRule: HintRule = {
  id: 'auth',
  run({ files, hunks }) {
    return files.flatMap((f): HintDraft[] => {
      if (f.layer === 'test' || f.layer === 'docs' || f.generated || !AUTH_PATH.test(f.path))
        return [];
      const first = hunks.find((h) => h.fileId === f.id && h.kind === 'logic');
      if (!first) return [];
      return [
        {
          ruleId: 'auth',
          severity: 'attention',
          message: `Authentication or authorization code: ${f.path}`,
          hunkId: first.id,
        },
      ];
    });
  },
};

export const defaultRules: HintRule[] = [
  migrationRule,
  routeRule,
  outsideCallersRule,
  movedBehaviorRule,
  newDependencyRule,
  authRule,
];
