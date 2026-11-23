/**
 * ASP.NET Core plugin (M17), C#: applies when a project file of the repository is a web project
 * or references ASP.NET Core or EF Core (`Api/Api.csproj` next to a changed file, or a changed
 * `.csproj`), or changed code uses them (`using Microsoft.AspNetCore…`).
 *
 * - Layers: `[ApiController]` classes, controllers, SignalR hubs, middleware and minimal APIs
 *   (`app.MapGet(…)`) → api; EF Core `DbContext` classes and entity configurations → data;
 *   migrations → schema (also by their `Migrations/` folder); hosted services → service.
 * - Edges: a changed DI registration (`services.AddScoped<IMailer, Mailer>()`) depends on the
 *   changed types it registers; an EF Core migration naming a property an entity adds depends
 *   on the entity.
 * - Hints: new or changed routes, attribute routes (`[HttpPost]` under the controller's
 *   `[Route("api/[controller]")]`) and minimal APIs; `[Authorize]` and `[AllowAnonymous]` added.
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
  handlerRouteHint,
  isCode,
  joinRoute,
  lineRouteHints,
  typeTarget,
  written,
} from './backends.ts';
import { Changes, changesAny, codeSays, manifestSays, sourceOf, where } from './shared.ts';

const LANGUAGES = new Set(['csharp']);

const API_BASES = new Set(['Controller', 'ControllerBase', 'ODataController', 'Hub', 'PageModel']);
const SERVICE_BASES = new Set(['BackgroundService', 'IHostedService']);
const DATA_BASES = /^(DbContext|IdentityDbContext|IdentityUserContext|IEntityTypeConfiguration)$/;
const MINIMAL_API = new Set([
  'MapGet',
  'MapPost',
  'MapPut',
  'MapPatch',
  'MapDelete',
  'MapMethods',
  'MapGroup',
  'MapHub',
]);
const VERBS: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpPatch: 'PATCH',
  HttpDelete: 'DELETE',
  HttpHead: 'HEAD',
  HttpOptions: 'OPTIONS',
};
const ACCESS = new Set(['Authorize', 'AllowAnonymous']);
/** `services.AddScoped<IMailer, Mailer>()`, `AddDbContext<AppDbContext>(…)`, `AddHostedService<Worker>()`. */
const REGISTRATION =
  /\.(?:Try)?Add(?:Scoped|Transient|Singleton|Keyed(?:Scoped|Transient|Singleton)|HostedService|DbContext\w*|HttpClient)\s*<\s*([\w.]+)\s*(?:,\s*([\w.]+)\s*)?>/g;
/** `app.MapPost("/orders", …)`. */
const MAP_CALL = /\.Map(Get|Post|Put|Patch|Delete)\(\s*@?"([^"]*)"/g;

export const aspnetPlugin: FrameworkPlugin = {
  id: 'aspnetcore',

  async detect(repo: PluginRepo): Promise<boolean> {
    if (!changesAny(repo, /\.cs$/)) return false;
    const web = /Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore|Microsoft\.EntityFrameworkCore/;
    if (await manifestSays(repo, ['{dir}.csproj', 'Directory.Packages.props'], web)) return true;
    for (const f of repo.files) {
      if (!f.path.endsWith('.csproj')) continue;
      const text = (await repo.readFile('new', f.path)) ?? (await repo.readFile('old', f.path));
      if (text && web.test(text)) return true;
    }
    return codeSays(
      repo,
      /\.cs$/,
      /^\s*(global\s+)?using\s+Microsoft\.(AspNetCore|EntityFrameworkCore)\b/m,
    );
  },

  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    const src = sourceOf(sources);
    if (!src || !isCode(file, LANGUAGES)) return undefined;
    for (const c of src.classes) {
      const bases = [...c.extends, ...c.implements];
      if (bases.includes('Migration')) return 'schema';
      if (bases.some((b) => DATA_BASES.test(b))) return 'data';
      const attributes = src.decorators.filter(
        (d) => d.target.kind === 'class' && d.target.name === c.name,
      );
      if (attributes.some((d) => d.name === 'ApiController') || bases.some((b) => API_BASES.has(b)))
        return 'api';
      if (bases.includes('IMiddleware')) return 'api';
      if (bases.some((b) => SERVICE_BASES.has(b))) return 'service';
    }
    return src.references.some((r) => r.kind === 'call' && MINIMAL_API.has(r.name))
      ? 'api'
      : undefined;
  },

  extraEdges(input: PluginGraphInput): PluginEdge[] {
    const c = new Changes(input);
    return [...registrationEdges(c), ...fieldColumnEdges(c, LANGUAGES)];
  },

  hints(input: HintInput): HintDraft[] {
    const c = new Changes(input);
    const hints: HintDraft[] = [];
    for (const { file, src } of c.codeFiles(LANGUAGES)) {
      if (!isCode(file, LANGUAGES)) continue;
      const prefixOf = new Map<string, string>();
      for (const d of src.decorators) {
        if (d.name === 'Route' && d.target.kind === 'class')
          prefixOf.set(d.target.name, controllerRoute(d.args[0] ?? '', d.target.name));
      }
      for (const d of src.decorators) {
        if (d.target.kind === 'method' && d.target.className && d.name in VERBS) {
          const handler = decorated(c, file.id, d);
          if (!handler) continue;
          const own = src.decorators.find(
            (r) =>
              r.name === 'Route' &&
              r.target.kind === 'method' &&
              r.target.name === d.target.name &&
              r.target.className === d.target.className,
          );
          const template = controllerRoute(d.args[0] ?? own?.args[0] ?? '', d.target.className);
          // `~/` or `/` starts from the root, past the controller's route.
          const route = /^~?\//.test(template)
            ? joinRoute(template.replace(/^~/, ''))
            : joinRoute(prefixOf.get(d.target.className) ?? '', template);
          hints.push(handlerRouteHint(handler, `${VERBS[d.name]} ${route}`));
        }
        if (ACCESS.has(d.name) && c.isAdded(file.id, d.line)) {
          const symbol = decorated(c, file.id, d);
          if (symbol) hints.push(accessHint(symbol, written(c, file.id, d)));
        }
      }
    }
    hints.push(
      ...lineRouteHints(
        c,
        (f) => isCode(f, LANGUAGES),
        (text) =>
          [...text.matchAll(MAP_CALL)].map((m) => `${m[1]!.toUpperCase()} ${joinRoute(m[2]!)}`),
      ),
    );
    return hints;
  },
};

/** `api/[controller]` on `OrdersController` → `api/Orders`. */
function controllerRoute(template: string, className: string): string {
  return template.replace(/\[controller\]/gi, className.replace(/Controller$/, ''));
}

/** A changed DI registration depends on the changed types it registers. */
function registrationEdges(c: Changes): PluginEdge[] {
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line, text } of c.changedLines()) {
    for (const m of text.matchAll(REGISTRATION)) {
      const names = [m[1]!, m[2]].filter((n): n is string => !!n).map(bare);
      const shownAs = names.length === 2 ? `\`${names[1]}\` as \`${names[0]}\`` : `\`${names[0]}\``;
      for (const name of names) {
        const to = typeTarget(c, name, fileId);
        const key = `${symbol.id} ${to?.id}`;
        if (!to || seen.has(key)) continue;
        seen.add(key);
        edges.push({
          from: symbol.id,
          to: to.id,
          text: `${where(c, symbol)} registers ${shownAs}`,
          locations: [{ fileId, line }],
        });
      }
    }
  }
  return edges;
}

const bare = (name: string) => name.slice(name.lastIndexOf('.') + 1);
