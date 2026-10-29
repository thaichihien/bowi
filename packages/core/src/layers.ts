/**
 * Layer assignment by path (SYM-4). Configured globs win, then these heuristics in order.
 * Framework plugins (M6) will refine layers from code, e.g. NestJS decorators.
 */

import picomatch from 'picomatch';
import type { Layer } from './types.ts';

type Rule = [Layer, RegExp];

// Checked in order: the first match wins. Tests and docs first so that `test/services/x.ts`
// is a test, not a service; then config file names, so `packages/api/package.json` is config.
const RULES: Rule[] = [
  ['test', /(^|\/)(test|tests|__tests__|spec|e2e)\/|\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/],
  [
    'docs',
    /(^|\/)docs?\/|\.(md|mdx|rst|adoc)$|(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE)[^/]*$/i,
  ],
  [
    'config',
    /(^|\/)(package\.json|tsconfig[^/]*\.json|\.[^/]*rc(\.[a-z]+)?|[^/]*\.config\.[a-z]+|Dockerfile|docker-compose[^/]*|\.env[^/]*|\.gitignore|\.gitattributes|\.editorconfig|Makefile)$|(^|\/)\.github\/|\.(ya?ml|toml|ini)$|(^|\/)[^/]*(lock|\.lock|-lock\.json|\.lockb)$/,
  ],
  ['schema', /(^|\/)(migrations?|schema|schemas|prisma)\/|\.(sql|prisma|graphql|gql|proto)$/],
  [
    'data',
    /(^|\/)(entities|entity|models?|repositories|repository|dto|dtos)\/|\.(entity|model|repository|dto|schema)\.[cm]?[jt]s$/,
  ],
  ['domain', /(^|\/)domain\//],
  [
    'service',
    /(^|\/)(services?|jobs|workers|processors?|queues?)\/|\.(service|processor|worker|job)\.[cm]?[jt]s$/,
  ],
  [
    'api',
    /(^|\/)(controllers?|routes?|handlers?|resolvers?|api|endpoints?)\/|\.(controller|resolver|route|routes|handler|gateway)\.[cm]?[jt]s$/,
  ],
  [
    'ui',
    /(^|\/)(components?|pages|views|app|screens|layouts)\/|\.(tsx|jsx|vue|svelte|css|scss|html)$/,
  ],
];

export function createLayerResolver(
  configured: Partial<Record<Layer, string[]>>,
): (path: string) => Layer {
  const globs = (Object.entries(configured) as [Layer, string[]][]).flatMap(([layer, patterns]) =>
    patterns.map((p) => ({ layer, m: picomatch(p, { dot: true }) })),
  );
  return (path) => {
    for (const g of globs) if (g.m(path)) return g.layer;
    for (const [layer, re] of RULES) if (re.test(path)) return layer;
    return 'unknown';
  };
}
