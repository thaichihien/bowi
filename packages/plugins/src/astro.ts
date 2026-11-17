/**
 * Astro plugin (M14): applies when a package.json depends on `astro`. `.astro` files are parsed
 * by `@bowi/lang`: the frontmatter and client scripts are code, the markup gives references.
 * Islands written in React, Vue, Svelte or Solid follow those plugins.
 *
 * - Layers: endpoints (`.ts`/`.js` files under `src/pages/`) and `src/middleware` → api;
 *   content collections (`src/content.config.ts`, `src/content/config.ts`) → schema.
 * - Edges: a changed line using `<BaseLayout>` or `<Card>`, or importing it, depends on the
 *   changed `.astro` component.
 * - Hints: new pages and endpoints from `src/pages/**`.
 */

import type { FileChange, FileSources, FrameworkPlugin, HintDraft, Layer } from '@bowi/core';
import {
  Changes,
  componentEdges,
  componentName,
  exportedMethods,
  routeHint,
  routePath,
  TEST_PATH,
  under,
  usesPackage,
} from './shared.ts';

const PAGES_DIR = /(^|\/)src\/pages\//;

function layerOf(file: FileChange, _sources: FileSources | undefined): Layer | undefined {
  if (TEST_PATH.test(file.path)) return undefined;
  if (under(file.path, PAGES_DIR) && /\.[jt]s$/.test(file.path)) return 'api';
  if (/(^|\/)src\/middleware(\/|\.[jt]s$)/.test(file.path)) return 'api';
  if (/(^|\/)src\/(content\.config|content\/config)\.[jt]s$/.test(file.path)) return 'schema';
  return undefined;
}

export const astroPlugin: FrameworkPlugin = {
  id: 'astro',
  detect: (repo) => usesPackage(repo, ['astro']),
  layerOf,
  extraEdges(input) {
    const names = new Map<string, string>();
    for (const f of input.files) {
      if (f.language === 'astro' && !under(f.path, PAGES_DIR)) {
        names.set(componentName(f.path), f.id);
      }
    }
    const c = new Changes(input);
    return [...componentEdges(c, names)];
  },
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const file of input.files) {
      const rest = under(file.path, PAGES_DIR);
      if (!rest || TEST_PATH.test(file.path)) continue;
      const isPage = /\.(astro|md|mdx)$/.test(file.path);
      const isEndpoint = /\.[jt]s$/.test(file.path);
      if (!isPage && !isEndpoint) continue;
      const name = rest.at(-1)!.replace(/\.(astro|md|mdx|[jt]s)$/, '');
      // `rss.xml.ts` serves `/rss.xml`.
      const route = routePath([...rest.slice(0, -1), name]);
      const methods = isEndpoint ? exportedMethods(input.sources.get(file.id)?.new) : [];
      const hint = routeHint(c, file, route, isPage ? 'page' : 'api', methods);
      if (hint) hints.push(hint);
    }
    return hints;
  },
};
