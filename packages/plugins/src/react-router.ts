/**
 * React Router plugin (M14): React Router 7 apps (`@react-router/dev`) and Remix
 * (`@remix-run/react`). React rules apply too.
 *
 * - Layers: route modules that export a `loader` or an `action` → api (they answer requests,
 *   and render with the components they use); `*.server.ts` modules → service.
 * - Hints: new routes from file names under `app/routes/`, flat (`settings.billing.tsx`) or in
 *   folders (`settings.billing/route.tsx`): "New page: /settings/billing".
 */

import type { FileChange, FileSources, FrameworkPlugin, HintDraft, Layer } from '@bowi/core';
import { reactLayer } from './react.ts';
import {
  Changes,
  exportsNamed,
  routeHint,
  SCRIPT_LANGUAGES,
  sourceOf,
  TEST_PATH,
  under,
  usesPackage,
} from './shared.ts';

const ROUTES_DIR = /(^|\/)app\/routes\//;

/** `/settings/:id` from a route file: `settings.$id.tsx`, `_auth.login/route.tsx`, `_index.tsx`. */
export function flatRoute(path: string): string | undefined {
  const rest = under(path, ROUTES_DIR);
  if (!rest || !/\.[jt]sx?$/.test(path)) return undefined;
  const name =
    rest.length > 1 && /^route\.[jt]sx?$/.test(rest.at(-1)!)
      ? rest[0]!
      : rest.length === 1
        ? rest[0]!.replace(/\.[jt]sx?$/, '')
        : undefined;
  if (name === undefined) return undefined;
  const parts = name
    .split(/(?<!\[)\.(?![^[]*\])/)
    .map((p) => p.replace(/\[|\]/g, ''))
    .filter((p) => p !== '_index' && p !== 'index' && !p.startsWith('_'))
    .map((p) => p.replace(/_$/, ''))
    .map((p) => (p === '$' ? '*' : p.startsWith('$') ? `:${p.slice(1)}` : p))
    .map((p) => p.replace(/^\(([^)]+)\)$/, '$1?'));
  return `/${parts.join('/')}`;
}

function layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (src && flatRoute(file.path) !== undefined && exportsNamed(src, ['loader', 'action'])) {
    return 'api';
  }
  if (/\.server\.[jt]sx?$/.test(file.path)) return 'service';
  return reactLayer(file, sources);
}

export const reactRouterPlugin: FrameworkPlugin = {
  id: 'react-router',
  detect: (repo) => usesPackage(repo, ['@react-router/dev', '@remix-run/react', '@remix-run/node']),
  layerOf,
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const file of input.files) {
      const route = flatRoute(file.path);
      if (route === undefined || TEST_PATH.test(file.path)) continue;
      const hint = routeHint(c, file, route, 'page');
      if (hint) hints.push(hint);
    }
    return hints;
  },
};
