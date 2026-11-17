/**
 * tRPC plugin (M14): applies when a package.json depends on `@trpc/server`.
 *
 * - Layers: routers (`router({ … })`, `createTRPCRouter`) with procedures, and the tRPC setup
 *   (`initTRPC`) → api.
 * - Edges: a client call to a procedure (`trpc.user.byId.useQuery()`, `api.post.create.mutate()`)
 *   on a changed line depends on the changed router that defines it. The client never imports
 *   the procedure, so the graph cannot see this.
 * - Hints: new procedures: "New tRPC procedure: `byId` (query)".
 */

import type {
  ChangedSymbol,
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
  SCRIPT_LANGUAGES,
  shown,
  sourceOf,
  TEST_PATH,
  usesPackage,
  where,
} from './shared.ts';

const ROUTER_CALLS = new Set(['router', 'createTRPCRouter', 'createRouter', 'mergeRouters']);
/** `byId: publicProcedure`, `create: protectedProcedure.input(…)`. */
const PROCEDURE = /^\s*([A-Za-z_$][\w$]*)\s*:\s*[\w$.]*[pP]rocedure\b/;
const CLIENT_CALLS = new Set([
  'useQuery',
  'useSuspenseQuery',
  'useInfiniteQuery',
  'useSuspenseInfiniteQuery',
  'useMutation',
  'query',
  'mutate',
  'subscribe',
  'queryOptions',
  'infiniteQueryOptions',
  'mutationOptions',
  'queryKey',
  'queryFilter',
  'fetch',
  'prefetch',
  'invalidate',
  'setData',
  'getData',
]);

function layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
  if (!file.language || !SCRIPT_LANGUAGES.has(file.language) || TEST_PATH.test(file.path)) {
    return undefined;
  }
  const src = sourceOf(sources);
  if (!src) return undefined;
  const calls = src.references.filter((r) => r.kind === 'call');
  // The setup: `initTRPC.create()`.
  if (src.references.some((r) => r.name === 'initTRPC')) return 'api';
  const procedures = src.references.some((r) => /[pP]rocedure$/.test(r.name));
  return procedures && calls.some((r) => ROUTER_CALLS.has(r.name)) ? 'api' : undefined;
}

/** Procedures on changed lines of routers, by name, with the changed symbol that holds them. */
function procedures(
  c: Changes,
): Map<string, { symbol: ChangedSymbol; line: number; text: string }[]> {
  const found = new Map<string, { symbol: ChangedSymbol; line: number; text: string }[]>();
  for (const { symbol, fileId, line, text } of c.changedLines()) {
    if (c.fileById.get(fileId)?.layer !== 'api') continue;
    const m = PROCEDURE.exec(text);
    if (!m) continue;
    found.set(m[1]!, [...(found.get(m[1]!) ?? []), { symbol, line, text }]);
  }
  return found;
}

function extraEdges(input: PluginGraphInput): PluginEdge[] {
  const c = new Changes(input);
  const defined = procedures(c);
  if (defined.size === 0) return [];
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line } of c.changedLines()) {
    const refs = c.refsAt(fileId, line);
    if (!refs.some((r) => r.kind === 'call' && CLIENT_CALLS.has(r.name))) continue;
    for (const r of refs) {
      if (r.kind !== 'member') continue;
      for (const p of defined.get(r.name) ?? []) {
        const key = `${symbol.id} ${p.symbol.id}`;
        if (p.symbol.fileId === fileId || seen.has(key)) continue;
        seen.add(key);
        edges.push({
          from: symbol.id,
          to: p.symbol.id,
          text: `${where(c, symbol)} calls tRPC procedure \`${r.name}\`, defined in ${shown(p.symbol)}`,
          locations: [{ fileId, line }],
        });
      }
    }
  }
  return edges;
}

export const trpcPlugin: FrameworkPlugin = {
  id: 'trpc',
  detect: (repo) => usesPackage(repo, ['@trpc/server']),
  layerOf,
  extraEdges,
  hints(input): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const [name, list] of procedures(c)) {
      const p = list[0]!;
      const file = c.fileById.get(p.symbol.fileId)!;
      // Only a procedure whose line is new; an edited one shows as a changed router anyway.
      const hunk = input.hunks.find(
        (h) => h.fileId === file.id && h.lines.some((l) => l.kind === 'add' && l.newNo === p.line),
      );
      const replaced = hunk?.lines.some(
        (l) => l.kind === 'del' && PROCEDURE.exec(l.text)?.[1] === name,
      );
      if (replaced) continue;
      hints.push({
        ruleId: 'public-route',
        severity: 'attention',
        message: `New tRPC procedure: \`${name}\``,
        symbolId: p.symbol.id,
      });
    }
    return hints;
  },
};
