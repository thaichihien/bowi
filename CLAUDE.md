# Bowi — instructions for Claude Code

Bowi (short for _bowerbird_) turns a pull request into a guided review: related changes grouped together, foundations before the code that uses them, noise collapsed, every group explained with evidence. Output: `review-plan.json` (the contract) and one self-contained `review.html`.

## Read first

- `docs/requirement.md` — the spec. Requirement IDs (CLI-1, NOISE-2, GRP-4, …) are used in code comments. **§15 Open questions** records every decision, assumption and deviation from the spec; when something is unclear, add it there instead of guessing silently.
- `docs/plan.md` — milestone plan M0–M8 and decisions taken. Do not start a later milestone's features early.
- `CHANGELOG.md` — what each milestone delivered. M0–M5 are done; next is M6 (P1 items), then M7 (benchmark), M8 (AI via `claude -p`).
- `docs/prototype.html` — the reference design for the HTML report (a bundled file; the page inside is a JSON string).
- `development-logs.md` (git-ignored, may not exist) — the owner's log of feedback on Bowi's code: logic and UI behavior, and decisions about them. If it exists, add an entry when the owner gives such feedback or decides such a question (or when you raise one), with date and time, and keep its "Waiting for you" list current. Do not log process topics (milestone go-aheads, pushing, cleanup, commit style, general questions).

## Architecture

Bun workspaces monorepo. Internal packages use the `@bowi/` scope; the CLI package is `bowi`.

```
CLI ─► source (local git | GitHub PR) ─► Snapshot ─► engine stages ─► ReviewPlan ─► review-plan.json
                                                                            └─► render-html ─► review.html
```

| Package                           | Role                                                                                                                                                                                                                                                             | Key files                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/core`                   | Types (the §8 contract), engine and its stages; pure, no I/O except through the Snapshot                                                                                                                                                                         | `types.ts`, `engine.ts`, `snapshot.ts`, `stage.ts`, `stages/*.ts` |
| `packages/sources`                | Produce a `Snapshot`: `local.ts` (merge base vs working tree, untracked files via a temporary index), `github.ts` (REST API via built-in `fetch` + cached shallow git fetch)                                                                                     | `git.ts` is the only way to run git                               |
| `packages/lang`                   | web-tree-sitter wrapper: vendored grammars (`grammars/*.wasm`, TS/TSX/JS/JSON), symbol queries (`queries/*.scm`), structural fingerprints, references/fields/imports. Does **not** depend on core (kept swappable for a future Go core)                          | `parse.ts`, `symbols.ts`, `fingerprint.ts`, `references.ts`       |
| `packages/render-html`            | Node side fills the plan into a prebuilt template with shiki highlighting (`src/`); the page itself is a Preact app (`ui/`) built by Vite + vite-plugin-singlefile into `template/index.html` (git-ignored, built by `bun run build:ui`)                         | `src/index.ts`, `src/highlight.ts`, `ui/App.tsx`                  |
| `packages/cache`                  | Cache location (`~/Library/Caches/bowi` on macOS), per-repo folders, cross-process lock                                                                                                                                                                          | `src/index.ts`                                                    |
| `packages/cli`                    | `run(argv, io)` returns the exit code (testable in-process); `bin.ts` wires it to the process                                                                                                                                                                    | `src/index.ts`, `src/progress.ts`                                 |
| `packages/plugins`, `rules`, `ai` | Empty placeholders for M6 (NestJS plugin, review hints) and M8 (AI)                                                                                                                                                                                              |                                                                   |
| `fixtures/`                       | Deterministic git repos with known PRs for tests: `email-verification` (files under `files/`, mirrors the prototype), generated ones in `generated/index.ts` (hub-change, no-links, rename-refactor, unsupported-language), `lib/scratch.ts` for throwaway repos |                                                                   |
| `scripts/show-plan.ts`            | Dev tool: prints a plan's groups, files, hunks, symbols, or one hunk                                                                                                                                                                                             |                                                                   |

### Engine stages (`packages/core/src/engine.ts`)

Each stage is `(input, ctx) => Promise<output>`, documented at the top of its file.

1. **resolve** — done by the source (refs, merge base, commits).
2. **diff** (`stages/diff.ts`) — in-house unified diff parser → `FileChange[]` (IDs `f<n>` by sorted path) and `Hunk[]` (`f<n>:h<m>`).
3. **parse** (`stages/parse.ts`) — read both versions, detect generated files (`noise/generated.ts`) and the lockfile summary (`noise/lockfile.ts`), parse with `@bowi/lang`. Syntax errors or files over 1 MB fall back to text-only ("tier 0") with a warning. Returns live tree-sitter trees; the engine disposes them.
4. **noise** (`stages/noise.ts`) — hunk kinds: `generated`, `format` (equal structural fingerprints; comment _text_ counts), `move` (fully deleted symbol matched to fully added one, exact or line similarity ≥ 0.8, with `changedLineIndexes` and `pairHunkId`).
5. **symbols** (`stages/symbols.ts`) — map changed lines to the innermost symbol (lifted to the outermost new/removed one), file pseudo-symbols, change kinds, layers (`layers.ts`), line owners.
6. **graph** (`stages/graph.ts`) — edges `calls`, `uses-type`, `tests`, `same-symbol`, `shared-literal`, `docs-mentions`, resolved through imports (`graph/imports.ts`), literals from `graph/literals.ts`, hub down-weighting.
7. **group** (`stages/group.ts`) — clustering (`group/cluster.ts`: strong components, seeded Louvain split, weak pass, attach by edge/file/directory, "Other changes"), steps in layer + dependency order (`group/steps.ts`, Tarjan), titles/kinds/reasons/confidence (`group/describe.ts`), then the partition check (`invariants.ts`).

## Rules that must hold

- **Runtime is Node ≥ 20.** Bun is only the dev tool: use `node:` APIs, never `Bun.*` (ESLint forbids the global). Before adding a dependency, check its `engines.node`; pin the last major that supports Node 20 (e.g. commander 14, not 15; no current execa). Grammar and shiki versions are pinned exactly because they change output.
- **Never run code from the reviewed repository.** All git goes through `packages/sources/src/git.ts` (hooks and fsmonitor off, no optional locks, `DIFF_FLAGS` pins diff output: no external diff or textconv). No installs, scripts or builds of the target repo.
- **Privacy:** no network calls except GitHub (URL mode) and the AI provider (only when enabled). Tokens reach git through `GIT_CONFIG_*` env vars, never argv. `review.html` makes no requests: everything inlined, no fonts or CDNs.
- **Determinism (GRP-12):** same input → identical plan except `generatedAt` and `meta.timingsMs` (`comparablePlanJson`). Sort with `compareStrings`/`sortBy` (code-unit order, never `localeCompare`); Louvain uses a seeded RNG.
- **Partition (GRP-4):** every hunk is in exactly one step of one group; a violation throws `AnalysisError` (exit code 3).
- **Noise is collapsed, never removed (NOISE-7);** lines changed during a move are never noise.
- **Escaping (UI-15):** the plan is embedded with `jsonForScript`; only `DiffLine.html` (escaped by our highlighter) is rendered as markup.
- **Exit codes (CLI-11):** 0 ok, 1 usage (`UsageError`), 2 source (`SourceError`), 3 analysis (`AnalysisError`). Errors carry a next-step hint.
- Changing the plan contract means editing both `packages/core/src/types.ts` and §8 of the spec.

## Development

```bash
bun install
bun run check        # typecheck (3 tsconfigs) + lint + format check + build:ui + tests — must pass before committing
bun run build        # page template + tsc -b to dist/
bun run fixture email-verification ~/bowi-playground/ev   # a repo to try things on
node packages/cli/src/bin.ts --local                     # run from source (Node strips types)
node packages/cli/src/bin.ts https://github.com/<o>/<r>/pull/<n> --no-open
bun run show-plan <plan-or-dir> [hunk-id]
```

- Tests are vitest under Node, in `packages/*/test` and `fixtures/test`. Integration tests build real git repos from fixtures; GitHub tests use `packages/sources/test/fake-github.ts` (a file:// "server" + fake API), never the network. Tests must delete their temp folders.
- `packages/render-html/test/app.test.tsx` renders the UI in happy-dom; it has its own tsconfig. Code that resolves files next to a module must use `join(dirname(fileURLToPath(import.meta.url)), …)`, not `new URL(…, import.meta.url)` (happy-dom replaces the `URL` global).
- To look at the report, screenshot it with headless Chrome: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=<png> --window-size=1440,1100 "file://…/review.html#g1:service"` (the URL hash selects a step: `#<step id>`, `#<group id>`, `#alpha`).

## Gotchas

- zsh treats `$VAR:r…` as a modifier: write `${VAR}:refs/…`.
- Shell heredocs turn ` ` into the real character; in source, build such characters with `String.fromCharCode`.
- Prettier reflows code after scripted edits, so a later exact-match edit can miss; re-read the file first.
- `fixtures/*/files/` are test data: excluded from lint, format, typecheck and vitest (they contain their own `*.spec.ts`). Prettier must never touch them.
- `tree-sitter-typescript` 0.23.2 cannot parse `export type * from` (§15 #11): such files fall back to tier 0 with a warning.

## Workflow with the owner

- Work directly on `main`; separate milestones by commits. End each milestone with a "Try it" section: commands the owner can run and what the output means.
- Push only when asked. `origin` is `https://github.com/thaichihien/bowi.git` (this machine's SSH key belongs to another account). Author: `thaichihien <thaichihien@gmail.com>`.
- Markdown: one line per paragraph or list item, no hard wrapping.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, then a body that says what changed and why.

- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
- Scope (optional) is the package or area: `core`, `cli`, `sources`, `lang`, `render-html`, `cache`, `fixtures`.
- Summary in the imperative, lower case, no period, about 72 characters at most, e.g. `feat(sources): review GitHub pull requests by URL`.
- The body explains the change for a reader of `git log`: what it does, why, and anything surprising. Wrap it at about 72 characters.
- A milestone that spans packages is one `feat` commit with the milestone named in the body (e.g. "Milestone M6").
- Do not use milestone prefixes such as `M5: …` in the summary.
