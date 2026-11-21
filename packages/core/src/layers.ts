/**
 * Layer assignment (SYM-4). Configured globs win, then a framework plugin's layer from the code
 * (e.g. NestJS decorators), then these path heuristics in order.
 */

import picomatch from 'picomatch';
import type { Layer } from './types.ts';

type Rule = [Layer, RegExp];

// Checked in order: the first match wins. Tests and docs first so that `test/services/x.ts`
// is a test, not a service; then config file names, so `packages/api/package.json` is config.
const RULES: Rule[] = [
  [
    'test',
    /(^|\/)(test|tests|__tests__|spec|e2e)\/|\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|conftest)\.py$|_test\.(py|go)$|(^|\/)src\/([a-z][A-Za-z]*Test|testFixtures)\/|(^|\/)[^/]*\.(Unit|Integration)?Tests?\/|(Tests?|IT|IntegrationTests?)\.(java|kt|cs)$/,
  ],
  [
    'docs',
    /(^|\/)docs?\/|\.(md|mdx|rst|adoc)$|(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE)[^/]*$/i,
  ],
  [
    'config',
    /(^|\/)(package\.json|tsconfig[^/]*\.json|\.[^/]*rc(\.[a-z]+)?|[^/]*\.config\.[a-z]+|Dockerfile|docker-compose[^/]*|\.env[^/]*|\.gitignore|\.gitattributes|\.editorconfig|Makefile)$|(^|\/)\.github\/|\.(ya?ml|toml|ini)$|(^|\/)[^/]*(lock|\.lock|-lock\.json|\.lockb)$|(^|\/)(requirements[^/]*\.txt|setup\.(py|cfg)|Pipfile|go\.(mod|sum|work))$|(^|\/)(pom\.xml|(build|settings)\.gradle(\.kts)?|gradle\.properties|gradlew(\.bat)?|AndroidManifest\.xml|nuget\.config|appsettings[^/]*\.json|application[^/]*\.properties)$|\.(csproj|sln|props|targets)$/,
  ],
  [
    'schema',
    /(^|\/)(migrations?|schema|schemas|prisma)\/|\.(sql|prisma|graphql|gql|proto)$|(^|\/)Migrations\//,
  ],
  // Data shapes, including type-only code: `interfaces/`, `types/`, `*.interface.ts`, `types.ts`.
  [
    'data',
    /(^|\/)(entities|entity|models?|repositories|repository|dto|dtos|interfaces?|types)\/|\.(entity|model|repository|dto|schema|interfaces?|types?)\.[cm]?[jt]s$|(^|\/)(interfaces?|types)\.[cm]?[jt]s$|(^|\/)(models?|schemas?|entities|types)\.(py|go)$|(Entity|Repository|Dto|DTO|Model)\.(java|kt|cs)$|(^|\/)(Entities|Models?|Repositories|Dtos?|DTOs?)\/[^/]*\.cs$/,
  ],
  ['domain', /(^|\/)domain\//],
  [
    'service',
    /(^|\/)(services?|jobs|workers|processors?|queues?)\/|\.(service|processor|worker|job)\.[cm]?[jt]s$|(^|\/)(services?|tasks)\.(py|go)$|(Service|ServiceImpl)\.(java|kt|cs)$|(^|\/)Services\/[^/]*\.cs$/,
  ],
  [
    'api',
    /(^|\/)(controllers?|routes?|handlers?|resolvers?|api|endpoints?)\/|\.(controller|resolver|route|routes|handler|gateway)\.[cm]?[jt]s$|(^|\/)(views|urls|routes|routers?|api|handlers?|endpoints)\.(py|go)$|(^|\/)(views|routers)\/[^/]*\.py$|(Controller|Endpoints?)\.(java|kt|cs)$|(^|\/)Controllers\/[^/]*\.cs$/,
  ],
  // Shared helpers, read before the services that use them. After the layers above, so that
  // `common/dto/` stays data and `shared/services/` stays a service; before `ui`, whose `app/`
  // folder would otherwise claim `app/utils/`.
  [
    'util',
    /(^|\/)(helpers?|utils?|lib|common|shared)\/|(^|\/)(helpers?|utils?)\.[cm]?[jt]sx?$|\.(helpers?|utils?)\.[cm]?[jt]sx?$|(^|\/)(helpers?|utils?)\.(py|go)$|(Utils?|Helpers?|Extensions)\.(java|kt|cs)$|(^|\/)(Utilities|Helpers|Extensions)\/[^/]*\.cs$/,
  ],
  // Android screens and resources, Razor pages (M16).
  [
    'ui',
    /(Activity|Fragment|Screen)\.(kt|java)$|(^|\/)src\/\w+\/res\/(layout|drawable|values|menu)[^/]*\/|\.(cshtml|razor)$/,
  ],
  // Python, Go, Java, Kotlin and C# code that matched nothing above: not UI because of an `app/`
  // or `views/` folder (FastAPI's `app/` package, Django's views, an Android `app/` module).
  ['unknown', /\.(py|pyi|go|java|kt|kts|cs)$/],
  [
    'ui',
    /(^|\/)(components?|pages|views|app|screens|layouts)\/|\.(tsx|jsx|vue|svelte|astro|css|scss|html)$/,
  ],
];

export function createLayerResolver(
  configured: Partial<Record<Layer, string[]>>,
  fromCode: (path: string) => Layer | undefined = () => undefined,
): (path: string) => Layer {
  const globs = (Object.entries(configured) as [Layer, string[]][]).flatMap(([layer, patterns]) =>
    patterns.map((p) => ({ layer, m: picomatch(p, { dot: true }) })),
  );
  return (path) => {
    for (const g of globs) if (g.m(path)) return g.layer;
    const coded = fromCode(path);
    if (coded) return coded;
    for (const [layer, re] of RULES) if (re.test(path)) return layer;
    return 'unknown';
  };
}
