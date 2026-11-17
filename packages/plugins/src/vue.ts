/**
 * Vue and Nuxt plugins (M14). `.vue` files are parsed as single-file components by
 * `@bowi/lang`: their script is code, their template gives references.
 *
 * Vue (`vue`):
 * - Layers: Pinia stores (`defineStore`) → service; composables (`use*` files, `composables/`)
 *   → util.
 * - Edges: a changed template or script line using `<UserCard>` or `<user-card>`, or importing
 *   it, depends on the changed component file.
 *
 * Nuxt (`nuxt`), on top of Vue:
 * - Layers: server routes and middleware (`server/api/**`, `server/routes/**`,
 *   `server/middleware/**`) and route middleware (`middleware/`) → api; `plugins/` → config.
 * - Edges: components and composables are auto-imported, so they are found by name: a
 *   component `components/nav/Bar.vue` is `<NavBar>` (and `<Bar>`), a composable is called by
 *   its name without an import.
 * - Hints: new pages (`pages/**`) and server routes: "New API route: POST /api/users".
 */

import type {
  ChangedSymbol,
  FileChange,
  FileSources,
  FrameworkPlugin,
  HintDraft,
  Layer,
  PluginEdge,
  PluginGraphInput,
} from '@bowi/core';
import {
  calls,
  Changes,
  componentEdges,
  componentName,
  pascal,
  routeHint,
  routePath,
  SCRIPT_LANGUAGES,
  shown,
  sourceOf,
  where,
  TEST_PATH,
  under,
  usesPackage,
} from './shared.ts';

const COMPOSABLE = /(^|\/)composables\/|(^|\/)use[A-Z][\w-]*\.[jt]s$/;

function vueLayer(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (!src) return undefined;
  if (calls(src, ['defineStore'])) return 'service';
  if (COMPOSABLE.test(file.path)) return 'util';
  return undefined;
}

/** Tag names of the changed `.vue` files: `UserCard` for `UserCard.vue` and `user-card.vue`. */
function vueComponents(input: PluginGraphInput, nuxt: boolean): Map<string, string> {
  const names = new Map<string, string>();
  for (const f of input.files) {
    if (f.language !== 'vue') continue;
    names.set(componentName(f.path), f.id);
    // Nuxt names a component after its folders under `components/`: `nav/button/Collection.vue`
    // is `<NavButtonCollection>`.
    const rest = nuxt ? under(f.path, /(^|\/)components\//) : undefined;
    if (rest) names.set(pascal(rest.join('-').replace(/\.vue$/, '')), f.id);
  }
  return names;
}

export const vuePlugin: FrameworkPlugin = {
  id: 'vue',
  detect: (repo) => usesPackage(repo, ['vue']),
  layerOf: vueLayer,
  extraEdges(input) {
    const c = new Changes(input);
    return [...componentEdges(c, vueComponents(input, false))];
  },
};

const NUXT_SERVER = /(^|\/)server\/(api|routes|middleware)\//;
const AUTO_IMPORTED = /(^|\/)(components|composables|utils)\//;

function nuxtLayer(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (TEST_PATH.test(file.path)) return undefined;
  if (NUXT_SERVER.test(file.path) || /(^|\/)(app\/)?middleware\//.test(file.path)) return 'api';
  if (/(^|\/)(app\/)?plugins\//.test(file.path) && /\.[jt]s$/.test(file.path)) return 'config';
  return vueLayer(file, sources);
}

/** A composable or util called by name, without an import (auto-imported by Nuxt). */
function autoImportEdges(c: Changes): PluginEdge[] {
  const targets = new Map<string, ChangedSymbol>();
  for (const s of c.logic) {
    const path = c.fileById.get(s.fileId)!.path;
    if (s.kind === 'function' || s.kind === 'variable') {
      if (/(^|\/)(composables|utils)\//.test(path)) targets.set(s.name, s);
    }
  }
  if (targets.size === 0) return [];
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line } of c.changedLines()) {
    for (const r of c.refsAt(fileId, line)) {
      const to = targets.get(r.name);
      if (!to || r.kind !== 'call' || to.fileId === fileId) continue;
      const key = `${symbol.id} ${to.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: symbol.id,
        to: to.id,
        text: `${where(c, symbol)} calls ${shown(to)} (auto-imported)`,
        locations: [{ fileId, line }],
      });
    }
  }
  return edges;
}

/** Page or server route of a Nuxt file. */
function nuxtRoute(
  path: string,
): { kind: 'page' | 'api'; route: string; method?: string } | undefined {
  const page = under(path, /(^|\/)(app\/)?pages\//);
  if (page && /\.(vue|[jt]sx?)$/.test(path)) {
    const segments = [...page.slice(0, -1), page.at(-1)!.replace(/\.(vue|[jt]sx?)$/, '')];
    return { kind: 'page', route: routePath(segments) };
  }
  const server = under(path, /(^|\/)server\/(api|routes)\//);
  if (server && /\.[jt]s$/.test(path)) {
    const file = server.at(-1)!.replace(/\.[jt]s$/, '');
    const m = /^(.*)\.(get|post|put|patch|delete|head|options)$/.exec(file);
    const segments = [...server.slice(0, -1), m ? m[1]! : file];
    const prefix = /(^|\/)server\/api\//.test(path) ? ['api'] : [];
    return {
      kind: 'api',
      route: routePath([...prefix, ...segments]),
      ...(m && { method: m[2]!.toUpperCase() }),
    };
  }
  return undefined;
}

export const nuxtPlugin: FrameworkPlugin = {
  id: 'nuxt',
  detect: (repo) => usesPackage(repo, ['nuxt']),
  layerOf: nuxtLayer,
  extraEdges(input) {
    const c = new Changes(input);
    const auto = (fileId: string) => AUTO_IMPORTED.test(c.fileById.get(fileId)?.path ?? '');
    return [...componentEdges(c, vueComponents(input, true), auto), ...autoImportEdges(c)];
  },
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const file of input.files) {
      const r = nuxtRoute(file.path);
      if (!r || TEST_PATH.test(file.path)) continue;
      const hint = routeHint(c, file, r.route, r.kind, r.method ? [r.method] : []);
      if (hint) hints.push(hint);
    }
    return hints;
  },
};
