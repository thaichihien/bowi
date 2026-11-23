/**
 * Spring Boot plugin (M17), Java and Kotlin: applies when a `pom.xml` or Gradle build of the
 * repository names Spring (`org.springframework`, `spring-boot`), or changed code imports it.
 *
 * - Layers from annotations: `@RestController`, `@Controller`, `@ControllerAdvice` and web
 *   filters or interceptors → api; `@Service` → service; `@Entity`, `@Embeddable`,
 *   `@MappedSuperclass`, `@Document`, `@Repository` and Spring Data repositories → data;
 *   `@Configuration`, `@SpringBootApplication`, `@ConfigurationProperties` → config; Liquibase
 *   changelogs (`db/changelog/`) → schema. Flyway's `db/migration/` is schema by its path.
 * - Edges: a Flyway or Liquibase migration naming a field an entity adds depends on the entity.
 *   Constructor injection needs nothing here: the graph links a constructor to the types of its
 *   parameters.
 * - Hints: new or changed routes (`@GetMapping`, … under the class's `@RequestMapping`), and
 *   method security (`@PreAuthorize`, `@Secured`, `@RolesAllowed`).
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
import type { DecoratorUse } from '@bowi/lang';
import {
  accessHint,
  decorated,
  fieldColumnEdges,
  handlerRouteHint,
  isCode,
  joinRoute,
  written,
} from './backends.ts';
import { Changes, changesAny, codeSays, manifestSays, sourceOf } from './shared.ts';

const LANGUAGES = new Set(['java', 'kotlin']);
const LIQUIBASE = /(^|\/)db\/changelog\//;

const CLASS_LAYERS: Record<string, Layer> = {
  RestController: 'api',
  Controller: 'api',
  ControllerAdvice: 'api',
  RestControllerAdvice: 'api',
  Service: 'service',
  Entity: 'data',
  Embeddable: 'data',
  MappedSuperclass: 'data',
  Document: 'data',
  Repository: 'data',
  Configuration: 'config',
  SpringBootApplication: 'config',
  ConfigurationProperties: 'config',
  AutoConfiguration: 'config',
};
/** Spring Data interfaces a repository extends (Java interfaces are not classes here). */
const REPOSITORIES = new Set([
  'Repository',
  'CrudRepository',
  'ListCrudRepository',
  'PagingAndSortingRepository',
  'JpaRepository',
  'MongoRepository',
  'ReactiveCrudRepository',
  'ReactiveMongoRepository',
  'R2dbcRepository',
  'CoroutineCrudRepository',
]);
/** Servlet and WebFlux filters and interceptors: the request pipeline. */
const WEB_PIPELINE = new Set([
  'Filter',
  'OncePerRequestFilter',
  'WebFilter',
  'HandlerInterceptor',
  'WebMvcConfigurer',
]);
const MAPPINGS: Record<string, string | undefined> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
  RequestMapping: undefined,
};
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const SECURITY = new Set([
  'PreAuthorize',
  'PostAuthorize',
  'Secured',
  'RolesAllowed',
  'PermitAll',
  'DenyAll',
]);

export const springPlugin: FrameworkPlugin = {
  id: 'spring',

  async detect(repo: PluginRepo): Promise<boolean> {
    if (!changesAny(repo, /\.(java|kt)$|(^|\/)db\/changelog\//)) return false;
    return (
      (await manifestSays(
        repo,
        ['pom.xml', 'build.gradle', 'build.gradle.kts', 'gradle/libs.versions.toml'],
        /org\.springframework|spring-boot/,
      )) || codeSays(repo, /\.(java|kt)$/, /^\s*import\s+org\.springframework\./m)
    );
  },

  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    if (LIQUIBASE.test(file.path)) return 'schema';
    const src = sourceOf(sources);
    if (!src || !isCode(file, LANGUAGES)) return undefined;
    for (const c of src.classes) {
      for (const d of src.decorators) {
        if (d.target.kind !== 'class' || d.target.name !== c.name) continue;
        const layer = CLASS_LAYERS[d.name];
        if (layer) return layer;
      }
      if ([...c.extends, ...c.implements].some((n) => WEB_PIPELINE.has(n))) return 'api';
    }
    if (src.references.some((r) => r.kind === 'type' && REPOSITORIES.has(r.name))) {
      // `interface OrderRepository extends JpaRepository<Order, Long>`.
      return src.symbols.some((s) => s.kind === 'interface' && s.parent === null)
        ? 'data'
        : undefined;
    }
    return undefined;
  },

  extraEdges: (input) => fieldColumnEdges(new Changes(input), LANGUAGES),

  hints(input: HintInput): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const { file, src } of c.codeFiles(LANGUAGES)) {
      if (!isCode(file, LANGUAGES)) continue;
      const prefixOf = new Map<string, string>();
      for (const d of src.decorators) {
        if (d.name === 'RequestMapping' && d.target.kind === 'class')
          prefixOf.set(d.target.name, paths(d)[0] ?? '');
      }
      for (const d of src.decorators) {
        if (d.target.kind === 'method' && d.name in MAPPINGS && d.target.className) {
          const handler = decorated(c, file.id, d);
          if (!handler) continue;
          const verb = MAPPINGS[d.name] ?? d.refs.find((r) => HTTP_METHODS.has(r));
          const prefix = prefixOf.get(d.target.className) ?? '';
          for (const path of paths(d).length ? paths(d) : ['']) {
            const route = joinRoute(prefix, path);
            hints.push(handlerRouteHint(handler, verb ? `${verb} ${route}` : route));
          }
        }
        if (SECURITY.has(d.name) && c.isAdded(file.id, d.line)) {
          const symbol = decorated(c, file.id, d);
          if (symbol) hints.push(accessHint(symbol, written(c, file.id, d)));
        }
      }
    }
    return hints;
  },
};

/** Paths of a mapping: its strings that are not media types or `params` conditions. */
function paths(d: DecoratorUse): string[] {
  return d.args.filter(
    (a) => !/^(application|text|image|multipart|audio|video)\//.test(a) && !/[=!\s]/.test(a),
  );
}
