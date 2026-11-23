/**
 * Django plugin (M17), with Django REST framework: applies when `requirements.txt`,
 * `pyproject.toml`, `Pipfile`, `setup.cfg` or `setup.py` names Django, or changed code imports it.
 *
 * - Layers: models (`models.Model`) and serializers → data; migrations → schema; class-based
 *   views and viewsets, and modules using `django.http` or `django.shortcuts` → api; settings
 *   and app configs → config. `urls.py`, `views.py` and `models.py` already have theirs by path.
 * - Edges: a changed URL pattern (`path('billing/', views.billing)`) or router registration
 *   depends on the changed view it routes to; a migration naming a field a model adds depends
 *   on the model.
 * - Hints: new or changed URL patterns (as written in their `urls.py`: the prefix of the
 *   `include()` that mounts them is not added), router registrations, and access control
 *   added: `@login_required`, `@permission_required`, permission mixins, `permission_classes`.
 */

import type {
  FileChange,
  FileSources,
  FrameworkPlugin,
  HintDraft,
  HintInput,
  Layer,
  PluginEdge,
  PluginGraphInput,
  PluginRepo,
} from '@bowi/core';
import {
  accessHint,
  decorated,
  fieldColumnEdges,
  handlerEdges,
  isCode,
  joinRoute,
  lineRouteHints,
  written,
} from './backends.ts';
import { Changes, changesAny, codeSays, importsFrom, manifestSays, sourceOf } from './shared.ts';

const LANGUAGES = new Set(['python']);
export const PYTHON_MANIFESTS = [
  'requirements.txt',
  'requirements/base.txt',
  'pyproject.toml',
  'Pipfile',
  'setup.cfg',
  'setup.py',
];
export const PYTHON_FILES = /\.pyi?$/;
/** A requirement on `name` in a manifest: `Django==5.0`, `"django>=4"`, `django = "*"`. */
export const requirement = (name: string) => new RegExp(`(^|[\\s"'])${name}(?![\\w-])`, 'im');

const SETTINGS = /(^|\/)settings(\.py|\/[^/]+\.py)$/;
const SERIALIZER = /^(Hyperlinked)?(Model)?Serializer$|^ListSerializer$/;
const VIEW = /(^|[a-z])(View|ViewSet|APIView)$/;
const VIEW_MODULES = /^(django\.(http|shortcuts|views)|rest_framework(\.|$))/;
const ACCESS_DECORATORS = new Set([
  'login_required',
  'permission_required',
  'user_passes_test',
  'staff_member_required',
  'permission_classes',
  'method_decorator',
]);
const ACCESS_MIXINS = new Set([
  'LoginRequiredMixin',
  'PermissionRequiredMixin',
  'UserPassesTestMixin',
]);
/** `path('billing/', …)`, `re_path(r'^billing/$', …)`; group 2 is the route. */
const URL_PATTERN = /\b(re_)?path\(\s*r?['"]([^'"]*)['"]/;
/** DRF: `router.register(r'orders', OrderViewSet)`. */
const REGISTER = /\.register\(\s*r?['"]([^'"]*)['"]/;

export const djangoPlugin: FrameworkPlugin = {
  id: 'django',

  async detect(repo: PluginRepo): Promise<boolean> {
    if (!changesAny(repo, PYTHON_FILES)) return false;
    return (
      (await manifestSays(repo, PYTHON_MANIFESTS, requirement('django'))) ||
      codeSays(repo, /\.py$/, /^\s*(from|import)\s+django\b/m)
    );
  },

  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    const src = sourceOf(sources);
    if (!src || !isCode(file, LANGUAGES)) return undefined;
    if (SETTINGS.test(file.path)) return 'config';
    for (const c of src.classes) {
      if (c.extends.includes('Migration')) return 'schema';
      if (c.extends.includes('Model') || c.extends.some((b) => SERIALIZER.test(b))) return 'data';
      if (c.extends.includes('AppConfig')) return 'config';
      if (c.extends.some((b) => VIEW.test(b))) return 'api';
    }
    return importsFrom(src, VIEW_MODULES) ? 'api' : undefined;
  },

  extraEdges(input: PluginGraphInput): PluginEdge[] {
    const c = new Changes(input);
    return [
      ...handlerEdges(c, (f) => isCode(f, LANGUAGES), urlRoute),
      ...fieldColumnEdges(c, LANGUAGES),
    ];
  },

  hints(input: HintInput): HintDraft[] {
    const c = new Changes(input);
    const hints = lineRouteHints(
      c,
      (f) => isCode(f, LANGUAGES),
      (text) => {
        const route = urlRoute(text);
        return route === undefined ? [] : [route];
      },
    );
    for (const { file, src } of c.codeFiles(LANGUAGES)) {
      if (!isCode(file, LANGUAGES)) continue;
      for (const d of src.decorators) {
        if (!ACCESS_DECORATORS.has(d.name) || !c.isAdded(file.id, d.line)) continue;
        if (d.name === 'method_decorator' && !d.refs.some((r) => ACCESS_DECORATORS.has(r)))
          continue;
        const symbol = decorated(c, file.id, d);
        if (symbol) hints.push(accessHint(symbol, written(c, file.id, d)));
      }
      for (const cls of src.classes) {
        const mixins = cls.extends.filter((b) => ACCESS_MIXINS.has(b));
        const symbol = c.symbol(file.id, cls.name);
        if (mixins.length && symbol && c.isAdded(file.id, cls.line))
          hints.push(accessHint(symbol, mixins.join(', ')));
      }
    }
    for (const { symbol, fileId, text } of c.changedLines()) {
      const file = c.fileById.get(fileId)!;
      if (isCode(file, LANGUAGES) && /^\s*permission_classes\s*=/.test(text))
        hints.push(accessHint(symbol, text.trim()));
    }
    return hints;
  },
};

/** The route a line of a URL configuration adds, or undefined: not an `include()` of others. */
function urlRoute(text: string): string | undefined {
  if (/\binclude\(/.test(text)) return undefined;
  const m = URL_PATTERN.exec(text);
  // A regular expression stays as written; a path keeps its trailing slash, which Django matches.
  if (m) return m[1] ? m[2]! : `/${m[2]!.replace(/^\/+/, '')}`;
  const r = REGISTER.exec(text);
  return r ? joinRoute(r[1]!) : undefined;
}
