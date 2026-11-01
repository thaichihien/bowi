# Bowi — instructions for Claude Code

Bowi (short for _bowerbird_) turns a pull request into a guided review: related changes grouped together, foundations before the code that uses them, noise collapsed, every group explained with evidence. Output: `review-plan.json` (the contract) and one self-contained `review.html`.

## Read first

- `docs/requirement.md` — the spec. Requirement IDs (CLI-1, NOISE-2, GRP-4, …) are used in code comments. **§15 Open questions** records every decision, assumption and deviation from the spec; when something is unclear, add it there instead of guessing silently.
- `docs/plan.md` — milestone plan M0–M8 and decisions taken. Do not start a later milestone's features early.
- `CHANGELOG.md` — what each milestone delivered. M0–M9 are done (M5.5 = report redesign, M6 = P1 items, M7 = grouping benchmark, M8 = AI via `claude -p`, M9 = npm release 0.1.0); M10–M17 are planned in `docs/plan.md` ("Roadmap after M8"). Each milestone after M9 ends with a minor release.
- Report design: the M5.5 redesign canvas linked in `docs/plan.md` (header, tabs Review / Description / Commits / Changes). `docs/prototype.html` is the older M4 reference (a bundled file; the page inside is a JSON string).
- `development-logs.md` (git-ignored, may not exist) — the owner's log of feedback on Bowi's code: logic and UI behavior, and decisions about them. If it exists, add an entry when the owner gives such feedback or decides such a question (or when you raise one), with date and time, and keep its "Waiting for you" list current. Do not log process topics (milestone go-aheads, pushing, cleanup, commit style, general questions).

## Architecture

Bun workspaces monorepo. Internal packages use the `@bowi/` scope; the CLI package is `@bowi/cli` (the command is `bowi`).

```
CLI ─► source (local git | GitHub PR) ─► Snapshot ─► engine stages ─► ReviewPlan ─► review-plan.json
                                                                            └─► render-html ─► review.html
```

| Package                | Role                                                                                                                                                                                                                                                                                                                                                      | Key files                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/core`        | Types (the §8 contract), engine and its stages, config (zod), the plugin and hint-rule interfaces; pure, no I/O except through the Snapshot                                                                                                                                                                                                               | `types.ts`, `engine.ts`, `snapshot.ts`, `plugin.ts`, `config.ts`, `stages/*.ts` |
| `packages/sources`     | Produce a `Snapshot`: `local.ts` (merge base vs working tree, untracked files via a temporary index), `github.ts` (REST API via built-in `fetch` + cached shallow git fetch; blame, history and grep fetch in batches); `history.ts` pins grep/blame/log output                                                                                           | `git.ts` is the only way to run git                                             |
| `packages/lang`        | web-tree-sitter wrapper: vendored grammars (`grammars/*.wasm`, TS/TSX/JS/JSON/YAML/Markdown), symbol queries (`queries/*.scm`), structural fingerprints, references/fields/imports/decorators/classes. Does **not** depend on core (kept swappable for a future Go core)                                                                                  | `parse.ts`, `symbols.ts`, `fingerprint.ts`, `references.ts`                     |
| `packages/render-html` | Node side fills the plan into a prebuilt template with shiki highlighting (`src/`); the page itself is a Preact app (`ui/`) built by Vite + vite-plugin-singlefile into `template/index.html` (git-ignored, built by `bun run build:ui`)                                                                                                                  | `src/index.ts`, `src/highlight.ts`, `src/markdown.ts`, `ui/App.tsx`             |
| `packages/cache`       | Cache location (`~/Library/Caches/bowi` on macOS), per-repo folders, cross-process lock                                                                                                                                                                                                                                                                   | `src/index.ts`                                                                  |
| `packages/cli`         | `run(argv, io)` returns the exit code (testable in-process); `bin.ts` wires it to the process; loads `.bowi.json`, passes plugins and rules to the engine                                                                                                                                                                                                 | `src/index.ts`, `src/progress.ts`                                               |
| `packages/plugins`     | Framework plugins (`FrameworkPlugin` from core): NestJS layers, `framework` edges, route and guard hints                                                                                                                                                                                                                                                  | `src/nestjs.ts`                                                                 |
| `packages/rules`       | Review hint rules (`HintRule` from core), HINT-2                                                                                                                                                                                                                                                                                                          | `src/index.ts`                                                                  |
| `packages/ai`          | Optional AI enrichment (M8): prompts, the `claude-code` provider (`claude -p` hardened: empty temporary cwd, no tools, `--safe-mode`, `--json-schema`), answer cache by request hash. The AI contract (`AiEnricher`, zod answer schemas) and the stage are in core                                                                                        | `src/prompts.ts`, `src/claude-code.ts`, `src/cache.ts`                          |
| `fixtures/`            | Deterministic git repos with known PRs for tests: `email-verification` (files under `files/`, mirrors the prototype), generated ones in `generated/index.ts` (hub-change, no-links, rename-refactor, unsupported-language), `lib/scratch.ts` for throwaway repos                                                                                          |                                                                                 |
| `scripts/show-plan.ts` | Dev tool: prints a plan's groups, files, hunks, symbols, or one hunk                                                                                                                                                                                                                                                                                      |                                                                                 |
| `bench/`               | Grouping benchmark (§12.3), a dev tool: picks runs of 3–6 clean commits from public repos (`cases/*.json`, git-ignored: the owner keeps the repository names private and gives them to `bench:select`), squashes each into a synthetic PR, labels hunks by commit (blame, reverse blame) and scores Bowi vs folder baselines with the Adjusted Rand Index | `src/main.ts`, `src/select.ts`, `src/labels.ts`, `src/evaluate.ts`              |

### Engine stages (`packages/core/src/engine.ts`)

Each stage is `(input, ctx) => Promise<output>`, documented at the top of its file.

1. **resolve** — done by the source (refs, merge base, commits).
2. **diff** (`stages/diff.ts`) — in-house unified diff parser → `FileChange[]` (IDs `f<n>` by sorted path) and `Hunk[]` (`f<n>:h<m>`).
3. **parse** (`stages/parse.ts`) — read both versions, detect generated files (`noise/generated.ts`) and the lockfile summary (`noise/lockfile.ts`), parse with `@bowi/lang`. Syntax errors or files over 1 MB fall back to text-only ("tier 0") with a warning. Returns live tree-sitter trees; the engine disposes them.
4. **noise** (`stages/noise.ts`) — hunk kinds: `generated`, `format` (equal structural fingerprints; comment _text_ counts), `move` (fully deleted symbol matched to fully added one, exact or line similarity ≥ 0.8, with `changedLineIndexes` and `pairHunkId`).
5. **symbols** (`stages/symbols.ts`) — map changed lines to the innermost symbol (lifted to the outermost new/removed one), file pseudo-symbols, change kinds, layers (`layers.ts`: config globs, then a detected plugin's `layerOf`, then path rules), line owners.
6. **history** (`stages/history.ts`) — `snapshot.blame` (PR commit per head line, only with > 1 commit) and `snapshot.baseHistory(300)`; empty when the snapshot cannot.
7. **graph** (`stages/graph.ts`) — edges `calls`, `uses-type`, `tests`, `same-symbol`, `shared-literal`, `docs-mentions`, `same-commit`, `co-change`, plugin `framework` edges, resolved through imports (`graph/imports.ts`), literals from `graph/literals.ts`, hub down-weighting.
8. **group** (`stages/group.ts`) — clustering (`group/cluster.ts`: strong components, seeded Louvain split, weak pass, attach by edge/file/directory, "Other changes", then glue — imports and injected constructor parameters — moved to the group of the code using them, `group/glue.ts`), steps in dependency order with layer tie-break (`group/steps.ts`, Tarjan), titles/kinds/reasons/confidence (`group/describe.ts`), then the partition check (`invariants.ts`).
9. **ai** (`stages/ai.ts`, only with `--ai`) — one call per logic group through an `AiEnricher` passed in by the CLI (never noise, trimmed diff), answers validated with zod, titles/intents applied, valid hunk-move suggestions kept on the group (shown, never applied), then a PR overview.
10. **refs** (`stages/refs.ts`) — outside references through `snapshot.grep`, filtered to plausible unchanged uses (`codeOnly` blanks comments and strings).
11. **hints** (`stages/hints.ts`) — runs the hint rules and plugin hints, places each on its hunk's step and group.

Plugins are detected after parse (`detect`), before symbols.

## Rules that must hold

- **Runtime is Node ≥ 22.12** (§15 #59) **and git ≥ 2.31** (§15 #61). Bun is only the dev tool: use `node:` APIs, never `Bun.*` (ESLint forbids the global). Before adding a dependency, check its `engines.node`; pin the last major that supports Node 22.12. Runtime dependencies are pinned exactly (the package build refuses ranges); grammar and shiki versions also because they change output.
- **Only `@bowi/cli` is published** (§15 #60; npm refused the name `bowi`), installing the `bowi` command: `scripts/build-package.ts` bundles every `@bowi/*` package into `build/npm/dist/` and copies grammars, queries and the page template next to it. Code that reads files of its package goes one folder up from its own module (`join(dirname(fileURLToPath(import.meta.url)), '..', …)`), which holds in `src/` and in `dist/`; a new asset folder must also be copied by the build and allowed in `scripts/smoke.ts`. No install scripts.
- **Never run code from the reviewed repository.** All git goes through `packages/sources/src/git.ts` (hooks and fsmonitor off, no optional locks, `DIFF_FLAGS` pins diff output: no external diff or textconv). No installs, scripts or builds of the target repo.
- **Privacy:** no network calls except GitHub (URL mode) and the AI provider (only when enabled; `claude -p` is a child process, its network use is Claude Code's). The AI never sees noise hunks or whole files, and a PR's own `.bowi.json` cannot turn AI on. Tokens reach git through `GIT_CONFIG_*` env vars, never argv. `review.html` makes no requests: everything inlined, no fonts or CDNs.
- **Determinism (GRP-12):** same input → identical plan except `generatedAt` and `meta.timingsMs` (`comparablePlanJson`). Sort with `compareStrings`/`sortBy` (code-unit order, never `localeCompare`); Louvain uses a seeded RNG.
- **Partition (GRP-4):** every hunk is in exactly one step of one group; a violation throws `AnalysisError` (exit code 3).
- **Noise is collapsed, never removed (NOISE-7);** lines changed during a move are never noise.
- **Escaping (UI-15):** the plan is embedded with `jsonForScript`; only `DiffLine.html` (escaped by our highlighter) and `source.descriptionHtml` (sanitized by `src/markdown.ts`) are rendered as markup.
- **Exit codes (CLI-11):** 0 ok, 1 usage (`UsageError`), 2 source (`SourceError`), 3 analysis (`AnalysisError`). Errors carry a next-step hint.
- Changing the plan contract means editing both `packages/core/src/types.ts` and §8 of the spec.

## Development

```bash
bun install
bun run check        # typecheck (3 tsconfigs) + lint + format check + build:ui + tests — must pass before committing
bun run build        # page template + tsc -b to dist/
bun run build:package # the npm package in build/npm/ (bundled with esbuild)
bun run smoke        # pack it, install it with npm in an empty folder, compare its plan with the sources'
bun run fixture email-verification ~/bowi-playground/ev   # a repo to try things on
node packages/cli/src/bin.ts --local                     # run from source (Node strips types)
node packages/cli/src/bin.ts https://github.com/<o>/<r>/pull/<n> --no-open
bun run show-plan <plan-or-dir> [hunk-id]
BOWI_REPORT=<review.html> bun run dev:ui                 # report page with hot reload, plan taken from an existing report
bun run bench                                            # grouping benchmark report (fetches the case repos once)
bun run bench explain <case>                             # one case: groups, commit of each hunk, cross-commit links
bun run bench:select <owner/repo …>                      # pick cases (local only; ask the owner which repositories)
```

- Tests are vitest under Node, in `packages/*/test`, `fixtures/test` and `bench/test`. Integration tests build real git repos from fixtures; GitHub tests use `packages/sources/test/fake-github.ts` (a file:// "server" + fake API), never the network. Tests must delete their temp folders.
- `packages/render-html/test/app.test.tsx` renders the UI in happy-dom; it has its own tsconfig. Code that resolves files next to a module must use `join(dirname(fileURLToPath(import.meta.url)), …)`, not `new URL(…, import.meta.url)` (happy-dom replaces the `URL` global).
- To look at the report, screenshot it with headless Chrome: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=<png> --window-size=1440,1100 "file://…/review.html#g1:service"` (the URL hash selects a tab or step: `#<step id>`, `#<group id>`, `#description`, `#commits`, `#changes`).

## Gotchas

- zsh treats `$VAR:r…` as a modifier: write `${VAR}:refs/…`.
- Shell heredocs turn ` ` into the real character; in source, build such characters with `String.fromCharCode`.
- Prettier reflows code after scripted edits, so a later exact-match edit can miss; re-read the file first.
- `fixtures/*/files/` are test data: excluded from lint, format, typecheck and vitest (they contain their own `*.spec.ts`). Prettier must never touch them.
- `tree-sitter-typescript` 0.23.2 cannot parse `export type * from` (§15 #11): such files fall back to tier 0 with a warning (including `packages/core/src/index.ts` itself).
- Grammars are vendored by `packages/lang/scripts/vendor-grammars.sh` (npm packages, or a GitHub release when npm has no `.wasm`). The SQL grammar has no prebuilt `.wasm` (§15 #41).
- Run `bun run bench` after changes to grouping (graph, cluster, steps, plugins) and compare the means with the last report in `CHANGELOG.md`; never tune the engine on a single case.
- In `app.test.tsx`, the page renders outside `act`, so its effects (e.g. the keyboard listener) run a frame later; `show()` unmounts the previous page so old listeners go away.

## Workflow with the owner

- Work directly on `main`; separate milestones by commits. End each milestone with a "Try it" section: commands the owner can run and what the output means.
- Push only when asked. `origin` is `https://github.com/thaichihien/bowi.git` (this machine's SSH key belongs to another account). Author: `thaichihien <thaichihien@gmail.com>`.
- Releases: set the version in `packages/cli/package.json` (the only version that counts) and the `CHANGELOG.md` heading, commit, tag `v<version>`. Pushing the tag stages the version on npm (`.github/workflows/release.yml`) and the owner approves it with 2FA; push tags only when the owner asks. The repository is private for now (§15 #62): CI runs on Linux only, no GitHub environment, no provenance.
- Markdown: one line per paragraph or list item, no hard wrapping.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, then a body that says what changed and why.

- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
- Scope (optional) is the package or area: `core`, `cli`, `sources`, `lang`, `render-html`, `cache`, `fixtures`.
- Summary in the imperative, lower case, no period, about 72 characters at most, e.g. `feat(sources): review GitHub pull requests by URL`.
- The body explains the change for a reader of `git log`: what it does, why, and anything surprising. Wrap it at about 72 characters.
- A milestone that spans packages is one `feat` commit with the milestone named in the body (e.g. "Milestone M6").
- Do not use milestone prefixes such as `M5: …` in the summary.
