# Bowi — Implementation plan

Companion to [requirement.md](requirement.md). M0–M8 follow the milestone order in §13. M9 onward are planned here, in [Roadmap after M8](#roadmap-after-m8-planned-2026-10-31); the spec sections each one touches are updated when that milestone starts. Nothing from a later milestone is started early.

## Decisions taken (2026-10-28)

| Topic | Decision |
|---|---|
| AI enrichment | First provider is **`claude-code`**: Bowi spawns the local `claude` CLI headless (`claude -p --output-format json`), using the user's Claude Code login, no API key. Anthropic / OpenAI / Ollama API providers come later behind the same `AiProvider` interface |
| Prototype | Owner will add the prototype to the repo before M4. M0–M3 do not depend on it |
| `--local` untracked files | Included by default; `--no-untracked` opts out |
| License | MIT |
| Windows | v0.2 (macOS + Linux only in v0.1, per NFR-6) |
| Node 20 compatibility of dependencies | Check `engines.node` before adding a dependency; pin to the last major that supports Node 20 (e.g. `commander` 14, not 15). `@types/node` is pinned to 20 |
| Package manager / dev tooling | **Bun** (1.4.4) for install, workspaces and running scripts. **Node ≥ 20 stays the supported runtime** for users: code uses only `node:` APIs, never `Bun.*`. Tests stay on vitest, run under Node, so Node compatibility is what gets tested |

## Milestones

### M0 — Scaffold

- `git init`, `.gitignore`, MIT `LICENSE`, `CHANGELOG.md`, `README.md` stub.
- Bun workspace with packages from §11.3: `cli`, `core`, `sources`, `lang`, `plugins`, `rules`, `ai`, `render-html`, `cache` (empty packages get a placeholder `index.ts` only).
- TypeScript (strict, ESM, project references), ESLint + Prettier, vitest at root, Node ≥ 20 in `engines`.
- `packages/core/src/types.ts` exactly as §8, plus a `Stage<I, O>` type `(input: I, ctx: StageContext) => Promise<O>` and a `StageContext` (config, logger, warnings sink, clock injected so `generatedAt` is the only time-dependent field). The cache handle is added to the context in M5, when the cache exists.
- `fixtures/email-verification/build.ts`: creates a git repo in a temp dir with fixed author/committer, `GIT_*_DATE`, `base` and `head` branches, contents per §12.1. Test: building twice gives identical head SHAs.

Done when `bun run test` passes and the fixture builds deterministically.

### M1 — Local source, diff, hunks, `--json-only`

- `sources/git.ts`: one `git()` helper over `node:child_process` (current `execa` needs Node ≥ 22) that always passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, sets `GIT_OPTIONAL_LOCKS=0`, and pins diff output with explicit flags (`--no-ext-diff --no-textconv`, prefixes, algorithm, context, rename limit) so neither the repo nor the user's git config can change it (SRC-7, NFR-4).
- `sources/local.ts`: resolves base (`--base` → `origin/HEAD` → `main` → `master`), merge base, and a Snapshot whose head is the working tree. Untracked files are included via `git add -N` on a **temporary index** (`GIT_INDEX_FILE`) so the user's real index is never touched.
- `Snapshot` interface: `{ baseSha, headSha, mergeBaseSha, readFile(version, path), diff(), commits(), meta }`; engine only sees this (SRC-1).
- `core/stages/diff.ts`: small in-house unified-diff parser (more control than `parse-diff` over renames, copies, mode, binary). Stable IDs = `f<n>` by sorted path, `f<n>:h<m>` by order in file (DIFF-2).
- `cli`: commander, `--local`, `--base`, `--out`, `--json-only`, `--quiet`, `--verbose`, exit codes (CLI-11), error messages with next step (CLI-12).

Done when the fixture's JSON lists the 11 files and expected hunks (snapshot test).

### M2 — Parsing, noise, symbols, layers

- `lang/`: `web-tree-sitter` loader, grammars TS / TSX / JS / JSON as vendored `.wasm` files (pinned versions checked for ABI match with the `web-tree-sitter` version), `tags.scm`-style queries per language.
- Parse old + new per file; errors degrade to tier 0 with a warning (PARSE-3/4, NFR-5).
- Noise: generated patterns + header sniffing + `.gitattributes` (NOISE-1); formatting-only by comparing normalized ASTs of the enclosing symbol, not just the whole file, so a file with one real change and many reformats is split correctly (NOISE-2); moves by normalized-AST hash of removed vs added symbols, similarity ≥ 0.8 for moved-with-edits with `changedLineIndexes` (NOISE-3/4).
- Symbol mapping to innermost enclosing symbol, change classification, file pseudo-symbol (SYM-1..3). Layers by path heuristics (SYM-4).

Done when §12.2 noise checks pass: lockfile generated, `date.ts` format, `slugify` move with exactly one changed line.

### M3 — Graph, grouping, ordering

- P0 edges: `calls`, `uses-type`, `tests`, `same-symbol`, `shared-literal` (with stoplist + min length), each with an evidence sentence. Hub down-weighting (GRAPH-10).
- Clustering with `graphology`: components over weight ≥ 0.5, Louvain split above the size cap (seeded RNG for determinism), singleton fallback chain (GRP-3).
- Steps by layer, topological order with Tarjan SCC condensation, path tiebreak (GRP-7). Group order (GRP-8), reasons, confidence, rule titles and kinds.
- `assertPartition()` and a determinism test that runs twice and diffs JSON minus `generatedAt` (GRP-4, GRP-12). Floor guarantee fallback: folder groups in layer order (NFR-8).
- Fixtures `hub-change`, `no-links`, `rename-refactor`, `unsupported-language`.

Done when all of §12.2 except HTML items pass, plus the 4 extra fixtures.

### M4 — HTML renderer (needs the prototype)

- Also NOISE-6 (lockfile direct-dependency summary): UI-7 (P0) shows "1 new dependency: nodemailer", so it is needed here rather than in M6.

- `render-html`: Preact app ported from the prototype, built by Vite + `vite-plugin-singlefile` into `template.html` at package build time. CLI injects the plan JSON escaped (`<` → `<`, also ` / `) into a `<script type="application/json">` (UI-15).
- shiki highlighting runs in Node during render, filling `DiffLine.html` (UI-14). Only the shiki languages we need are bundled.
- All UI P0 items (UI-1..9, 11, 14, 15, 18). Test: no `http(s)://` outside repository content, no `<script src>` / `<link href>`.

### M5 — GitHub source, caching, progress

- Done as planned except: API through built-in `fetch` (no Octokit), shallow SHA fetches into the cache, parse cache deferred; see requirement.md §15 #23–#25.

- Token from `GITHUB_TOKEN` else `gh auth token` (SRC-2). Octokit for PR metadata + compare API merge base (SRC-3).
- Cached partial clone (`--filter=blob:none`, bare) under `~/.cache/bowi/repos/<owner>/<repo>`, fetch only base/head/merge-base SHAs; reused across runs (SRC-4).
- Parse cache by content hash. Progress display per §11.2 (listr2), `--no-open`, `open` only on TTY, `bowi cache clear`.

### M5.5 — Report redesign

Design: [Bowi report redesign canvas](https://claude.ai/artifact/EcKK5DZAY5rdWEC8pGFyPV) (private to the owner). Feedback and decisions: requirement.md §15 #27–#32.

- Header: repo · PR number (or local changes) with "Generated by Bowi · head" on the right; title; "Merging N commits from `head` into `base`" with branch badges; files, +/− with GitHub's five squares, lines needing careful reading. The view and reading-order switches leave the header.
- Tabs (UI-19), kept in the URL hash: **Review** (the M4 page: reading-order switch and progress on top, step icons per layer, "why grouped" closed by default, files that open and close, large ones closed), **Description** for PRs (UI-20: micromark + GFM, `sanitize-html` allowlist, images as links), **Commits** (UI-21) and **Changes** (UI-22: GitHub order, file tree with filter, unified / split, "Load diff" for generated, deleted and large files). The Alphabetical view is replaced by Changes.
- Plan contract: `Commit` with author, committer, dates and body; `source.createdAt`, `totalCommits`, `uncommitted`. Sources fill them from the data they already fetch (no extra API calls).
- Follow-up (2026-10-31): Viewed checkbox per file in a step (UI-23), floating Previous / Mark as reviewed / Next (UI-11), a reviewed button per step in the sidebar, and review progress saved in the browser for a week (UI-12, moved here from M6).

### M6 — P1 items

Outside references (~~`@vscode/ripgrep`, fallback~~ `git grep`, searched in a `git worktree`-free way by grepping the head tree via `git grep <sha>` on the bare cache), `same-commit` / `co-change` / `docs-mentions` edges, NestJS plugin, hints rule set, `.bowi.json` with zod (unknown keys warn), ~~reviewed-state persistence~~ (done in M5.5), keyboard shortcuts, tests-first order, YAML / SQL / Markdown grammars.

- Done as planned except: `git grep` only, no ripgrep (§15 #34); SQL grammar deferred, no prebuilt `.wasm` exists (§15 #41); `docs-mentions` was already built in M3 (§15 #18); tests-first order existed since M3, M6 adds `--order` and config `order` (`meta.order`, §15 #44). Decisions: §15 #34–#44.
- Snapshot gains optional `blame(paths)`, `baseHistory(limit)` and `grep(words, extensions)`; the GitHub source fetches for them in batches and keeps the result in the cache (§15 #35).
- Engine stages added: history (after symbols), outside references and hints (after groups). Plugins and hint rules are passed to `analyze()` by the CLI (`FrameworkPlugin`, `HintRule` in `@bowi/core`), so core does not depend on `@bowi/plugins` or `@bowi/rules`.
- Report: keyboard (UI-13), opens in `meta.order`, hint text with code spans; hints stay on the group card (moving them to steps or files is a design-canvas change, §15 #40).

### M7 — Benchmark

ARI harness from §12.3 over at least 2 TypeScript repos, baselines alphabetical and group-by-top-folder.

- Done as planned, plus a third baseline (the file's own folder) and a "code hunks only" score (§15 #45). Four open-source TypeScript repositories (two NestJS applications), 37 cases; the cases and repository names stay local (`bench/cases/` is git-ignored).
- First report: TypeScript supported, Bowi 0.51 vs folder 0.38 (§12.3).
- Studying the weakest cases with `bun run bench explain` fixed two grouping bugs (§15 #48): Bowi 0.52.
- The benchmark found two engine bugs, fixed here: moves paired with their own hunk or with two hunks (exit code 3), and reordered lines counted as formatting (§15 #46, #47).

### M8 — AI enrichment via Claude Code

- Done as planned except: one call per logic group plus one for the overview, run after groups and before outside references and hints; hunk moves are suggestions shown on the group card, never applied (owner's decision); `ai.effort`, `ai.concurrency`, `ai.timeoutSeconds` settings; `--safe-mode` instead of `--bare` (which ignores the Claude Code login); the notice is printed on every run with AI, not only the first; the overview is shown in the Description tab below the PR description (owner's decision), which local changes now get too when there is an overview. Decisions: requirement.md §15 #49–#55.
- Flags verified against Claude Code 2.1.314: `-p --output-format json --tools "" --safe-mode --strict-mcp-config --disable-slash-commands --no-session-persistence --system-prompt … --json-schema …` and `--model` when configured.

- `ai/provider.ts`: `interface AiProvider { id; describe(): string; enrich(req: GroupEnrichRequest): Promise<unknown> }`. Output always validated with zod by the caller, never trusted (AI-5).
- `ai/providers/claude-code.ts`: spawns `claude -p --output-format json` with the prompt on stdin. Hardening:
  - runs in an **empty temporary cwd**, so the session cannot read the repo beyond what Bowi sends (AI-4 "never whole files");
  - all tools disabled and single turn, so it only answers;
  - user settings / hooks / CLAUDE.md not loaded where the CLI allows it, so output does not depend on the user's personal setup;
  - the exact flags are verified against the installed CLI version at M8 time (currently 2.1.312) and a missing `claude` binary gives a CLI-12 style error ("Install Claude Code or run `claude` once to log in").
- Concurrency limit (default 3), per-group timeout, failure of one call keeps the rule-based result for that group and adds a warning.
- First use prints "Bowi will send group diffs (no noise, no whole files) to Claude via Claude Code" (AI-1). Cache by input hash; `titleSource: 'ai'` (AI-6). Move-hunk suggestions that break the partition are rejected (AI-5).
- Config: `"ai": { "enabled": true, "provider": "claude-code", "model": "" }`; `provider` enum leaves room for `anthropic`, `openai`, `ollama`.

## Roadmap after M8 (planned 2026-10-31)

### Targets set by the owner (2026-10-31)

| Target | Notes |
|---|---|
| Publish the CLI | Installed and run as `bowi`, with no clone, no `bun install` and no `node …/bin.ts`. This is the **first version, 0.1.0**: M0–M8 plus the release work of M9 |
| Line comments in the report | Select lines and write a comment, the way a PR review works; comments are saved in the plan file as a record |
| Sync comments to the real PR | A button that posts the comments to the pull request on its host |
| GitLab | Merge requests by URL, like GitHub pull requests |
| More languages | Java, C#, Python, Go, … |
| More frameworks | React, Next.js, Angular, … |
| More AI providers | Codex, ChatGPT, the Anthropic API, … |

Comments posted to the host and GitLab support were phases 2–3 and non-goals in the spec (requirement.md §4 "Posting to GitHub", §14 "comments synced to GitHub, GitLab/Gitea support"). They are now in scope. The only comments Bowi posts are ones a human wrote and chose to send. Bowi still writes no review comments of its own (§4 "Automated code review comments" stays a non-goal).

### Decisions (2026-10-31)

| Topic | Decision |
|---|---|
| Minimum Node | **Node ≥ 22** from 0.1.0. Node 20 reached end of life on 2026-04-30, and raising the minimum after release would break installs. Applied in M9: `engines`, `@types/node` 22, CI on Node 22 and 24, and the "Runtime" rule in `CLAUDE.md`. Dependencies held back for Node 20 (commander 14, sanitize-html 2.17.5) may move to newer majors, after checking their `engines.node` |
| Windows | Stays in v0.2, so it is part of M10 |
| Order | M9–M17 as in the table below |
| Published packages (2026-11-01) | Only `bowi`, with the internal `@bowi/*` packages bundled into it; reserve the `@bowi` scope on npm. Internals are published later only when a real consumer of the engine appears |
| Saving comments (2026-11-01) | Runs keep writing a static `review.html` and exit, as today. `bowi serve <dir>`, or `--serve` on a run, serves the report locally so comments can be saved and posted. Whether runs should serve by default is decided after using it |

### Order and why

| # | Milestone | Release | Why here |
|---|---|---|---|
| M9 | Release 0.1.0 on npm | 0.1.0 | Everything else is easier to try, report and benchmark once people can install it. It changes no features, so it is the safest first version |
| M10 | Line comments in the report; Windows | 0.2.0 | Turns the report from read-only into a review tool. Needs a way for the page to save (a local server, below), and M11 builds on that |
| M11 | Post comments to GitHub | 0.3.0 | Finishes the review loop on the host Bowi already supports. The host interface it introduces is the one GitLab implements in M13 |
| M12 | More AI providers | 0.4.0 | Small and independent (the provider interface exists since M8). Once Bowi is public, many users will have an API key or Codex but no Claude Code |
| M13 | GitLab merge requests (source and comment sync) | 0.5.0 | Second host, done after M11 so that it delivers reading and posting together |
| M14 | Frameworks for TypeScript/JavaScript: React, Next.js, Angular | 0.6.0 | The language is already fully supported, so this is plugin work only (`FrameworkPlugin` from M6). Large audience, little engine risk |
| M15 | Languages, wave 1: Python and Go | 0.7.0 | The engine has TypeScript-specific parts (imports, glue, outside references, hints). These two languages force the language interface to be general. Both have simple module systems (file paths, directories) |
| M16 | Languages, wave 2: Java and C# | 0.8.0 | Harder name resolution (packages without imports for the same package, C# namespaces not tied to files, partial classes, overloads). Builds on the interface from M15 |
| M17 | Frameworks for the new languages: Spring Boot, ASP.NET Core, Django, FastAPI, Go routers | 0.9.0 | Needs its language first. Same plugin interface as NestJS |

Rules for every milestone after M9: each ends with a minor release (0.x.0, fixes in between as 0.x.y). `bun run check` and the smoke test of the packed package must pass before a release. A milestone that changes grouping runs `bun run bench` and compares the means with the last report in `CHANGELOG.md`. A UI change goes through the design canvas first.

### M9 — Release 0.1.0 on npm

Goal: on a machine with only Node and git, `npm install -g bowi` (or `npx bowi`, `pnpm dlx bowi`, `bunx bowi`) followed by `bowi https://github.com/<o>/<r>/pull/<n>` produces a report. Nothing else is needed.

- **One published package, `bowi`** (decided 2026-11-01). The internal `@bowi/*` packages are bundled into it (esbuild or rolldown, a dev dependency only) and stay `private`, so they are not public API and can keep changing. Third-party dependencies (shiki, web-tree-sitter, graphology, zod, micromark, sanitize-html, commander, picomatch) stay normal `dependencies`, with their pinned versions kept exact. Shiki and the grammars change output, and bundling shiki's language loading is fragile.
- **Assets in the package**: `grammars/*.wasm` with their licenses, `queries/*.scm`, and the built page template (`template/index.html`), so users never run `build:ui`. Today `packages/lang/src/loader.ts` and `packages/render-html/src/index.ts` find these files relative to their own source file (`'..'` from `src/`). Once bundled into one file, that path no longer holds. Add one asset-root helper that works from both the sources (dev) and `dist/` (published), and test it from the packed package.
- **Built JavaScript, not TypeScript.** `dist/bin.js` with `#!/usr/bin/env node`, so the published CLI runs on any Node ≥ 22, not only on Node 22.18+ like the sources (which rely on Node stripping TypeScript types). `bin.ts` checks the Node version first, using syntax any old Node can parse, and exits 1 with "Bowi needs Node 22 or newer".
- **No install scripts** (`preinstall`, `postinstall`): installing Bowi runs nothing, in line with its own rule of never running other people's code. Nothing is downloaded at run time either. No telemetry and no update check: NFR-3 stays as it is.
- **One version number.** `VERSION` in `packages/cli/src/index.ts` is hard-coded to `'0.0.0'` today. It must come from the `bowi` package's `version`, and it shows in `--version`, in `meta.tool.version` and in the report header ("Generated by Bowi 0.1.0").
- **Package contents check.** `npm pack --dry-run` in CI lists the files. No tests, fixtures, `src/*.ts`, bench, `docs/prototype.html` or source maps of the fixtures. Record the tarball and installed sizes in the CHANGELOG.
- **Smoke test of the packed package** (a script, `bun run smoke`, also in CI): `npm pack`, install the tarball into an empty temporary folder with npm and no workspace, then run `bowi --version` and `bowi --local --no-open` on the email-verification fixture, and check that the plan and report exist and match what the sources produce (`comparablePlanJson`). It runs on Node 22 and 24.
- **CI (GitHub Actions)**: `bun run check` on pushes and pull requests, on macOS and Linux. A release workflow on a `v*` tag: check, smoke test, then `npm publish --provenance` through npm trusted publishing (OIDC, no long-lived npm token stored in GitHub).
- **Owner tasks before the first publish**: npm account with 2FA, check that `bowi` is still free (it was on 2026-10-28, §15 #1) and publish it, optionally reserve the `@bowi` scope, and configure the trusted publisher on npm for `thaichihien/bowi`.
- **Docs**: README "Installation" becomes `npm install -g bowi` / `npx bowi …`, "From source" moves to "Development", and "Status: early development" becomes the version. `CHANGELOG.md`: the "Unreleased" milestones become "0.1.0 — <date>", keeping the M0–M8 sections under it. Spec §13 gains M9, and §15 #1 records the publish.

Done when a fresh macOS and a fresh Linux machine (CI runners) with only Node and git run `npx bowi@0.1.0 --local` and `npx bowi@0.1.0 <public PR URL>`, and both write a working report.

### M10 — Line comments in the report

Goal: a reviewer selects one or more diff lines in the report, writes a comment, and the comment is kept in `review-plan.json`. Design canvas first: where the comment box opens, how threads show on lines, and a list of all comments (a tab or a panel).

- **Selecting lines**, as on GitHub: a "+" on hover next to a line number, shift-click or drag for a range, in the Review tab (step files, expanded noise, moved code by its new lines) and the Changes tab (unified and split). Only lines shown in a hunk can be selected, changed or context, because GitHub and GitLab accept comments only there. One file-level comment per file, and one overall review comment (the summary a reviewer writes when submitting).
- **Saving needs something that can write.** `review.html` is a static `file://` page and cannot write files. `bowi serve [dir]` (decided 2026-11-01) serves an existing report folder on `127.0.0.1` (random port, a random token in the URL, `Host` and `Origin` checked against DNS rebinding) and accepts only comment writes for that folder. The page detects it. Opened as a plain file, the page keeps drafts in `localStorage` and says how to save them ("Run `bowi serve <dir>` to save comments"). It also offers "Copy all as Markdown", which works with any host. `--serve` on a run writes the report and then serves it, in one command. A run without it writes the static file and exits, as today; serving by default is reconsidered after using it.
- **Comments in the plan**, as the owner asked: `ReviewPlan.review` (an addition, `schemaVersion` stays 1) with `comments: ReviewComment[]` and the overall `body`. A `ReviewComment` has `id`, `body` (Markdown text), `anchor` (`path`, `side` old or new, `startLine`, `endLine`, `hunkId`, and the head SHA the lines belong to), `snippet` (the commented lines' text when written), `createdAt`, `updatedAt` and `status` (`active`, `outdated`). There is no author email, because `review.html` may be shared (§15 #27).
- **Determinism (GRP-12):** comments are user data, not analysis. `comparablePlanJson` leaves `review` out, and the engine never reads it.
- **Re-runs keep comments.** A run writing into a folder whose old plan has comments carries them over. A comment whose lines are still in the diff with the same text is moved to their new position. Otherwise it is kept as `outdated` and shown with its snippet, as GitHub does after a push. Nothing is ever dropped silently: the run prints "3 comments kept, 1 outdated".
- **Escaping (UI-15):** a comment body is user text. It is rendered as escaped text with code spans, or with the same sanitized Markdown as descriptions if the design asks for formatting. The server returns only JSON.
- **Editing and deleting** (decided 2026-11-01). In the served page, every comment can be edited or deleted. Deleting one shows "Comment deleted · Undo" for a few seconds instead of asking first. "Clear all comments" asks first, inline, like "Start over" ("Delete 7 comments?" → Delete / Cancel). "Start over" keeps clearing only review progress, never comments: progress records where you are, while comments are work you wrote. An outdated comment can be deleted the same way. After M11, a posted comment can still be edited (it then shows "Changed since posted"), and deleting it asks whether to delete it here only or on GitHub too.
- **Opened as a plain file**, the page shows the comments that were in the plan when the report was written. New, edited and deleted comments become drafts in the browser, marked "Not saved". When the same report is later opened through `bowi serve`, the page offers to save those drafts into the plan.
- **Sharing.** A report sent to someone carries its comments. `--no-comments` leaves them out of `review.html`; they stay in the plan.
- CLI: `bowi comments <dir>` lists the comments in the terminal and `--markdown` prints them for pasting.
- **Windows** (decided for v0.2): git through `git.exe`; paths in the plan kept as git prints them (`/`) and converted only to touch the file system; working trees with CRLF line endings (`--local` must not show changes that only `core.autocrlf` causes; verify); the cache under `%LOCALAPPDATA%\bowi`; the browser opened with `start`; hooks turned off without relying on `/dev/null` (verify what Git for Windows accepts); `bowi serve` included. CI and the smoke test also run on `windows-latest`. Spec NFR-6 makes Windows P0.

Done when comments written in the served page appear in `review-plan.json`, survive a re-run on the same and on a changed diff (moved, or outdated), `app.test.tsx` covers selecting, editing, deleting, clearing and the file mode without a server, and CI passes on Windows.

### M11 — Post comments to GitHub

Goal: from the served report, "Post to GitHub" sends the comments to the pull request, as a review by the reviewer's own account. It is never automatic.

- **The token stays in Node.** The page talks only to the local `bowi serve` server, and the server calls the GitHub API with the token it already uses (`GITHUB_TOKEN`, else `gh auth token`). The page never sees the token and makes no request to GitHub, so UI-1 still holds for the page. Posting needs write access ("Pull requests: write", or the `repo` scope for classic tokens). A read-only token gets a clear message with the next step.
- **Confirm before posting.** A dialog lists exactly what goes where and as whom (the login from `GET /user`): "Post 5 comments to octo/app#42 as @alice". This is the only way anything is posted. The same is available as `bowi comments push <dir>`, which asks for confirmation unless `--yes` is given.
- **Pending review by default.** All new comments go into one review created as pending (no `event`), and the reviewer submits it on GitHub. Nothing is public until then. An option "Submit as comment" posts it at once. GitHub allows one pending review per user per PR, and REST cannot add comments to an existing pending review (GraphQL `addPullRequestReviewThread` can). Verify both when the milestone starts.
- **Mapping lines.** `path`, `line`, `side` (`LEFT` for old, `RIGHT` for new), and `start_line` / `start_side` for ranges, against the report's head SHA as `commit_id`. If the PR has new commits since the report, the dialog says so: post against the old head (GitHub marks them outdated) or re-run first. A line GitHub rejects (outside its diff, e.g. a rename found differently) falls back to a file-level comment starting with "Lines 40–45:", and the dialog says which.
- **Sync state in the plan.** Each comment records `sync: { host, id, url, syncedAt }`, so nothing is posted twice. A comment edited after posting shows "Changed since posted" and can be updated on GitHub. Deleting a comment locally never deletes it on GitHub. A comment deleted on GitHub stays in the plan as a record.
- **A host interface** (`ReviewHost`: who am I, post review, update comment), so M13 adds GitLab without changing the page. `--local` reports have no PR to post to. They offer "Copy all as Markdown" only.
- Tests with `fake-github.ts` extended with the review endpoints. Never the network.
- Spec: §4 and §14 are updated (human comments posted on request are in scope), and NFR-3 says GitHub is written to only when the user posts.

Done when comments written in a report of a PR on a test repository appear on GitHub as a pending review on the right lines, ranges included, and a second "Post" sends nothing.

### M12 — More AI providers

Goal: `--ai` works with what the reviewer already has. Same `AiEnricher`, prompts, zod validation, cache and "never noise, never whole files" as M8.

| Provider id | What it uses | Notes |
|---|---|---|
| `claude-code` | Local Claude Code and its login | M8 |
| `codex` | Local OpenAI Codex CLI (`codex exec`) and its login, which can be a **ChatGPT** plan | The way to use a ChatGPT subscription: ChatGPT has no API of its own. Hardened like `claude-code`: empty temporary folder, read-only sandbox, no tools where the CLI allows it, the answer schema passed to the CLI, flags verified against the installed version when the milestone starts |
| `anthropic` | Anthropic Messages API, `ANTHROPIC_API_KEY` | Structured output with the answer schema |
| `openai` | OpenAI API, `OPENAI_API_KEY` | `json_schema` response format |
| `openai-compatible` | Any OpenAI-style endpoint: Ollama, LM Studio, vLLM, gateways | `ai.baseUrl` from the user's own config only. Local models keep code on the machine |
| `gemini` (candidate) | Gemini CLI or API | Only if it can be hardened like the others |

- **Keys come only from environment variables**, never from `.bowi.json`. A pull request's `.bowi.json` already cannot turn AI on (§15 #53). Extend that rule: it cannot set the provider, model or `baseUrl` either.
- **Privacy rule change:** with an API provider, Bowi itself connects to that provider's endpoint, instead of through a child process. NFR-3 and the "Privacy" rule in `CLAUDE.md` list it: GitHub or GitLab, plus the configured AI endpoint when AI is on. The notice names the provider and the endpoint: "AI is on: group diffs … go to api.anthropic.com with your ANTHROPIC_API_KEY".
- The default model per API provider is documented and settable, because APIs have no "default" the way CLIs do. The credit line names the provider ("via Codex", "via Anthropic API"). For API providers, the progress line also shows the tokens used, taken from the API's usage fields.
- Compare providers on the email-verification fixture and ky#874. Record titles, time and cost in the CHANGELOG.

Done when each provider titles the fixture's groups. A missing key or CLI exits 1 with how to set it up. A bad answer keeps Bowi's own title, as in M8.

### M13 — GitLab merge requests

- **URLs**: `https://gitlab.com/<group>/<subgroup…>/<project>/-/merge_requests/<n>` (nested groups). Self-managed hosts are recognized by the `/-/merge_requests/` path, and their API base comes from the user's config (`gitlab.hosts`).
- **API v4** through `fetch`: the merge request (title, description, author, branches, `diff_refs` with base, start and head SHAs, so the merge base comes from GitLab), its commits, and the closing issues. Token from `GITLAB_TOKEN`, else the `glab` CLI's stored token (verify how `glab` exposes it). Optional for public projects. Errors follow CLI-12, like GitHub's.
- **Code from git**, as for GitHub (SRC-4, SRC-5): the same bare, blobless, shallow cache, fetched by SHA, falling back to `refs/merge-requests/<n>/head`. The token goes through `GIT_CONFIG_*`. Cache folders become `<host>/<path>`, because GitLab paths can be deeper than `<owner>/<repo>`. Existing GitHub caches are migrated or simply refetched.
- History, blame and grep work unchanged, since they are git-based. The description renders with the existing GFM renderer (GitLab-only syntax such as `!12` references stays text).
- **Comment sync** through the `ReviewHost` interface from M11: GitLab draft notes with a `position` (base, start and head SHAs, old/new path and line, line ranges), published together, which mirrors GitHub's pending review. Verify multi-line positions when the milestone starts.
- Report wording: "Merge request !12", "Merging N commits from `source` into `target`", checked on the design canvas.
- Tests with a fake GitLab next to `fake-github.ts`.

Done when a public gitlab.com merge request URL produces a report, and comments post to a test project as draft notes.

### M14 — Frameworks for TypeScript/JavaScript

Same plugin interface as NestJS (PLG-1: `detect`, `layerOf`, `extraEdges`, `hints`), detected from `package.json`.

- **React** (`react`): components (PascalCase functions or classes returning JSX) → UI. Custom hooks (`use*`) → Helpers. Edges: a component rendering `<Child>` (check that JSX elements already count as references), `createContext` ↔ `useContext(X)`, hook uses. Hints: changed props of a component with outside uses.
- **Next.js** (`next`): routes from the file system (`app/**/page.tsx`, `layout.tsx`, `route.ts`, `pages/**`, `pages/api/**`, `middleware.ts`). Route handlers and server actions (`'use server'`) → API. Hints: "New page: /settings/billing", "New API route: POST /api/users", a file crossing the `'use client'` boundary.
- **Angular** (`@angular/core`): decorators like NestJS (`@Component`, `@Directive`, `@Pipe` → UI, `@Injectable` → services, `@NgModule` → configuration). Edges: a component ↔ its `templateUrl` HTML and `styleUrls` files (today HTML is text-only and linked only by shared words), a template using `<app-foo>` → the component with `selector: 'app-foo'`, DI through constructor parameters and `inject()`. Route hints from `Routes` arrays.
- Vue and Svelte single-file components need a grammar for the file format first. They are a candidate for this milestone or later.
- Benchmark: add React, Next.js and Angular repositories chosen by the owner (kept private like the others). Each plugin must not lower the mean.

### M15 — Languages, wave 1: Python and Go

- **A language interface first.** Today several engine parts assume TypeScript: import resolution (`graph/imports.ts`), glue (`group/glue.ts`: imports and constructor parameter properties), outside references (`refs.ts`: `.name(` calls, the extensions grepped, `codeOnly`), formatting fingerprints, test conventions, route hints, generated and lockfile patterns. They move behind a per-language module (grammar, symbol query, imports, references, test files, layer rules, fingerprint rules, generated files, lockfiles), and TypeScript becomes its first implementation, with no change in output: the plans of every fixture and the benchmark stay identical.
- **Python**: modules from paths (`a/b/c.py` → `a.b.c`, `__init__.py`, relative imports), classes, functions, methods and decorators. Tests: `test_*.py`, `*_test.py`, `tests/`, pytest functions, unittest classes. Indentation is syntax, so the formatting fingerprint must keep it; reformatting by Black or Ruff still counts as formatting. Lockfiles: `poetry.lock`, `uv.lock`, `Pipfile.lock`, with dependency hints from `pyproject.toml` and `requirements*.txt`. Generated: `*_pb2.py`.
- **Go**: the package is the directory, and imports resolve through the module path in `go.mod`. Symbols: functions, methods by receiver (`(*Server).Start`), types, interfaces, constants and variables. Tests: `*_test.go`, `TestX`. `gofmt` changes count as formatting. Noise: `go.sum`, `*.pb.go`, and the `// Code generated … DO NOT EDIT.` header (already a marker). Dependency hints from `go.mod`.
- Grammars are vendored with `vendor-grammars.sh`, ABI-checked against web-tree-sitter 0.27.1, and their shiki languages added.
- Benchmark: cases from Python and Go repositories chosen by the owner. A language counts as supported by the same rule as TypeScript (§15 #45): mean ARI at least 0.10 above the better folder baseline, and at least as good in two thirds of the cases.

### M16 — Languages, wave 2: Java and C#

- **Java**: packages and imports (single, wildcard, static), classes in the same package used without an import, classes, interfaces, enums, records, methods with their parameter types in the name so that overloads stay apart (`save(User)`), annotations. Tests under `src/test/java`, `*Test.java`, `*IT.java`, `@Test`. Layers from the usual Maven and Gradle layout. Noise: `target/`, `build/generated/`, `gradle.lockfile`. Dependency hints from `pom.xml` and `build.gradle(.kts)`.
- **C#**: namespaces are not tied to files, so names resolve through `using` and the namespaces declared in the PR's and the base's files. Partial classes span files and must be one symbol. Symbols: classes, records, structs, interfaces, properties, methods with overloads. Tests: `*Tests.cs`, xUnit, NUnit and MSTest attributes. Noise: `*.Designer.cs`, `*.g.cs`, `packages.lock.json`, `obj/`. EF Core `Migrations/` → schema. Dependency hints from `PackageReference` in `.csproj`.
- Kotlin is a candidate here, since it shares Java's layout and frameworks.
- Benchmark per language, as in M15.

### M17 — Frameworks for the new languages

- **Spring Boot** (Java, Kotlin): `@RestController` / `@Controller` → API, `@Service` → services, `@Repository` and `@Entity` → data shape, `@Configuration` → configuration. Route hints from `@GetMapping`, `@PostMapping`, … Edges from constructor injection. Flyway and Liquibase migrations → schema.
- **ASP.NET Core** (C#): `[ApiController]` and minimal APIs (`app.MapGet`) → API with route hints. DI registrations (`services.AddScoped<IFoo, Foo>()`) link an interface to its implementation. `DbContext` and EF Core migrations → data shape and schema.
- **Django**: models, views, `urls.py` (`urlpatterns` route hints), migrations. **FastAPI / Flask**: route decorators with hints, Pydantic models → data shape.
- **Go routers** (net/http, Gin, Echo, chi): route hints from `HandleFunc`, `r.GET(…)`.

### Later (not placed yet)

- More languages: Kotlin, Rust, PHP, Ruby, Swift. SQL as soon as a `.wasm` grammar can be built (§15 #41).
- Vue and Svelte single-file components (if not in M14).
- Showing a PR's existing review threads in the report (read-only, from the host's API).
- Other hosts: Bitbucket, Gitea / Forgejo, Azure DevOps (through the `ReviewHost` interface).
- A standalone binary (no Node needed) and a Homebrew formula.
- From spec §14: GitHub Action, MCP server, interdiff between pushes, stacked-PR split suggestions.

### Questions for the owner (all decided)

1. ~~**Minimum Node for 0.1.0.**~~ **Decided 2026-10-31:** Node ≥ 22 (see Decisions above).
2. ~~**One package or many.**~~ **Decided 2026-11-01:** only `bowi` (see Decisions above).
3. ~~**Comments inside `review-plan.json`.**~~ **Decided 2026-11-01:** kept in the plan, as asked (the determinism check leaves them out, and each run carries them over); editing, deleting and "Clear all" in the page as described in M10.
4. ~~**Static page or local server by default.**~~ **Decided 2026-11-01:** static by default, `bowi serve <dir>` or `--serve` to comment (see Decisions above).
5. ~~**Windows.**~~ **Decided 2026-10-31:** with M10.
6. ~~**Order.**~~ **Decided 2026-10-31:** M9–M17 as in the table.

## Clarifications to the spec (resolve as I go, recorded in §15)

1. **Hunk with several symbols.** A hunk can touch more than one symbol, but must be in exactly one group. Rule: a hunk joins the group of its first (by position) non-file symbol; the others still contribute edges.
2. **Move pairs.** A move is a deleted-side hunk and an added-side hunk. Both get `kind: 'move'` and land in the same "Moved code" group, rendered as one item.
3. **Large-file threshold vs formatting.** A 5,000+ line file that is formatting-only is shown as noise; one with logic changes keeps its logic hunks and summarizes only the rest.
4. **Determinism risks.** Louvain is randomized → seeded RNG. Grammar and shiki versions are pinned since they change output.
