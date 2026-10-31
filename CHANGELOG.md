# Changelog

## Unreleased

### M7 — Grouping benchmark

- `bun run bench` measures how well Bowi's groups recover the original commits of real pull requests (requirement.md §12.3): runs of 3–6 clean consecutive commits from public repositories are squashed into synthetic PRs, every hunk is labeled with the commit that wrote it (`git blame`, and `git blame --reverse` for removed lines), and Bowi's groups are scored against grouping by folder with the Adjusted Rand Index (1 = the original commits exactly, 0 = chance).
- 37 cases from four open-source TypeScript repositories, two of them NestJS applications. Cases are picked with `bun run bench:select <owner/repo> …` and kept on the machine (`bench/cases/` is git-ignored, so the repositories used are not published); every run there scores the same commits.
- First report (TypeScript, mean ARI): Bowi 0.51, by folder 0.38, by top folder 0.10, one group (GitHub's list) 0.00. Bowi is at least as good as grouping by folder in 28 of 37 cases: TypeScript counts as supported.
- Fixed (found by the benchmark): a PR where code moved within one hunk, or from one hunk into two, failed with exit code 3 (a hunk was placed twice). Such code is now shown as an ordinary change; a move pairs exactly two hunks.
- Fixed: lines that only changed places (e.g. swapped `app.use()` calls) were collapsed as "Formatting only", although order can change behavior. They are now a real change; reformatting still counts as formatting.
- `bun run bench explain <case>` shows why a case scores what it does: each group with the original commit of every hunk, the links joining different commits, and how each commit is spread over the groups.
- Studying the weakest cases fixed two grouping bugs (overall 0.51 → 0.52; the weakest repository 0.41 → 0.44; 5 cases better, none worse): the last line of a multi-line import (`} from "../utils/test-utils"`) counted as a shared literal and tied unrelated tests together; and a test could not be linked to a changed test entity, fixture or helper it imports (application code is still never linked to test code).
- The partial-clone helpers of the GitHub source (`ensureBareRepo`, `fetchQuiet`, `prefetchBlobs`) and the history helpers are exported from `@bowi/sources` for the benchmark.

### M6 — P1 items

- **Outside references** (GRAPH-11): each step lists unchanged code that uses what the step changes, e.g. `AuthService.login()` using the changed `User` entity. Found with `git grep` (working tree with untracked files for `--local`, the head commit for pull requests) and kept only when plausible: a method must be called as `.name(` in a file that names its class; other symbols must be imported or in their own file; never on added lines, inside changed code, in imports, comments, strings or generated files. Up to 5 per symbol (`outsideRefs.maxPerSymbol`, `0` turns it off). The panel is now titled "Unchanged code that uses these changes".
- **History links** (GRAPH-6, GRAPH-7): `same-commit` links changes in different files that came in the same commit of the PR (from `git blame`), `co-change` links files that often changed together in the last 300 commits of the base branch. Both are weak (0.4, 0.3): they only place changes that have no stronger link.
- **NestJS plugin** (PLG-1, PLG-2), on when a `package.json` depends on `@nestjs/core` or `@nestjs/common`: layers from decorators (`@Controller` → API, `@Injectable` → services, guards and interceptors → API, `@Entity` and DTOs → data shape, TypeORM migrations → schema, `@Module` → configuration), `framework` links for new constructor injections, queue jobs and events (`queue.add('welcome')` → `@Process('welcome')`, `emit('user.created')` → `@OnEvent('user.created')`), and migrations naming an entity's new columns (the entity is now read before its migration).
- **Review hints** (HINT-1, HINT-2), shown on the group card: database migration, new or changed route (Express-style calls and NestJS route decorators: "New route: GET /auth/verify-email"), changed signature / rename / removal with outside callers, lines edited inside moved code, new direct dependency (package.json or lockfile; workspace packages skipped), authentication or authorization code (paths, `@UseGuards` and similar).
- **Configuration** (CLI-9, §10): `.bowi.json` at the repository root or `--config <path>`, validated with zod; unknown keys are warnings, wrong values exit 1 naming the key. For pull requests the file is read from the base side, so a PR cannot change how it is presented. `--order dependency|tests-first` (CLI-7) sets the reading order the report opens with (new `meta.order` in the plan).
- **Keyboard** (UI-13): `j` / `k` next and previous step, `r` toggles reviewed; ignored while typing in a field.
- **Start over** (UI-12): a button next to the review progress clears reviewed steps and viewed files (after "Clear N reviewed steps and M viewed files?" → Clear / Cancel) and goes back to the first step. Disabled while nothing is marked.
- **Languages** (PARSE-2): YAML (keys two levels deep) and Markdown (sections as symbols, nested by heading level; re-wrapped paragraphs count as formatting). A README change is now a section such as `Authentication.Email verification`. SQL is not done yet: its grammar has no prebuilt WebAssembly build.
- Pull requests: history and search download only what they need, in batches, and keep it in the cache. Cold runs measured +2.4 s (ky#874) and +6.3 s (nestjs/nest#18339, 2,193 source files, 3.2 MB cache); warm runs +0.1–0.4 s. A spinner shows while they run.
- Progress shows the new stages: History, Callers, Hints; Symbols says when layers came from a plugin.
- The symbol in a hunk's header bar (`@@ −40,9 +41,20 @@ register()`) is bold, in the Review and Changes tabs.
- Fixed: in the Changes tab, the "New file" / "Deleted" label was drawn as a large empty circle that made the file header tall: it shared the `.badge` class with the check mark of the "Review complete" dialog (since `b67a758`). The dialog's classes are now `done-badge*`.
- Group titles prefer code over docs sections; reasons give each pair of symbols one sentence at most.
- New dependency in `@bowi/core`: `zod` 4.6.7.

### M5.5 — Report redesign

- New header: repo and PR number with "Generated by Bowi · head" on the right, the title, "Merging N commits from `head` into `base`" with branch badges (local: "N commits and uncommitted changes on … compared with …"), then files, +/− with GitHub's five squares, and lines needing careful reading.
- The page is split into tabs, kept in the URL hash (`#description`, `#commits`, `#changes`, `#<step id>`; old `#alpha` links open Changes):
  - **Review**: the grouped view. The Dependency order / Tests first switch and the progress bar sit on top; every step has an icon for its layer (or moved, generated, formatting); "Why these changes are grouped" is closed until opened; each file can be opened and closed, and files with more than 300 changed lines start closed.
  - **Description** (pull requests only): the description rendered as GitHub-flavored markdown (tables, task lists, strikethrough, autolinks, footnotes, `<details>`), sanitized at report time; images become links so the page stays offline; "No description provided." when empty.
  - **Commits**: oldest first, grouped by day, with author (and committer when different), "committed 2 days ago", the exact time in your time zone, the short hash with a copy button, and the full message behind "…". Local reports show an "Uncommitted changes" row.
  - **Changes**: every file in GitHub's order (folders before files), a file tree with a filter, Unified (default) or Split layout remembered per browser, "Load diff" for generated, deleted and large files, collapse / expand all.
- The Alphabetical (GitHub) view is replaced by the Changes tab.
- Reading order: a group's steps now follow their dependencies, so code is read before the steps that call or use it; the layer order only breaks ties. New layer "Helpers" (`util`) for `helpers/`, `utils/`, `lib/`, `common/`, `shared/` folders and `*.helper.*` / `*.utils.*` files, read before services (requirement.md §15 #33).
- Review tab follow-up:
  - Each file of a step has a **Viewed** checkbox that collapses it. Viewing every file of a step marks the step reviewed (a step marked by hand stays marked).
  - **Previous**, **Mark as reviewed** and **Next** float at the bottom right, so they are always in reach in a long step.
  - Each step in the sidebar has its own reviewed button: mark it without opening it.
  - **Finish review** celebrates when every step is reviewed: paper fireworks and a "Review complete" dialog with the groups, files and lines read. If steps are left, the dialog lists them with links instead. No fireworks when the system asks for reduced motion.
  - Reviewed steps and viewed files are kept in the browser (`localStorage`) for the same report and diff; entries not used for a week are deleted (requirement.md §15 #32).
- Plan: commits now carry `body`, `author`, `authoredAt`, `committer` (when different) and `committedAt`; new `source.createdAt`, `source.totalCommits` and `source.uncommitted` (see requirement.md §8, §15 #27–#31). No extra GitHub API calls.
- New dependencies in `@bowi/render-html`: `micromark` 4.0.3 with `micromark-extension-gfm` 3.0.0, and `sanitize-html` 2.17.5 (the last version that supports Node 20).

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
