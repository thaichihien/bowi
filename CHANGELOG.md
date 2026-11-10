# Changelog

## Unreleased (0.2.0)

### M10 — Line comments in the report

- Comment on lines in the report, as on GitHub (UI-25): hover a line in the Review tab (step files, expanded noise, moved code by its new lines) or the Changes tab (unified and split) and press **+**; Shift-click or drag for a range. Only lines shown in a hunk take a comment, because GitHub and GitLab accept nothing else. A file's header has a button for a comment on the whole file. Design: the M10 canvas (`docs/plan.md`).
- The comment box has Write / Preview and a toolbar like GitHub's (Bold, Italic, Quote, Code, Link, lists; ⌘B, ⌘I, ⌘K, ⌘Enter to add, Esc to cancel). Comments are Markdown, rendered in the page with raw HTML off: tags show as text, unsafe links lose their address, images become links (UI-15, UI-26).
- Comments show under their lines: in Bowi's look in Review, in GitHub's look in Changes (in the line's column in split). Each can be edited, deleted (no question; "Comment deleted · Undo" for 8 seconds) or hidden; "Hide comments" hides them all, in Review and Changes. Hiding is not remembered (owner's decision); a hidden comment leaves a badge on its line that shows it again.
- A Comments tab (UI-27): the review summary (with the same editor), every comment by file in GitHub's order with the lines it is about, outdated comments last; filters (all, not saved, outdated), folding per file, "Copy all as Markdown", and "Clear all comments" after an inline confirmation (it clears the summary too). "Start over" still clears only review progress.
- Comments are kept in `review-plan.json` (`ReviewPlan.review`, an addition; `schemaVersion` stays 1), with their lines' text when written and no author. The determinism check leaves them out, and the engine never reads them.
- `bowi serve <dir>` (CLI-13) serves a report on `127.0.0.1` with a random port and token, so its page can save: every change goes into the plan right away, and into `review.html` too. `--serve` on a run writes the report and serves it. The page shows the save status next to the tabs. Opened as a file, the page keeps new, edited and deleted comments as drafts in the browser ("Not saved", 30 days) and says how to save them; the served page offers to save them ("Save all" / "Discard"). A failed save (server stopped) keeps the change as a draft too.
- Re-runs keep comments (§15 #64): a comment whose lines still read the same moves to where they are now, the others are kept as outdated with their snippet; the run prints "✓ Comments 2 kept (1 moved), 1 outdated". Comments of another review in the same folder are kept aside in `review-plan.json.bak`, never mixed in.
- `bowi comments <dir>` lists the comments, `--markdown` prints them for pasting (CLI-14). `--no-comments` leaves them out of `review.html` (CLI-15).
- The page is bigger: the template grew from 86 KB to 210 KB, most of it micromark with GitHub-flavored Markdown, which comments need in the browser (the fixture's report: 190 KB → 311 KB).
- The smoke test also serves the installed package's report and saves a comment into it.

### M11 — Post comments to GitHub

- "Post to GitHub" in the served report (UI-28) sends the comments to the pull request, under your own login. It is never automatic: a dialog says where and as whom, and lists what goes where, each with a checkbox. Bowi contacts GitHub only when you press the button.
- Pending review by default: a draft on GitHub that only you see until you submit it there. "Post now" makes it public at once. The two never look alike ("Sent as pending" against "Posted"), and "Open on GitHub" is always at the top of a pull request's report (after a pending review it opens the files, where you submit). The reminder of a pending review can be dismissed, and "I submitted it" marks the review as posted once you submitted it on GitHub. Filters "Sent as pending" and "Posted".
- "Use another token" in the dialog posts with a GitHub token you paste, with an optional name, even when `gh` or `GITHUB_TOKEN` already gives a login. `bowi serve` checks it with GitHub and keeps it in memory until it stops; it is never saved.
- `bowi comments push <dir>` does the same from the terminal (CLI-16): it lists, then asks. `--yes` skips the question and stops if the pull request has new commits since the report, `--now` posts at once, `--outdated` includes outdated comments.
- One direction (§15 #70): Bowi sends and reads nothing back. What was sent is read-only in Bowi and changed on GitHub; Bowi never changes or removes anything there. A comment records how it was sent in the plan (`sync`, `bodySync`; an addition, `schemaVersion` stays 1), so nothing is sent twice, also after a send that stopped half way.
- A line GitHub refuses goes on its file, starting with its lines, and the dialog says which. An outdated comment starts unticked and, if ticked, goes on its file quoting the old lines. A timeout says to check the pull request before trying again.
- The token stays in the local server; the page talks only to that. `gh` stays optional: with no login, the message says whether `gh` is missing or only not logged in.
- Fixed: the Outdated filter of the Comments tab also listed every active comment.

## 0.1.1 (2026-11-04)

### M9.1 — Windows

- Bowi runs on Windows (with Git for Windows): `npm install -g @bowi/cli` no longer refuses it, and `bowi --local`, `bowi <PR URL>` and `--ai` work there. Moved forward from 0.2.0 (requirement.md §15 #63).
- Fixed: on a working tree checked out with CRLF line endings (`core.autocrlf=true`, Git for Windows' default, or `text`/`eol` attributes) every file was read with a `\r` on each line while its diff had none, so parsing, formatting-only detection, symbols and highlighting worked on text that did not match the diff. Bowi now reads such files the way git diffs them; a file committed with CRLF keeps it, as in git. Applies on every system.
- Hooks stay off on Windows too: Git for Windows reads `core.hooksPath=/dev/null` as `C:\dev\null\`, so Bowi passes the reserved name `NUL` there.
- The cache is in `%LOCALAPPDATA%\bowi` on Windows (`XDG_CACHE_HOME` still wins). The report opens with `explorer`.
- `--ai` on Windows needs the native Claude Code (`claude.exe`, `irm https://claude.ai/install.ps1 | iex`); with only the npm package's `claude.cmd` on PATH, Bowi says so instead of "not installed". An aborted call no longer reports "EBUSY" instead of its real error, and two runs writing the same cached answer no longer fail on Windows.
- `--out` folders inside the repository are excluded from untracked files on Windows too (the exclude used `\`).
- Development: a `.gitattributes` keeps the repository LF on every checkout; fixture repositories rehash their files, because a copied file keeps its modification time on Windows; tests run on Windows (longer timeouts there; the cases that need a fake `git`, `"` in file names, the executable bit or symlinks run on macOS and Linux only); a new test covers CRLF working trees; `bun run smoke` works on Windows; CI adds `windows-latest`.

## 0.1.0 (2026-11-01)

The first version: everything from M0 to M9 below.

### M9 — Release on npm

- Install with `npm install -g @bowi/cli` (or `pnpm add -g @bowi/cli`, `bun add -g @bowi/cli`), which installs the `bowi` command, or run without installing: `npx @bowi/cli --local`. No clone, Bun or build step needed. Needs Node 22.12 or newer and git 2.31 or newer, on macOS or Linux (Windows in 0.2.0).
- One package, `@bowi/cli` (npm refused `bowi` as too similar to existing names such as `bower`): every internal `@bowi/*` package is bundled into it (`dist/bowi.js`, 217 KB, not minified), with the grammars, queries and the prebuilt report page. Third-party packages (shiki, web-tree-sitter, graphology, zod, micromark, sanitize-html, commander, picomatch) are its dependencies, pinned to exact versions. Package: 23 files, 502 KB packed, 4.1 MB unpacked; installed with its dependencies, 50 MB in 104 packages (shiki's language grammars are 17 MB of it).
- Installing runs nothing: the package has no install scripts, and the smoke test installs it with `--ignore-scripts` to prove it needs none. No telemetry and no update check.
- Node ≥ 22.12 (was ≥ 20; Node 20 reached end of life on 2026-04-30). An older Node gets "Bowi needs Node 22.12 or newer; this is Node 20.11.0." and exit 1, before anything else loads. 22.12 is the oldest Node that commander 15 and sanitize-html 2.18 support.
- git ≥ 2.31 is checked before every run: a missing git or an older one exits 2 with how to install it ("Bowi needs git 2.31 or newer; this is git version 2.30.9."). 2.31 added the environment config Bowi uses to pass a GitHub token to git without putting it on the command line. Before, a missing git failed without a next step.
- `bowi --version`, the plan's `meta.tool.version` and the report header show the package version (0.1.0; was a fixed 0.0.0).
- Updated: commander 14 → 15.0.0, sanitize-html 2.17.5 → 2.18.1 (both need Node 22.12), `@types/node` 20 → 22.
- `bun run build:package` builds the package into `build/npm/`; `bun run smoke` packs it, checks that only the expected files are in it, installs it with plain npm into an empty folder, and runs it on the email-verification fixture: the plan must equal the one the sources produce.
- GitHub Actions: `CI` runs `bun run check` with Node 22 and 24, and the smoke test with Node 22.12.0 and 24, on every push to main and every pull request (Linux only while the repository is private). `Release` stages the version on npm when a `v*` tag is pushed, after the check and the smoke test and only if the tag matches the version, through npm trusted publishing (no npm token stored in GitHub); it goes out when the owner approves it with 2FA. A version already on npm is skipped.
- README: installation from npm; running from a clone moved to Development.

### M8 — AI titles and intents through Claude Code

- `bowi … --ai` (or `"ai": { "enabled": true }` in `.bowi.json`, CLI-8, AI-1) asks Claude, through the local Claude Code CLI and your own Claude Code login (no API key), to title each group of changes, write its intent in 1–3 sentences, and write a short overview of the whole pull request. AI titles carry the "AI" chip in the report and the intent replaces the rule-based description on the group card (code in it shows as code). `--no-ai` turns it off when the config turns it on. Off by default.
- Before anything is sent, Bowi says what goes where: "AI is on: group diffs (no noise, no whole files) and the PR title and description go to Claude through Claude Code, with your Claude Code login."
- What is sent (AI-4), one request per group: the PR title, description (first 3,000 characters) and commit subjects; the group's rule-based title, reasons, steps and changed symbols; its diff with only 2 unchanged lines around each change, at most 80 lines per hunk and 600 per group; the other groups' titles, files and symbols. Never noise (generated, formatting-only, moved code) and never whole files.
- `claude -p` runs hardened: in an empty temporary folder, with no tools, no MCP servers, no slash commands, no saved session, and `--safe-mode`, so your CLAUDE.md, hooks and plugins neither see the request nor change the answer. GitHub tokens are not passed on. Flags checked against Claude Code 2.1.314.
- Every answer is checked against a schema (AI-5): a title of one line up to 100 characters, an intent up to 600, an overview up to 1,200. An invalid, failed or late answer (2 minutes per call) keeps Bowi's own title for that group and adds a warning; "not logged in" or a usage limit stops the remaining calls. Up to 3 calls run at once.
- The AI may suggest that a hunk belongs to another group (e.g. an import added for another group's code). Suggestions are shown on the group card ("Suggests `source/core/Ky.ts:29` belongs with …", linking the hunk's step and the other group; "Suggests reading this group together with …" when every hunk would go to the same group) and never applied: the groups stay as Bowi made them. Suggestions naming an unknown hunk, a hunk of another group, or a noise or moved-code group are dropped.
- The overview is shown in the Description tab, below the PR description, marked AI with the model that wrote it. Local changes get a Description tab when there is an overview.
- Settings: `ai.model` (e.g. `sonnet`; empty is Claude Code's default, Opus at the time of writing), `ai.effort` (`low`, `medium`, `high`, `xhigh`, `max`; empty is Claude Code's default), `ai.concurrency` (calls at once, default 3), `ai.timeoutSeconds` (per call, default 120).
- Answers are cached by a hash of the request (AI-6), in `<cache>/ai/`: a second run on the same changes asks nothing ("2 from cache") and gives the same text. `bowi cache clear` deletes them.
- Each group the AI titled credits it on the right of the card's first line, next to "Group 2 of 7 · 2 files": "Written by claude-sonnet-5-5 · low effort · via Claude Code" (the model that answered, the configured effort, the provider). The overview card in the Description tab carries the same credit.
- AI-written text (group intents, the overview) is justified and uses the card's full width, with hyphenation for words but never inside code.
- The plan records `meta.ai` (`provider`, the `model` that answered, and `effort` when configured), the new `overview` and `Group.moveSuggestions` (AI only; requirement.md §8).
- For pull requests, the repository's own `.bowi.json` cannot turn AI on or pick the model (it would send code on the reviewer's account); a warning says so. Use `--ai`, or `--config` with your own file.
- `claude` missing: exit 1 with "Install Claude Code … and run `claude` once to log in, or run without --ai." Providers other than `claude-code` (`anthropic`, `openai`, `ollama`) are accepted in the config but not available yet (exit 1).
- Measured with Sonnet: the email-verification fixture 8.4 s (1 group and the overview), sindresorhus/ky#874 15–20 s (6 groups, the overview, one suggestion: an import belongs with the group of the module it imports); 0.0 s from the cache.
- Fixed: a step that uses nothing (e.g. UI) could be read first when the first step in layer order had to wait for one of its dependencies (seen in a NestJS pull request: UI → interface → Data shape → Services). Dependencies now go right before the step that needs them and the rest keeps the layer order (interface → Data shape → Services → UI → Tests); the same applies to the order of groups and of files in a step (requirement.md §15 #56).
- Fixed: an added import or an injected constructor parameter (`private readonly eventEmitter: EventEmitter2,`) could end up in another group than the methods using it, even in a group of its own made only of imports. Such hunks now join the group of the code in the same file that uses the name they introduce, also through a chain (import → constructor parameter → methods using the field). Benchmark: 4 cases better, 1 case −0.01, mean 0.52 (requirement.md §15 #57).
- `interfaces/` and `types/` folders and `*.interface.ts`, `*.types.ts`, `types.ts` files are now Data shape, read with entities and DTOs (they were "Other code").
- `BOWI_REPORT=<review.html> bun run dev:ui` serves the report page with hot reload, taking the plan from an existing report, so its style can be adjusted live (dev tool).
- New package contents in `@bowi/ai`: prompts, the `claude-code` provider and the answer cache; the AI contract and stage are in `@bowi/core` (`ai.ts`, `stages/ai.ts`), which still does no I/O of its own.

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
