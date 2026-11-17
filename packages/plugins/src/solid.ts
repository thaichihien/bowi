/**
 * SolidJS plugin (M14): `solid-js`, and SolidStart (`@solidjs/start`). Components and their JSX
 * uses are ordinary references, as in React.
 *
 * - Layers: stores and shared signals (`createStore`, `createSignal`, `createResource` in a
 *   module that is not a component) → service; `use*` primitives and `hooks/` → util; server
 *   functions (`'use server'`) and SolidStart API routes (`src/routes/api/**`) → api.
 * - Hints: new SolidStart pages and API routes: "New page: /settings".
 */

import type { FileChange, FileSources, FrameworkPlugin, HintDraft, Layer } from '@bowi/core';
import {
  calls,
  Changes,
  exportedMethods,
  routeHint,
  routePath,
  SCRIPT_LANGUAGES,
  sourceOf,
  TEST_PATH,
  under,
  usesPackage,
} from './shared.ts';

const ROUTES_DIR = /(^|\/)src\/routes\//;

function layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (!src) return undefined;
  const route = under(file.path, ROUTES_DIR);
  if (src.directives.includes('use server') || (route && route[0] === 'api')) return 'api';
  if (/(^|\/)hooks?\/|(^|\/)use[A-Z][\w-]*\.[jt]sx?$/.test(file.path)) return 'util';
  if (!/\.[jt]sx$/.test(file.path) && calls(src, ['createStore', 'createSignal', 'createResource']))
    return 'service';
  return undefined;
}

export const solidPlugin: FrameworkPlugin = {
  id: 'solid',
  detect: (repo) => usesPackage(repo, ['solid-js']),
  layerOf,
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const file of input.files) {
      const rest = under(file.path, ROUTES_DIR);
      if (!rest || !/\.[jt]sx?$/.test(file.path) || TEST_PATH.test(file.path)) continue;
      const segments = [...rest.slice(0, -1), rest.at(-1)!.replace(/\.[jt]sx?$/, '')];
      const isApi = segments[0] === 'api';
      const methods = isApi ? exportedMethods(input.sources.get(file.id)?.new) : [];
      const hint = routeHint(c, file, routePath(segments), isApi ? 'api' : 'page', methods);
      if (hint) hints.push(hint);
    }
    return hints;
  },
};
