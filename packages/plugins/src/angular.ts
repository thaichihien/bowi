/**
 * Angular plugin (M14): applies when a package.json depends on `@angular/core`.
 *
 * - Layers from decorators: `@Component`, `@Directive`, `@Pipe` → ui; `@Injectable` → service,
 *   or api for guards, resolvers and interceptors; `@NgModule` and route arrays (`Routes`) →
 *   config; functional guards and interceptors (`CanActivateFn`, `HttpInterceptorFn`) → api.
 * - Edges: a component's template and styles (`templateUrl`, `styleUrl(s)`) are read with it;
 *   a changed template line using `<app-user-card>` depends on the component with that
 *   selector; a class that starts injecting a changed service depends on it.
 * - Hints: new routes in route arrays: "New route: /settings".
 */

import { posix } from 'node:path';
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
  injectionEdges,
  shown,
  SCRIPT_LANGUAGES,
  sourceOf,
  TEST_PATH,
  usesPackage,
  where,
} from './shared.ts';

const CLASS_LAYERS: Record<string, Layer> = {
  Component: 'ui',
  Directive: 'ui',
  Pipe: 'ui',
  NgModule: 'config',
};
const PIPELINE = new Set([
  'CanActivate',
  'CanActivateChild',
  'CanDeactivate',
  'CanMatch',
  'CanLoad',
  'Resolve',
  'HttpInterceptor',
]);
const PIPELINE_TYPES = new Set([
  'CanActivateFn',
  'CanActivateChildFn',
  'CanDeactivateFn',
  'CanMatchFn',
  'ResolveFn',
  'HttpInterceptorFn',
]);
const ASSET = /\.(html|css|scss|sass|less)$/;
const SELECTOR_TAG = /<([a-z][\w]*-[\w-]+)/g;

function layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (!src) return undefined;
  for (const c of src.classes) {
    for (const d of src.decorators) {
      if (d.target.kind !== 'class' || d.target.name !== c.name) continue;
      if (d.name === 'Injectable') {
        return c.implements.some((i) => PIPELINE.has(i)) ? 'api' : 'service';
      }
      const layer = CLASS_LAYERS[d.name];
      if (layer) return layer;
    }
  }
  if (src.references.some((r) => r.kind === 'type' && PIPELINE_TYPES.has(r.name))) return 'api';
  if (src.references.some((r) => r.kind === 'type' && r.name === 'Routes')) return 'config';
  return undefined;
}

/** Template and style files of components, and selectors, from the `@Component` arguments. */
function componentEdges(c: Changes, input: PluginGraphInput): PluginEdge[] {
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const edges: PluginEdge[] = [];
  const selectors = new Map<string, { fileId: string; className: string }>();
  for (const { file, src } of c.codeFiles()) {
    for (const d of src.decorators) {
      if (d.name !== 'Component' && d.name !== 'Directive') continue;
      if (d.target.kind !== 'class') continue;
      const component = c.owner(file.id, d.target.name);
      for (const arg of d.args) {
        if (ASSET.test(arg)) {
          const asset = byPath.get(posix.normalize(posix.join(posix.dirname(file.path), arg)));
          const from = asset && c.fileSymbol(asset.id);
          if (!asset || !from || !component) continue;
          edges.push({
            from: from.id,
            to: component.id,
            text: `\`${asset.path}\` is the ${/\.html$/.test(arg) ? 'template' : 'style'} of ${shown(component)}`,
            locations: [{ fileId: file.id, line: d.line }],
          });
        } else if (/^[a-z][\w]*-[\w-]+$/.test(arg) && component) {
          selectors.set(arg, { fileId: file.id, className: d.target.name });
        }
      }
    }
  }
  if (selectors.size === 0) return edges;
  // Templates are text: their changed lines are read as they are.
  const seen = new Set<string>();
  for (const { symbol, fileId, line, text } of c.changedLines()) {
    for (const m of text.matchAll(SELECTOR_TAG)) {
      const target = selectors.get(m[1]!);
      if (!target || target.fileId === fileId) continue;
      const to = c.owner(target.fileId, target.className);
      const key = `${symbol.id} ${to?.id}`;
      if (!to || seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: symbol.id,
        to: to.id,
        text: `${where(c, symbol)} uses \`<${m[1]}>\` (${shown(to)})`,
        locations: [{ fileId, line }],
      });
    }
  }
  return edges;
}

export const angularPlugin: FrameworkPlugin = {
  id: 'angular',
  detect: (repo) => usesPackage(repo, ['@angular/core']),
  layerOf,
  extraEdges(input) {
    const c = new Changes(input);
    return [...componentEdges(c, input), ...injectionEdges(c)];
  },
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const { symbol, fileId, text } of c.changedLines()) {
      if (c.fileById.get(fileId)?.layer !== 'config') continue;
      const m = /\bpath\s*:\s*['"`]([^'"`]*)['"`]/.exec(text);
      if (!m || m[1] === '**') continue;
      hints.push({
        ruleId: 'public-route',
        severity: 'info',
        message: `New route: /${m[1]}`,
        symbolId: symbol.id,
      });
    }
    return hints;
  },
};
