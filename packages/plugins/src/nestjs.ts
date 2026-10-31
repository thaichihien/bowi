/**
 * NestJS plugin (PLG-2): applies when a package.json of the repository depends on
 * `@nestjs/core` (or `@nestjs/common`).
 *
 * - Layers from decorators: `@Controller`, `@Resolver`, `@WebSocketGateway`, guards, pipes,
 *   interceptors and filters → api; `@Injectable`, `@Processor` → service; `@Entity`, `@Schema`,
 *   GraphQL object types and validated DTOs → data; TypeORM migrations → schema; `@Module` →
 *   config. Test files keep their path layer.
 * - Edges (GRAPH-9): constructor injection (a class depends on what it injects), queues and
 *   events (`queue.add('job')` / `@InjectQueue('q')` → `@Processor('q')` / `@Process('job')`,
 *   `emit('evt')` → `@OnEvent('evt')`, message patterns), entity columns → migrations that
 *   name them.
 * - Hints: new or changed routes (`GET /auth/verify-email`), guards and roles.
 */

import type {
  ChangedSymbol,
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
import type { DecoratorUse, ParsedSource } from '@bowi/lang';

const NEST_PACKAGES = ['@nestjs/core', '@nestjs/common'];
const TEST_PATH = /(^|\/)(test|tests|__tests__|e2e)\/|\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/;
const CODE_LANGUAGES = new Set(['typescript', 'tsx', 'javascript']);

const CLASS_LAYERS: Record<string, Layer> = {
  Controller: 'api',
  Resolver: 'api',
  WebSocketGateway: 'api',
  Catch: 'api',
  Processor: 'service',
  Entity: 'data',
  ViewEntity: 'data',
  Schema: 'data',
  ObjectType: 'data',
  InputType: 'data',
  ArgsType: 'data',
  Module: 'config',
};
/** `@Injectable()` classes in the request pipeline rather than the service layer. */
const PIPELINE_INTERFACES = new Set([
  'CanActivate',
  'NestInterceptor',
  'PipeTransform',
  'NestMiddleware',
  'ExceptionFilter',
]);
/** Property decorators of validated DTOs (class-validator, class-transformer, Swagger). */
const DTO_PROPERTY =
  /^(Is[A-Z]\w*|Min|Max|MinLength|MaxLength|Length|Matches|ValidateNested|Type|Expose|Exclude|ApiProperty|ApiPropertyOptional|Field)$/;
const COLUMN_DECORATORS = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  'JoinColumn',
]);
const ROUTE_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Options',
  'Head',
  'All',
]);
const GRAPHQL_DECORATORS = new Set(['Query', 'Mutation', 'Subscription']);
const AUTH_DECORATORS = new Set([
  'UseGuards',
  'Roles',
  'Public',
  'Permissions',
  'SetMetadata',
  'Auth',
]);
/** Consumers by name: `@Processor('mail')`, `@Process('send')`, `@OnEvent('user.created')`. */
const CONSUMER_DECORATORS = new Set([
  'Processor',
  'Process',
  'OnEvent',
  'EventPattern',
  'MessagePattern',
  'OnQueueEvent',
]);
/** Producers in code: `queue.add('send', …)`, `events.emit('user.created', …)`, `client.send('x')`. */
const PRODUCER_CALL = /\.(add|addBulk|emit|emitAsync|send)\(\s*['"`]([^'"`]+)['"`]/g;
/** Wrapper types whose type argument is the real dependency: `Repository<User>`. */
const WRAPPER_TYPES = new Set(['Repository', 'Model', 'Queue', 'Promise', 'Array', 'Partial']);

export const nestjsPlugin: FrameworkPlugin = {
  id: 'nestjs',

  async detect(repo: PluginRepo): Promise<boolean> {
    // The root package.json, and the nearest one of each changed file (monorepos).
    const dirs = new Set<string>(['']);
    for (const f of repo.files) {
      const parts = f.path.split('/').slice(0, -1);
      for (let i = parts.length; i > 0; i--) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const dir of [...dirs].sort()) {
      const path = dir ? `${dir}/package.json` : 'package.json';
      const text = (await repo.readFile('new', path)) ?? (await repo.readFile('old', path));
      if (text && dependsOnNest(text)) return true;
    }
    return false;
  },

  layerOf(file: FileChange, sources: FileSources | undefined): Layer | undefined {
    if (!file.language || !CODE_LANGUAGES.has(file.language) || TEST_PATH.test(file.path))
      return undefined;
    const src = sources?.new ?? sources?.old;
    if (!src) return undefined;
    for (const c of src.classes) {
      if (c.implements.includes('MigrationInterface')) return 'schema';
      const decorators = src.decorators.filter(
        (d) => d.target.kind === 'class' && d.target.name === c.name,
      );
      for (const d of decorators) {
        if (d.name === 'Injectable')
          return c.implements.some((i) => PIPELINE_INTERFACES.has(i)) ? 'api' : 'service';
        const layer = CLASS_LAYERS[d.name];
        if (layer) return layer;
      }
      if (
        decorators.length === 0 &&
        src.decorators.some(
          (d) =>
            d.target.kind === 'property' &&
            d.target.className === c.name &&
            DTO_PROPERTY.test(d.name),
        )
      ) {
        return 'data';
      }
    }
    return undefined;
  },

  extraEdges(input: PluginGraphInput): PluginEdge[] {
    const g = new Graph(input);
    return [...injectionEdges(g), ...messageEdges(g), ...columnEdges(g)];
  },

  hints(input: HintInput): HintDraft[] {
    const g = new Graph(input);
    return [...routeHints(g), ...guardHints(g)];
  },
};

function dependsOnNest(text: string): boolean {
  try {
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) =>
      NEST_PACKAGES.some((name) => pkg[field]?.[name] !== undefined),
    );
  } catch {
    return false;
  }
}

/** Lookups over the changed code that every rule here needs. */
class Graph {
  readonly input: PluginGraphInput;
  readonly logic: ChangedSymbol[];
  private readonly byQualified = new Map<string, ChangedSymbol>();
  private readonly addedLines = new Map<string, Set<number>>();

  constructor(input: PluginGraphInput) {
    this.input = input;
    const hunkKind = new Map(input.hunks.map((h) => [h.id, h.kind]));
    this.logic = input.symbols.filter((s) => s.hunkIds.some((id) => hunkKind.get(id) === 'logic'));
    for (const s of this.logic) this.byQualified.set(`${s.fileId}#${s.qualifiedName}`, s);
    for (const h of input.hunks) {
      if (h.kind !== 'logic') continue;
      const set = this.addedLines.get(h.fileId) ?? new Set<number>();
      for (const l of h.lines) if (l.kind === 'add') set.add(l.newNo!);
      this.addedLines.set(h.fileId, set);
    }
  }

  /** Parsed head version of each changed code file. */
  *codeFiles(): Generator<{ file: FileChange; src: ParsedSource }> {
    for (const file of this.input.files) {
      const src = this.input.sources.get(file.id)?.new;
      if (src && file.language && CODE_LANGUAGES.has(file.language)) yield { file, src };
    }
  }

  symbol(fileId: string, qualifiedName: string): ChangedSymbol | undefined {
    return this.byQualified.get(`${fileId}#${qualifiedName}`);
  }

  /** The changed symbol for a class member, else the class, else the class's first changed member. */
  owner(fileId: string, className: string, member?: string): ChangedSymbol | undefined {
    return (
      (member ? this.symbol(fileId, `${className}.${member}`) : undefined) ??
      this.symbol(fileId, className) ??
      this.logic.find((s) => s.fileId === fileId && s.qualifiedName.startsWith(`${className}.`))
    );
  }

  /** Changed symbols of a class by its name, anywhere in the PR (the class itself first). */
  classTargets(name: string, exceptFileId: string): ChangedSymbol | undefined {
    const inOtherFiles = this.logic.filter((s) => s.fileId !== exceptFileId);
    return (
      inOtherFiles.find((s) => s.qualifiedName === name && s.kind === 'class') ??
      inOtherFiles.find((s) => s.qualifiedName.startsWith(`${name}.`))
    );
  }

  isAdded(fileId: string, line: number): boolean {
    return this.addedLines.get(fileId)?.has(line) ?? false;
  }

  /** Changed symbol owning a changed line of a hunk, with the line's text. */
  *changedLines(): Generator<{
    symbol: ChangedSymbol;
    fileId: string;
    line: number;
    text: string;
  }> {
    const byId = new Map(this.logic.map((s) => [s.id, s]));
    for (const h of this.input.hunks) {
      if (h.kind !== 'logic') continue;
      const owners = this.input.lineSymbols.get(h.id) ?? [];
      for (const [i, l] of h.lines.entries()) {
        const symbol = byId.get(owners[i] ?? '');
        if (l.kind === 'add' && symbol)
          yield { symbol, fileId: h.fileId, line: l.newNo!, text: l.text };
      }
    }
  }
}

const shown = (s: ChangedSymbol) =>
  s.kind === 'method' || s.kind === 'function'
    ? `\`${s.qualifiedName}()\``
    : `\`${s.qualifiedName}\``;

/**
 * A class that starts injecting a changed class depends on it: the constructor parameter is new
 * in this PR (`constructor(private mail: MailService)`). Injections that were already there say
 * nothing about this change; the calls through them are `calls` edges.
 */
function injectionEdges(g: Graph): PluginEdge[] {
  const edges: PluginEdge[] = [];
  for (const { file, src } of g.codeFiles()) {
    for (const c of src.classes) {
      const from = g.owner(file.id, c.name, 'constructor');
      if (!from) continue;
      for (const p of c.constructorParams) {
        if (!g.isAdded(file.id, p.line)) continue;
        const types = p.types.filter((t) => !WRAPPER_TYPES.has(t) || p.types.length === 1);
        for (const type of types) {
          const to = g.classTargets(type, file.id);
          if (!to) continue;
          edges.push({
            from: from.id,
            to: to.id,
            text: `\`${c.name}\` injects \`${type}\``,
            locations: [{ fileId: file.id, line: p.line }],
          });
        }
      }
    }
  }
  return edges;
}

/** Producers of a queue job, event or message to the changed code that handles it. */
function messageEdges(g: Graph): PluginEdge[] {
  const consumers = new Map<string, { symbol: ChangedSymbol; d: DecoratorUse; fileId: string }[]>();
  for (const { file, src } of g.codeFiles()) {
    for (const d of src.decorators) {
      if (!CONSUMER_DECORATORS.has(d.name) || !d.args[0]) continue;
      const className = d.target.kind === 'class' ? d.target.name : d.target.className;
      if (!className) continue;
      const symbol = g.owner(
        file.id,
        className,
        d.target.kind === 'method' ? d.target.name : undefined,
      );
      if (!symbol) continue;
      const list = consumers.get(d.args[0]) ?? [];
      list.push({ symbol, d, fileId: file.id });
      consumers.set(d.args[0], list);
    }
  }
  if (consumers.size === 0) return [];

  const edges: PluginEdge[] = [];
  const link = (from: ChangedSymbol, name: string, fileId: string, line: number, how: string) => {
    for (const c of consumers.get(name) ?? []) {
      if (c.symbol.id === from.id || c.fileId === fileId) continue;
      edges.push({
        from: from.id,
        to: c.symbol.id,
        text: `${shown(from)} ${how} \`${name}\`, handled by ${shown(c.symbol)} (\`@${c.d.name}\`)`,
        locations: [
          { fileId, line },
          { fileId: c.fileId, line: c.d.line },
        ],
      });
    }
  };
  for (const { symbol, fileId, line, text } of g.changedLines()) {
    for (const m of text.matchAll(PRODUCER_CALL)) {
      const how =
        m[1] === 'add' || m[1] === 'addBulk' ? 'queues job' : m[1] === 'send' ? 'sends' : 'emits';
      link(symbol, m[2]!, fileId, line, how);
    }
  }
  for (const { file, src } of g.codeFiles()) {
    for (const d of src.decorators) {
      if (d.name !== 'InjectQueue' || !d.args[0] || !d.target.className) continue;
      const from = g.owner(file.id, d.target.className);
      if (from) link(from, d.args[0], file.id, d.line, 'uses queue');
    }
  }
  return edges;
}

/** A migration that names a changed entity column (`email_verified`) depends on the entity. */
function columnEdges(g: Graph): PluginEdge[] {
  const columns: { entity: ChangedSymbol; name: string; fileId: string; line: number }[] = [];
  for (const { file, src } of g.codeFiles()) {
    for (const d of src.decorators) {
      if (!COLUMN_DECORATORS.has(d.name) || d.target.kind !== 'property' || !d.target.className)
        continue;
      if (!g.isAdded(file.id, d.line)) continue;
      const entity = g.owner(file.id, d.target.className);
      if (!entity) continue;
      // `@Column({ name: 'email_verified' }) emailVerified` names the column twice.
      for (const name of new Set([...d.args.slice(0, 1), d.target.name, snake(d.target.name)])) {
        if (name.length >= 4) columns.push({ entity, name, fileId: file.id, line: d.line });
      }
    }
  }
  if (columns.length === 0) return [];
  const migrations = new Set(g.input.files.filter((f) => f.layer === 'schema').map((f) => f.id));
  const edges: PluginEdge[] = [];
  const seen = new Set<string>();
  for (const { symbol, fileId, line, text } of g.changedLines()) {
    if (!migrations.has(fileId)) continue;
    for (const c of columns) {
      const key = `${symbol.id} ${c.entity.id}`;
      if (seen.has(key) || !new RegExp(`\\b${c.name}\\b`).test(text)) continue;
      seen.add(key);
      edges.push({
        from: symbol.id,
        to: c.entity.id,
        text: `${shown(symbol)} changes column \`${c.name}\` of entity ${shown(c.entity)}`,
        locations: [
          { fileId, line },
          { fileId: c.fileId, line: c.line },
        ],
      });
    }
  }
  return edges;
}

/** New or changed HTTP routes and GraphQL operations on changed handlers. */
function routeHints(g: Graph): HintDraft[] {
  const hints: HintDraft[] = [];
  for (const { file, src } of g.codeFiles()) {
    const prefixOf = new Map<string, string>();
    for (const d of src.decorators) {
      if (d.name === 'Controller' && d.target.kind === 'class')
        prefixOf.set(d.target.name, d.args[0] ?? '');
    }
    for (const d of src.decorators) {
      if (d.target.kind !== 'method' || !d.target.className) continue;
      const isRoute = ROUTE_DECORATORS.has(d.name) && prefixOf.has(d.target.className);
      const isGraphql = GRAPHQL_DECORATORS.has(d.name);
      if (!isRoute && !isGraphql) continue;
      // A route on a new class: the class is the changed symbol, its methods are part of it.
      const cls = g.symbol(file.id, d.target.className);
      const handler =
        g.symbol(file.id, `${d.target.className}.${d.target.name}`) ??
        (cls?.change === 'added' ? cls : undefined);
      if (!handler) continue;
      const isNew = handler.change === 'added';
      const what = isRoute
        ? `${d.name.toUpperCase()} ${routePath(prefixOf.get(d.target.className)!, d.args[0] ?? '')}`
        : `GraphQL ${d.name.toLowerCase()} \`${d.args[0] ?? d.target.name}\``;
      hints.push({
        ruleId: 'public-route',
        severity: isNew ? 'attention' : 'info',
        message: isNew ? `New route: ${what}` : `Route handler changed: ${what}`,
        symbolId: handler.id,
      });
    }
  }
  return hints;
}

/** Guards and roles added or changed on a class or handler. */
function guardHints(g: Graph): HintDraft[] {
  const hints: HintDraft[] = [];
  for (const { file, src } of g.codeFiles()) {
    for (const d of src.decorators) {
      if (!AUTH_DECORATORS.has(d.name) || !g.isAdded(file.id, d.line)) continue;
      const className = d.target.kind === 'class' ? d.target.name : d.target.className;
      if (!className) continue;
      const symbol = g.owner(
        file.id,
        className,
        d.target.kind === 'method' ? d.target.name : undefined,
      );
      if (!symbol) continue;
      const args = [...d.refs, ...d.args.map((a) => `'${a}'`)].join(', ');
      hints.push({
        ruleId: 'auth',
        severity: 'attention',
        message: `Access control changed: \`@${d.name}(${args})\` on ${shown(symbol)}`,
        symbolId: symbol.id,
      });
    }
  }
  return hints;
}

function routePath(prefix: string, path: string): string {
  const joined = [prefix, path]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
