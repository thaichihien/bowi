/**
 * FastAPI and Flask plugins (M17): each applies when a Python manifest names it (as for
 * Django), or changed code imports it.
 *
 * - Layers: modules with route decorators (`@router.get(…)`, `@bp.route(…)`) or that create a
 *   router, app or blueprint (`APIRouter()`, `Blueprint()`) → api; Pydantic and SQLModel models
 *   (FastAPI), SQLAlchemy and Flask-SQLAlchemy models → data.
 * - Edges: a changed line that mounts a router or blueprint imported from another changed file
 *   (`app.include_router(users.router)`, `app.register_blueprint(bp)`) depends on that file.
 *   Dependencies (`Depends(get_db)`) pass a function by name, which the graph already links.
 * - Hints: new or changed routes on route decorators, as written on the decorator: the prefix of
 *   the router is not added. Flask's `@login_required` and similar when added.
 */

import type {
  FileChange,
  FileSources,
  FrameworkPlugin,
  HintDraft,
  HintInput,
  Layer,
  PluginRepo,
} from '@bowi/core';
import type { DecoratorUse, ParsedSource } from '@bowi/lang';
import { accessHint, decorated, handlerRouteHint, isCode, written } from './backends.ts';
import { PYTHON_FILES, PYTHON_MANIFESTS, requirement } from './django.ts';
import {
  Changes,
  changesAny,
  codeSays,
  importsFrom,
  manifestSays,
  mountEdges,
  sourceOf,
} from './shared.ts';

const LANGUAGES = new Set(['python']);
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const ROUTE_DECORATORS = new Set([...VERBS, 'route', 'api_route', 'websocket']);
const HTTP_METHODS = new Set([...VERBS].map((v) => v.toUpperCase()));
const MOUNTS = new Set(['include_router', 'register_blueprint', 'mount']);
const ACCESS = new Set([
  'login_required',
  'fresh_login_required',
  'roles_required',
  'roles_accepted',
  'permission_required',
  'jwt_required',
  'auth_required',
]);

interface PythonWeb {
  id: string;
  package: string;
  /** Calls that create the app or a router: `APIRouter()`, `Blueprint()`. */
  routers: Set<string>;
  /** Model base classes, and the modules (`models`) they come from. */
  modelBases: Set<string>;
  models: RegExp;
}

/** A decorator that registers a route: `@app.get('/x')`, `@bp.route('/x')`; not `@cache.get`. */
const isRoute = (d: DecoratorUse) => !!d.receiver && ROUTE_DECORATORS.has(d.name) && !!d.args[0];

function layerOf(web: PythonWeb) {
  return (file: FileChange, sources: FileSources | undefined): Layer | undefined => {
    const src = sourceOf(sources);
    if (!src || !isCode(file, LANGUAGES)) return undefined;
    if (src.decorators.some(isRoute) || createsRouter(src, web)) return 'api';
    // The base comes from the library, or from the project's own module (`from .db import Base`).
    const model =
      (importsFrom(src, web.models) ||
        src.imports.some((i) => i.names.some((n) => web.modelBases.has(n)))) &&
      src.classes.some((c) => c.extends.some((b) => web.modelBases.has(b)));
    return model ? 'data' : undefined;
  };
}

const createsRouter = (src: ParsedSource, web: PythonWeb) =>
  src.references.some((r) => r.kind === 'call' && web.routers.has(r.name));

function hints(input: HintInput): HintDraft[] {
  const c = new Changes(input);
  const out: HintDraft[] = [];
  for (const { file, src } of c.codeFiles(LANGUAGES)) {
    if (!isCode(file, LANGUAGES)) continue;
    const prefixes = routerPrefixes(c, file.id);
    for (const d of src.decorators) {
      if (isRoute(d)) {
        const handler = decorated(c, file.id, d);
        if (handler) out.push(handlerRouteHint(handler, routeOf(d, prefixes.get(d.receiver!))));
      }
      if (ACCESS.has(d.name) && c.isAdded(file.id, d.line)) {
        const symbol = decorated(c, file.id, d);
        if (symbol) out.push(accessHint(symbol, written(c, file.id, d)));
      }
    }
  }
  return out;
}

/**
 * The prefix of each router or blueprint the diff shows being created:
 * `router = APIRouter(prefix="/orders")`, `bp = Blueprint("orders", __name__, url_prefix="/o")`.
 * Only lines in the file's hunks are read (the plugin has no other text of the file), so a router
 * created out of sight gives its routes as written on the decorator.
 */
function routerPrefixes(c: Changes, fileId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of c.input.hunks) {
    if (h.fileId !== fileId) continue;
    for (const l of h.lines) {
      if (l.kind === 'del') continue;
      const m = ROUTER_LINE.exec(l.text);
      const prefix = m && PREFIX.exec(m[2]!)?.[1];
      if (m && prefix) out.set(m[1]!, prefix);
    }
  }
  return out;
}

const ROUTER_LINE = /^\s*(\w+)\s*(?::\s*[\w.]+\s*)?=\s*(?:\w+\.)?(?:APIRouter|Blueprint)\((.*)$/;
const PREFIX = /\b(?:url_)?prefix\s*=\s*["']([^"']*)["']/;

/** `GET /users/{id}`; Flask's `route` with its `methods`, GET when none. */
function routeOf(d: DecoratorUse, prefix = ''): string {
  // As FastAPI and Flask join them: `/orders` and `/` give `/orders/`.
  const route = `${prefix.replace(/\/+$/, '')}/${d.args[0]!.replace(/^\/+/, '')}`;
  if (d.name === 'websocket') return `WebSocket ${route}`;
  if (VERBS.has(d.name)) return `${d.name.toUpperCase()} ${route}`;
  const methods = d.args.slice(1).filter((a) => HTTP_METHODS.has(a.toUpperCase()));
  return `${methods.length ? methods.map((m) => m.toUpperCase()).join(', ') : 'GET'} ${route}`;
}

function pythonWebPlugin(web: PythonWeb): FrameworkPlugin {
  return {
    id: web.id,
    async detect(repo: PluginRepo): Promise<boolean> {
      if (!changesAny(repo, PYTHON_FILES)) return false;
      return (
        (await manifestSays(repo, PYTHON_MANIFESTS, requirement(web.package))) ||
        codeSays(repo, /\.py$/, new RegExp(`^\\s*(from|import)\\s+${web.package}\\b`, 'm'))
      );
    },
    layerOf: layerOf(web),
    extraEdges: (input) => mountEdges(new Changes(input), MOUNTS),
    hints,
  };
}

export const fastapiPlugin = pythonWebPlugin({
  id: 'fastapi',
  package: 'fastapi',
  routers: new Set(['APIRouter', 'FastAPI']),
  modelBases: new Set(['BaseModel', 'SQLModel', 'DeclarativeBase', 'Base']),
  models: /^(pydantic|sqlmodel|sqlalchemy)(\.|$)/,
});

export const flaskPlugin = pythonWebPlugin({
  id: 'flask',
  package: 'flask',
  routers: new Set(['Blueprint', 'Flask']),
  modelBases: new Set(['Model', 'DeclarativeBase', 'Base']),
  models: /^(flask_sqlalchemy|sqlalchemy)(\.|$)/,
});
