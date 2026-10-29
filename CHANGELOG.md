# Changelog

## Unreleased

### M5 — GitHub pull requests, cache, progress

- `bowi https://github.com/<owner>/<repo>/pull/<n>` (also `/files`, `?…`, `#…` URLs): PR metadata, merge base (compare API) and commit subjects from the GitHub REST API; code from git, computed locally (never the PR files API).
- Repository cache: a bare, blobless, shallow repository per GitHub repository; only the head and merge-base commits are fetched (by SHA), and `git diff` downloads just the blobs it needs. A second run of the same PR fetches nothing. A lock keeps concurrent runs apart. `--cache-dir <dir>` and `bowi cache clear`.
- Token from `GITHUB_TOKEN`, else `gh auth token`; optional for public repositories, passed to git through environment config (never on the command line). Clear errors with next steps for not found / private, rejected token, rate limit and network problems (exit code 2).
- Terminal progress: a spinner while a slow stage runs (API, fetch), replaced by the usual `✓` line; plain lines in pipes and CI.
- `review.html` opens in the browser after a run at a terminal; `--no-open` to skip.
- Output folder for PRs: `.bowi/<repo>-<pr>/`. New `source.linkedIssues` from closing keywords in the description.
- Changed: edits to comment text are no longer formatting-only noise (comment layout still is); see requirement.md §15 #10.

### M4 — HTML report

- `bowi --local` now writes `review.html` next to `review-plan.json` (skip it with `--json-only`): one self-contained page, all JS and CSS inlined, no network requests.
- Page ported from `docs/prototype.html` to Preact (built with Vite + vite-plugin-singlefile into a template at build time): header with stats and "N lines need careful reading", sidebar with groups, steps and review progress, group card with kind, confidence label, reasons and hints, step view with file cards and hunks, moved-code view (unchanged lines muted, changed lines highlighted under their struck-through original), collapsed noise with "Show raw diff", outside references panel (filled in M6), alphabetical (GitHub) view linking each file to its step, dependency / tests-first order, "Mark as reviewed" and "Next", stacked layout on narrow screens, step links in the URL hash.
- Syntax highlighting with shiki at report time on whole file versions (multi-line strings and comments stay correct); every token is HTML-escaped.
- The embedded plan is escaped so repository content (`</script>`, `<!--`, line separators) cannot break the page.
- Lockfile summary (NOISE-6): direct dependencies added or removed, major version changes and installed-package counts from `package-lock.json`.
- `bun run build:ui` builds the page template; `bun run test` and `bun run build` run it first.

### M3 — Change graph, grouping, reading order

- Change graph: `calls`, `uses-type` (types, constants and changed fields), `tests` (references from test files, plus `x.spec.ts` ↔ `x.ts`), `same-symbol` (symbols changed in one hunk), `shared-literal` and `docs-mentions` (distinctive kebab/snake-case literals, docs naming a changed symbol). Names resolve through the calling file's imports (relative paths, `.js` → `.ts`, path aliases). Every edge has a one-sentence evidence and locations.
- Hub down-weighting for symbols with many structural neighbours.
- Grouping: units of symbols sharing a hunk; components over edges ≥ 0.5; Louvain split (seeded) for oversized components; a weak pass that links leftovers through down-weighted edges; then attach by strongest edge, same file, same directory, else "Other changes".
- Groups in reading order: logic groups by dependency then size, "Moved code" (moves with edits), one noise group (generated, formatting-only, unchanged moves; files without a diff in its summary). Steps by layer (`schema` + `data` = "Data shape"), files within a step in dependency order with cycles condensed (Tarjan), tests-first order.
- Rule-based titles, kinds (feature, refactor, fix, test, config, docs, mixed), reasons (fan-in summarized: "`Logger.log()` is called by 20 changed symbols") and confidence.
- Partition invariant (every hunk in exactly one step) checked on every run; a violation exits with code 3.
- Fixtures hub-change, no-links, rename-refactor and unsupported-language; fixtures can now be generated from code.
- Fixed: the git helper could crash with EPIPE when git exited before reading its input.
- `show-plan` prints groups with reasons and steps first.
- Fixed: a symbol's own declared name no longer counts as a reference (a controller method `verifyEmail` was "using" the service's `verifyEmail` instead of calling it).

### M2 — Parsing, noise, symbols, layers

- `@bowi/lang`: web-tree-sitter 0.27.1 with vendored, pinned grammars (TypeScript, TSX, JavaScript/JSX, JSON; `scripts/vendor-grammars.sh`), symbol queries per language, structural fingerprints. Independent of `@bowi/core`.
- Symbols: functions, methods (with decorators), classes, interfaces, types, top-level variables, test blocks (`describe('x')`, `it('y')`, hooks) and JSON keys two levels deep, with qualified names and signatures.
- Noise: generated files (built-in patterns at any depth, config patterns, root `.gitattributes` `linguist-generated`, header markers); formatting-only hunks by structural fingerprint of the changed code (whitespace, comments, `;`, `,`, quote style ignored; a semicolon that changes parsing is not formatting); moves by matching fully deleted and fully added symbols, exact or with line similarity ≥ 0.8, with changed lines listed. New `Hunk.move.pairHunkId` in §8 links the two halves.
- Symbol mapping: innermost symbol per changed line, lifted to the outermost new/removed symbol; file pseudo-symbol for imports and files without a grammar; change kinds added, deleted, signature, body, renamed, moved. Layers from path heuristics or config globs.
- A symbol that was only reformatted is not reported as changed, even when it shares a hunk with real changes.
- Syntax errors or files over 1 MB fall back to text-only analysis with a warning.
- Progress shows Parsed, Noise and Symbols stages; `stats.reviewLines` / `noiseLines` now separate noise from logic.
- Dev tool `scripts/show-plan.ts` prints a plan's files, hunks and symbols, or one hunk's lines (`show-plan f9:h0`).

### M1 — Local source, diff, hunks, `--json-only`

- `bowi --local [--base <branch>] [--out <dir>] [--json-only] [--no-untracked] [-q] [-v]` writes `review-plan.json` with files, hunks, stats and source metadata. Exit codes 0/1/2/3 and errors with a next step. GitHub PR URLs are recognized but rejected until M5.
- Local source: base defaults to `origin/HEAD`, then `main`, then `master`; diff is merge base vs working tree, including staged, unstaged and untracked (not ignored) files. Untracked files are added with `--intent-to-add` on a temporary copy of the index; the real index is never modified. Bowi's own `.bowi/` output is never included.
- Every git call runs with hooks and fsmonitor disabled, no optional locks, no external diff or textconv, and explicit diff flags, so the output does not depend on the user's git config.
- In-house unified diff parser: added, deleted, renamed, copied, mode-only, binary and symlink files, quoted and non-ASCII paths, "No newline at end of file" (new optional `DiffLine.noEol` in §8). File IDs `f<n>` by sorted path, hunk IDs `f<n>:h<m>`.
- Plain progress lines with timings on stderr (full display in M5).

### M0 — Scaffold

- Bun workspaces monorepo with packages `cli` (`bowi`), `core`, `sources`, `lang`, `plugins`, `rules`, `ai`, `render-html`, `cache`; TypeScript 6 strict, ESLint, Prettier, vitest. Node ≥ 20 is the runtime target.
- `@bowi/core`: `ReviewPlan` types from requirement.md §8, `BowiConfig` with defaults, the `Stage` / `StageContext` contract, and determinism helpers (`compareStrings`, `sortBy`, `comparablePlanJson`).
- `fixtures/`: deterministic git repo builder and the `email-verification` fixture (11 changed files across 4 head commits); test asserts identical SHAs across builds.
