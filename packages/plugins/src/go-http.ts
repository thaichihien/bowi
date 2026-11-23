/**
 * Go HTTP plugin (M17): net/http and the common routers, Gin, Echo, chi, gorilla/mux, Fiber and
 * httprouter. Applies when `go.mod` requires one of the routers, or changed Go code imports
 * `net/http` or a router.
 *
 * - Layers: files importing a router, and files with net/http handlers or middleware
 *   (`http.ResponseWriter`, `http.Handler`) → api.
 * - Edges: a changed line that registers a route (`r.Post("/orders", handlers.CreateOrder)`)
 *   depends on the changed handler it names: the graph does not follow a function passed as
 *   `package.Name`.
 * - Hints: new or changed routes registered on changed lines: `r.GET(…)`, `e.POST(…)`,
 *   `r.Get(…)`, `mux.HandleFunc("GET /orders", …)`, `r.Method("POST", …)`,
 *   `.HandleFunc(…).Methods("POST")`, as written: the prefix of a route group is not added.
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
import { handlerEdges, isCode, lineRouteHints } from './backends.ts';
import { Changes, changesAny, codeSays, importsFrom, manifestSays, sourceOf } from './shared.ts';

const LANGUAGES = new Set(['go']);
const ROUTERS =
  /github\.com\/(gin-gonic\/gin|labstack\/echo|go-chi\/chi|gorilla\/mux|gofiber\/fiber|julienschmidt\/httprouter)/;
const ROUTER_IMPORTS = new RegExp(`^${ROUTERS.source}`);
const HANDLER_TYPES = new Set(['ResponseWriter', 'Handler', 'HandlerFunc']);
/**
 * `x.GET("/p"`, `x.Get("/p"`, `x.HandleFunc("GET /p"`, `x.Method("POST", "/p"`: group 1 is the
 * call, group 2 a method passed before the path, group 3 the path or pattern.
 */
const ROUTE =
  /\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options|Handle|HandleFunc|Method|MethodFunc)\(\s*(?:"([A-Z]+)"\s*,\s*)?"((?:[A-Z]+ +)?\/[^"]*)"/g;
const NO_METHOD = new Set(['Any', 'Handle', 'HandleFunc']);

export const goHttpPlugin: FrameworkPlugin = {
  id: 'go-http',

  async detect(repo: PluginRepo): Promise<boolean> {
    if (!changesAny(repo, /\.go$/)) return false;
    return (
      (await manifestSays(repo, ['go.mod'], ROUTERS)) ||
      codeSays(repo, /\.go$/, new RegExp(`"(net/http|${ROUTERS.source})`))
    );
  },

  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    const src = sourceOf(sources);
    if (!src || !isCode(file, LANGUAGES)) return undefined;
    if (importsFrom(src, ROUTER_IMPORTS)) return 'api';
    const handlers =
      importsFrom(src, /^net\/http$/) &&
      src.references.some((r) => r.kind === 'type' && HANDLER_TYPES.has(r.name));
    return handlers ? 'api' : undefined;
  },

  extraEdges(input: PluginGraphInput): PluginEdge[] {
    return handlerEdges(
      new Changes(input),
      (f) => isCode(f, LANGUAGES),
      (text) => routesOn(text)[0],
    );
  },

  hints(input: HintInput): HintDraft[] {
    return lineRouteHints(new Changes(input), (f) => isCode(f, LANGUAGES), routesOn);
  },
};

/** The routes a line registers: `POST /orders`, `/static/` when any method goes. */
export function routesOn(text: string): string[] {
  const chained = /\.Methods\(\s*"([A-Z]+)"/.exec(text)?.[1];
  return [...text.matchAll(ROUTE)].map((m) => {
    const call = m[1]!;
    const before = m[2];
    const written = m[3]!;
    const pattern = /^([A-Z]+) +(\/.*)$/.exec(written);
    const method =
      before ??
      pattern?.[1] ??
      (NO_METHOD.has(call) ? chained : call.startsWith('Method') ? undefined : call.toUpperCase());
    const path = pattern?.[2] ?? written;
    return method ? `${method} ${path}` : path;
  });
}
