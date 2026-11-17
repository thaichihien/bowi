/**
 * Next.js plugin (M14): applies when a package.json depends on `next`. React rules apply too.
 *
 * - Layers: route handlers (`app/**\/route.ts`), `pages/api/**`, middleware and server actions
 *   (`'use server'`) → api.
 * - Edges: a page is read with the layout around it (`layout.tsx` in its folder or above), and
 *   a folder's `loading`, `error`, `not-found` and `template` files with its page.
 * - Hints: new pages and API routes from the file system: "New page: /settings/billing",
 *   "New API route: GET, POST /api/users".
 */

import type {
  FileChange,
  FileSources,
  FrameworkPlugin,
  HintDraft,
  Layer,
  PluginEdge,
} from '@bowi/core';
import { reactLayer } from './react.ts';
import {
  Changes,
  exportedMethods,
  routeHint,
  routePath,
  SCRIPT_LANGUAGES,
  shown,
  sourceOf,
  TEST_PATH,
  under,
  usesPackage,
} from './shared.ts';

const APP_DIR = /(^|\/)(src\/)?app\//;
const PAGES_DIR = /(^|\/)(src\/)?pages\//;
const SPECIAL =
  /^(page|layout|template|loading|error|global-error|not-found|default|route)\.[jt]sx?$/;
const SIBLINGS = /^(loading|error|not-found|template|default)\.[jt]sx?$/;

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folder = (path: string) => path.slice(0, path.lastIndexOf('/'));

/** What a file is to Next.js, with its address. */
function routeOf(
  path: string,
): { kind: 'page' | 'api' | 'layout' | 'other'; route: string } | undefined {
  const app = under(path, APP_DIR);
  if (app && SPECIAL.test(app.at(-1)!)) {
    const name = app.at(-1)!.replace(/\.[jt]sx?$/, '');
    const route = routePath(app.slice(0, -1));
    if (name === 'page') return { kind: 'page', route };
    if (name === 'route') return { kind: 'api', route };
    if (name === 'layout') return { kind: 'layout', route };
    return { kind: 'other', route };
  }
  const pages = under(path, PAGES_DIR);
  if (pages && /\.[jt]sx?$/.test(path) && !pages.at(-1)!.startsWith('_')) {
    const segments = [...pages.slice(0, -1), pages.at(-1)!.replace(/\.[jt]sx?$/, '')];
    return { kind: segments[0] === 'api' ? 'api' : 'page', route: routePath(segments) };
  }
  return undefined;
}

function layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (routeOf(file.path)?.kind === 'api') return 'api';
  if (/(^|\/)(src\/)?middleware\.[jt]s$/.test(file.path)) return 'api';
  if (src?.directives.includes('use server')) return 'api';
  return reactLayer(file, sources);
}

function extraEdges(
  input: Parameters<NonNullable<FrameworkPlugin['extraEdges']>>[0],
): PluginEdge[] {
  const c = new Changes(input);
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const edges: PluginEdge[] = [];
  const link = (from: FileChange, to: FileChange, how: string) => {
    const a = c.fileSymbol(from.id);
    const b = c.fileSymbol(to.id);
    if (!a || !b) return;
    edges.push({
      from: a.id,
      to: b.id,
      text: `\`${from.path}\` ${how} \`${to.path}\`${b.kind === 'file' ? '' : ` (${shown(b)})`}`,
      locations: [{ fileId: from.id, line: 1 }],
    });
  };
  for (const f of input.files) {
    const app = under(f.path, APP_DIR);
    if (!app) continue;
    const name = fileName(f.path);
    const ext = name.slice(name.indexOf('.'));
    if (/^page\./.test(name)) {
      // The nearest changed layout, in the page's folder or above it.
      let dir = folder(f.path);
      while (APP_DIR.test(`${dir}/`)) {
        const layout = ['.tsx', '.jsx', '.ts', '.js']
          .map((e) => byPath.get(`${dir}/layout${e}`))
          .find((x) => x);
        if (layout) {
          link(f, layout, 'is rendered inside');
          break;
        }
        dir = folder(dir);
      }
    } else if (SIBLINGS.test(name)) {
      const page = byPath.get(`${folder(f.path)}/page${ext}`);
      if (page) link(f, page, 'is shown for');
    }
  }
  return edges;
}

export const nextPlugin: FrameworkPlugin = {
  id: 'nextjs',
  detect: (repo) => usesPackage(repo, ['next']),
  layerOf,
  extraEdges,
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const file of input.files) {
      const r = routeOf(file.path);
      if (!r || (r.kind !== 'page' && r.kind !== 'api') || TEST_PATH.test(file.path)) continue;
      const methods = r.kind === 'api' ? exportedMethods(input.sources.get(file.id)?.new) : [];
      const hint = routeHint(c, file, r.route, r.kind, methods);
      if (hint) hints.push(hint);
    }
    return hints;
  },
};
