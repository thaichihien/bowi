# Bowi

**Bowi** (short for _bowerbird_) turns a pull request into a guided review: related changes grouped together, foundations before the code that uses them, noise collapsed, and every group explained with evidence. The result is one self-contained `review.html`.

Status: early development.

```bash
bowi https://github.com/<owner>/<repo>/pull/<n>   # review a GitHub pull request
bowi --local [--base <branch>]                    # review the current branch, including uncommitted work
```

Both write `review-plan.json` and `review.html` to `.bowi/<repo>-<pr-or-branch>/` and open the page. Private repositories need `GITHUB_TOKEN` or `gh auth login`. Fetched code is cached (`bowi cache clear` removes it). See [docs/requirement.md](docs/requirement.md) and [docs/plan.md](docs/plan.md).

In the report, `j` / `k` move to the next and previous step and `r` marks the current step reviewed.

### AI titles and intents (optional)

With `--ai`, Bowi asks Claude, through your local [Claude Code](https://claude.com/claude-code) and its login (no API key), to title each group, explain in 1–3 sentences what it does, and write an overview of the whole change (in the Description tab). It may also suggest that a hunk belongs to another group; suggestions are shown on the group card, never applied. AI-written text is marked "AI" in the report. Off by default.

Sent: each group's diff (only lines near changes; never generated files, formatting-only changes, moved code or whole files), its symbols and links, and the PR title, description and commit subjects. Claude Code runs in an empty folder with no tools and without your CLAUDE.md, hooks or plugins. Answers are checked before use and cached, so a second run asks nothing. If a call fails, that group keeps Bowi's own title.

## What Bowi understands

Best supported today: **TypeScript and JavaScript projects, especially NestJS backends**, where every feature applies. Other TypeScript/JavaScript projects (React, Next.js, Express, libraries) get everything except framework-specific layers, links and hints. Files in other languages are still shown, grouped and never dropped, but as plain text.

### Languages

| Language                                              | Files                                                 | What Bowi does with it                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript, TSX, JavaScript, JSX                      | `.ts` `.mts` `.cts` `.tsx` `.js` `.mjs` `.cjs` `.jsx` | Full support: changes mapped to functions, methods, classes, interfaces, types, top-level constants and test blocks; links from calls, types, imports and tests; formatting-only changes and moved code detected; unchanged callers listed; hints |
| JSON                                                  | `.json`                                               | Keys two levels deep (e.g. `dependencies.nodemailer`); `package-lock.json` summarized (new, removed and major-version dependencies)                                                                                                               |
| YAML                                                  | `.yaml` `.yml`                                        | Keys two levels deep (e.g. `jobs.build`)                                                                                                                                                                                                          |
| Markdown                                              | `.md` `.markdown`                                     | Sections by heading (e.g. `Authentication.Email verification`); re-wrapped text counts as formatting; docs join the code they mention                                                                                                             |
| Everything else (SQL, Python, Go, Java, Ruby, CSS, …) |                                                       | Text only: diffed and grouped by shared names and folders, with syntax highlighting when available; no symbols or move detection. SQL support is planned                                                                                          |

Generated files are collapsed as noise, never removed: lockfiles (npm, Yarn, pnpm, Bun), `dist/`, `*.min.js`, `*.min.css`, `*.snap`, `*.gen.ts`, `*.generated.*`, files whose header says `@generated` or `DO NOT EDIT`, files marked `linguist-generated` in `.gitattributes`, and your `generated` globs. Only npm lockfiles get a dependency summary.

### Frameworks

| Framework                         | How it is detected                                     | What Bowi adds                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS                            | `@nestjs/core` or `@nestjs/common` in a `package.json` | Layers from decorators (table below); links from code that queues a job or emits an event to its handler (`queue.add('welcome')` → `@Process('welcome')`, `emit('user.created')` → `@OnEvent('user.created')`), from a class to a service it newly injects, and from a migration to the entity columns it adds; hints for new or changed routes (`New route: GET /auth/verify-email`) and for added `@UseGuards`, `@Roles`, `@Public` |
| Express, Fastify, Koa and similar | Always on                                              | Hints for new or changed routes written as `router.post('/users', …)`; layers from folders                                                                                                                                                                                                                                                                                                                                            |
| Others (React, Next.js, Vue, …)   |                                                        | Layers from folders and file names only                                                                                                                                                                                                                                                                                                                                                                                               |

### Layers

Each group is split into steps by layer. Steps are read in dependency order (code before the steps that call it); when two steps do not depend on each other, the order below decides. A file's layer comes from your `.bowi.json` `layers` first, then from NestJS decorators, then from its path (the first matching row in the order test, docs, config, schema, data, domain, service, API, helpers, UI).

| Step          | Layer     | Path rules                                                                                                                                                                                      | NestJS decorators                                                                                                      |
| ------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Data shape    | `schema`  | `migrations/`, `schema/`, `schemas/`, `prisma/`; `.sql` `.prisma` `.graphql` `.gql` `.proto`                                                                                                    | Classes implementing `MigrationInterface` (TypeORM)                                                                    |
| Data shape    | `data`    | `entities/`, `models/`, `repositories/`, `dto/`, `interfaces/`, `types/`; `*.entity.ts`, `*.model.ts`, `*.repository.ts`, `*.dto.ts`, `*.schema.ts`, `*.interface.ts`, `*.types.ts`, `types.ts` | `@Entity`, `@Schema`, `@ObjectType`, `@InputType`, `@ArgsType`; DTO classes with validation decorators (`@IsEmail`, …) |
| Helpers       | `util`    | `helpers/`, `utils/`, `lib/`, `common/`, `shared/`; `helpers.ts`, `utils.ts`, `*.helper.ts`, `*.util.ts`                                                                                        |                                                                                                                        |
| Domain        | `domain`  | `domain/`                                                                                                                                                                                       |                                                                                                                        |
| Services      | `service` | `services/`, `jobs/`, `workers/`, `processors/`, `queues/`; `*.service.ts`, `*.processor.ts`, `*.worker.ts`, `*.job.ts`                                                                         | `@Injectable`, `@Processor`                                                                                            |
| API           | `api`     | `controllers/`, `routes/`, `handlers/`, `resolvers/`, `api/`, `endpoints/`; `*.controller.ts`, `*.resolver.ts`, `*.route(s).ts`, `*.handler.ts`, `*.gateway.ts`                                 | `@Controller`, `@Resolver`, `@WebSocketGateway`, `@Catch`; `@Injectable` guards, interceptors, pipes and middleware    |
| UI            | `ui`      | `components/`, `pages/`, `views/`, `app/`, `screens/`, `layouts/`; `.tsx` `.jsx` `.vue` `.svelte` `.css` `.scss` `.html`                                                                        |                                                                                                                        |
| Other code    | `unknown` | Anything not matched                                                                                                                                                                            |                                                                                                                        |
| Configuration | `config`  | `package.json`, `tsconfig*.json`, `*.config.*`, `.*rc` files, `.env*`, `Dockerfile`, `docker-compose*`, `Makefile`, `.github/`, `.yml` `.yaml` `.toml` `.ini`, lockfiles                        | `@Module`                                                                                                              |
| Tests         | `test`    | `test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`; `*.spec.ts`, `*.test.ts`, `*.e2e-spec.ts` (and `.js`)                                                                                         | Never: test files keep their path layer                                                                                |
| Docs          | `docs`    | `docs/`; `.md` `.mdx` `.rst` `.adoc`; `README`, `CHANGELOG`, `CONTRIBUTING`, `LICENSE`                                                                                                          |                                                                                                                        |

If a folder misleads Bowi (e.g. a service under `common/` that is not a NestJS class), set its layer in `.bowi.json`.

## Configuration

Bowi reads `.bowi.json` from the repository root (for a pull request: the file as it is on the base branch, so a PR cannot change how it is presented), or the file given with `--config <path>`. Every key is optional; unknown keys are reported and ignored.

```json
{
  "base": "main",
  "generated": ["src/graphql/generated/**", "**/*.pb.ts"],
  "layers": { "schema": ["db/migrations/**"], "api": ["src/**/routes/**"] },
  "grouping": { "edgeThreshold": 0.5, "moveSimilarity": 0.8, "maxGroupShare": 0.4 },
  "outsideRefs": { "maxPerSymbol": 5 },
  "order": "dependency",
  "ai": { "enabled": false, "provider": "claude-code", "model": "sonnet", "effort": "low" }
}
```

| Key                        | Meaning                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`                     | Base branch for `--local` (default `origin/HEAD`, else `main`, else `master`). `--base` wins                                                            |
| `generated`                | Extra globs for generated files, shown collapsed as noise                                                                                               |
| `layers`                   | Globs per layer (`schema`, `data`, `util`, `domain`, `service`, `api`, `ui`, `config`, `test`, `docs`), checked before framework plugins and path rules |
| `grouping.edgeThreshold`   | Minimum link weight (0–1) that puts two changes in one group                                                                                            |
| `grouping.moveSimilarity`  | How similar (0–1) moved code must stay to count as a move                                                                                               |
| `grouping.maxGroupShare`   | Share of all changes (0–1] above which a large group is split                                                                                           |
| `outsideRefs.maxPerSymbol` | Unchanged callers listed per changed symbol (0–50); `0` turns the search off                                                                            |
| `order`                    | Reading order the report opens with: `dependency` or `tests-first`. `--order` wins                                                                      |
| `ai.enabled`               | AI titles and intents (see above). `--ai` / `--no-ai` win. Ignored in a pull request's own `.bowi.json`: only you can turn it on                        |
| `ai.model`                 | Model for Claude Code, e.g. `sonnet` (empty: Claude Code's default)                                                                                     |
| `ai.effort`                | `low`, `medium`, `high`, `xhigh` or `max` (empty: Claude Code's default)                                                                                |
| `ai.concurrency`           | Calls to Claude at once (1–10, default 3)                                                                                                               |
| `ai.timeoutSeconds`        | Time per call before that group keeps Bowi's own title (default 120)                                                                                    |
| `ai.provider`              | `claude-code`, the only provider so far                                                                                                                 |

## Development

Bun is the package manager and script runner. The CLI itself targets **Node ≥ 20**, so code uses only `node:` APIs, never `Bun.*`. Tests run on vitest under Node.

```bash
bun install
bun run check          # typecheck, lint, format check, tests
bun run fixture email-verification /tmp/ev   # build a fixture repo to play with
```

| Script                                      | What it does                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`                              | vitest                                                                                                                                             |
| `bun run typecheck`                         | tsc over sources, tests and fixtures                                                                                                               |
| `bun run lint` / `bun run format`           | ESLint / Prettier                                                                                                                                  |
| `bun run build`                             | compile every package to `dist/`                                                                                                                   |
| `bun run show-plan <plan-or-dir> [hunk-id]` | print a `review-plan.json` readably (dev tool)                                                                                                     |
| `BOWI_REPORT=<review.html> bun run dev:ui`  | the report page with hot reload, for working on its look: edits to `packages/render-html/ui/` show at once; the plan comes from an existing report |
| `bun run bench`                             | grouping benchmark: Bowi vs folder grouping on real commits (§12.3); `bun run bench explain <case>` details one case                               |

Layout: `packages/*` are the workspace packages from requirement.md §11.3 (`@bowi/core`, `@bowi/sources`, …; the CLI package is `bowi`). `fixtures/` builds deterministic git repos with known PRs; each fixture's source files live in `fixtures/<name>/files/` and are excluded from lint, format and typecheck because they are test data.

## License

MIT
