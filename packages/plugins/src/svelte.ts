/**
 * Svelte and SvelteKit plugins (M14). `.svelte` files are parsed as single-file components by
 * `@bowi/lang`: their script is code, their markup gives references.
 *
 * Svelte (`svelte`):
 * - Layers: stores (`svelte/store`) and rune modules (`*.svelte.ts`) → service.
 * - Edges: a changed line using `<UserCard>`, or importing it, depends on the changed component.
 *
 * SvelteKit (`@sveltejs/kit`), on top of Svelte:
 * - Layers: `+server.ts`, `+page.server.ts`, `+layout.server.ts`, `+page.ts`, `+layout.ts`
 *   (load functions, form actions, endpoints) and `hooks.server.ts` → api;
 *   `$lib/server/**` → service.
 * - Edges: a page is read with its load function (`+page.svelte` → `+page.ts` and
 *   `+page.server.ts`), a layout with its own, and a page with the nearest changed layout.
 * - Hints: new pages and API routes from `src/routes/**`.
 */

import type {
  FileChange,
  FileSources,
  FrameworkPlugin,
  HintDraft,
  Layer,
  PluginEdge,
  PluginGraphInput,
} from '@bowi/core';
import {
  Changes,
  componentEdges,
  componentName,
  exportedMethods,
  importsFrom,
  routeHint,
  routePath,
  SCRIPT_LANGUAGES,
  shown,
  sourceOf,
  TEST_PATH,
  under,
  usesPackage,
} from './shared.ts';

const ROUTES_DIR = /(^|\/)src\/routes\//;

function svelteLayer(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (!src) return undefined;
  if (/\.svelte\.[jt]s$/.test(file.path) || importsFrom(src, /^svelte\/store$/)) return 'service';
  return undefined;
}

function svelteComponents(input: PluginGraphInput): Map<string, string> {
  const names = new Map<string, string>();
  for (const f of input.files) {
    // `+page.svelte` is never used as a tag.
    if (f.language === 'svelte' && !f.path.includes('/+')) names.set(componentName(f.path), f.id);
  }
  return names;
}

export const sveltePlugin: FrameworkPlugin = {
  id: 'svelte',
  detect: (repo) => usesPackage(repo, ['svelte']),
  layerOf: svelteLayer,
  extraEdges(input) {
    const c = new Changes(input);
    return [...componentEdges(c, svelteComponents(input))];
  },
};

const KIT_SERVER =
  /(^|\/)(\+(server|page\.server|layout\.server|page|layout)\.[jt]s|hooks\.server\.[jt]s)$/;

function kitLayer(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (TEST_PATH.test(file.path)) return undefined;
  if (KIT_SERVER.test(file.path)) return 'api';
  if (/(^|\/)src\/lib\/server\//.test(file.path)) return 'service';
  return svelteLayer(file, sources);
}

const folder = (path: string) => path.slice(0, path.lastIndexOf('/'));

function kitEdges(input: PluginGraphInput): PluginEdge[] {
  const c = new Changes(input);
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const edges: PluginEdge[] = [];
  const link = (from: FileChange, to: FileChange, how: string) => {
    const a = c.fileSymbol(from.id);
    const b = c.fileSymbol(to.id);
    if (!a || !b || a.id === b.id) return;
    edges.push({
      from: a.id,
      to: b.id,
      text: `\`${from.path}\` ${how} \`${to.path}\`${b.kind === 'file' ? '' : ` (${shown(b)})`}`,
      locations: [{ fileId: from.id, line: 1 }],
    });
  };
  for (const f of input.files) {
    const m = /(^|\/)\+(page|layout)\.svelte$/.exec(f.path);
    if (!m || !ROUTES_DIR.test(f.path)) continue;
    const dir = folder(f.path);
    for (const ext of ['.ts', '.js', '.server.ts', '.server.js']) {
      const load = byPath.get(`${dir}/+${m[2]}${ext}`);
      if (load) link(f, load, 'shows the data of');
    }
    if (m[2] !== 'page') continue;
    for (let up = dir; ROUTES_DIR.test(`${up}/`); up = folder(up)) {
      const layout = byPath.get(`${up}/+layout.svelte`);
      if (layout) {
        link(f, layout, 'is rendered inside');
        break;
      }
    }
  }
  return edges;
}

export const svelteKitPlugin: FrameworkPlugin = {
  id: 'sveltekit',
  detect: (repo) => usesPackage(repo, ['@sveltejs/kit']),
  layerOf: kitLayer,
  extraEdges: kitEdges,
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const file of input.files) {
      const rest = under(file.path, ROUTES_DIR);
      const name = rest?.at(-1);
      if (!rest || !name) continue;
      const route = routePath(rest.slice(0, -1));
      if (name === '+page.svelte') {
        const hint = routeHint(c, file, route, 'page');
        if (hint) hints.push(hint);
      } else if (/^\+server\.[jt]s$/.test(name)) {
        const methods = exportedMethods(input.sources.get(file.id)?.new);
        const hint = routeHint(c, file, route, 'api', methods);
        if (hint) hints.push(hint);
      }
    }
    return hints;
  },
};
