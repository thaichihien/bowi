/**
 * Back-end frameworks for Node.js (M14): Express, Koa, Fastify and Hono, each detected from
 * package.json. New and changed routes written as `router.post('/users', …)` are already
 * hinted by the `public-route` rule for any project; these plugins add the rest.
 *
 * - Layers: route modules, middleware and handlers → api. A file is one when it imports the
 *   framework (`Request`, `FastifyInstance`, `Context`, `new Hono()`, `Router()`) or registers
 *   routes on a router, app or server (`router.get(…)`, `fastify.post(…)`, `app.route(…)`).
 * - Edges: a changed line that mounts a router or plugin (`app.use('/users', usersRouter)`,
 *   `app.route('/users', users)`, `fastify.register(userRoutes)`, `app.use(router.routes())`)
 *   depends on the changed file it imports it from, also under another name than the file's
 *   own (a default export).
 */

import type {
  FileChange,
  FileSources,
  FrameworkPlugin,
  Layer,
  PluginEdge,
  PluginGraphInput,
} from '@bowi/core';
import {
  Changes,
  importsFrom,
  SCRIPT_LANGUAGES,
  sourceOf,
  TEST_PATH,
  usesPackage,
  where,
} from './shared.ts';

const VERBS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'del',
  'all',
  'options',
  'head',
  'route',
]);
const RECEIVERS = new Set([
  'app',
  'router',
  'routes',
  'route',
  'server',
  'api',
  'fastify',
  'instance',
]);
const MOUNTS = new Set(['use', 'route', 'register', 'mount', 'basePath']);

interface Server {
  id: string;
  packages: string[];
  /** Module specifiers that make a file part of the HTTP layer. */
  modules: RegExp;
}

function serverLayer(server: Server) {
  return (file: FileChange, sources: FileSources | undefined): Layer | undefined => {
    if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
      return undefined;
    }
    const src = sourceOf(sources);
    if (!src) return undefined;
    if (importsFrom(src, server.modules)) return 'api';
    // `router.get(…)` with a router passed in: a verb called on a router-like name, same line.
    const names = new Map<number, Set<string>>();
    for (const r of src.references) {
      if (r.kind === 'name') names.set(r.line, (names.get(r.line) ?? new Set()).add(r.name));
    }
    const registers = src.references.some(
      (r) =>
        r.kind === 'call' &&
        VERBS.has(r.name) &&
        [...(names.get(r.line) ?? [])].some((n) => RECEIVERS.has(n)),
    );
    return registers ? 'api' : undefined;
  };
}

/** Changed lines that mount a router or plugin imported from another changed file. */
function mountEdges(input: PluginGraphInput): PluginEdge[] {
  const c = new Changes(input);
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line } of c.changedLines()) {
    const refs = c.refsAt(fileId, line);
    if (!refs.some((r) => r.kind === 'call' && MOUNTS.has(r.name))) continue;
    for (const r of refs) {
      if (r.kind !== 'name' && r.kind !== 'member') continue;
      const target = c.importedFrom(fileId, r.name);
      const to = target && target !== fileId ? c.fileSymbol(target) : undefined;
      const key = `${symbol.id} ${to?.id}`;
      if (!to || seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: symbol.id,
        to: to.id,
        text: `${where(c, symbol)} mounts \`${r.name}\` from \`${c.fileById.get(target!)!.path}\``,
        locations: [{ fileId, line }],
      });
    }
  }
  return edges;
}

function serverPlugin(server: Server): FrameworkPlugin {
  return {
    id: server.id,
    detect: (repo) => usesPackage(repo, server.packages),
    layerOf: serverLayer(server),
    extraEdges: mountEdges,
  };
}

export const expressPlugin = serverPlugin({
  id: 'express',
  packages: ['express'],
  modules: /^express(\/|$)|^@types\/express/,
});
export const koaPlugin = serverPlugin({
  id: 'koa',
  packages: ['koa', '@koa/router', 'koa-router'],
  modules: /^(koa|@koa\/router|koa-router)(\/|$)/,
});
export const fastifyPlugin = serverPlugin({
  id: 'fastify',
  packages: ['fastify'],
  modules: /^(fastify|fastify-plugin)(\/|$)/,
});
export const honoPlugin = serverPlugin({
  id: 'hono',
  packages: ['hono'],
  modules: /^hono(\/|$)/,
});
