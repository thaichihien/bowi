# Bowi — Implementation plan (v0.1)

Companion to [requirement.md](requirement.md). Follows the milestone order in §13; nothing from a later milestone is started early.

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

- `ai/provider.ts`: `interface AiProvider { id; describe(): string; enrich(req: GroupEnrichRequest): Promise<unknown> }`. Output always validated with zod by the caller, never trusted (AI-5).
- `ai/providers/claude-code.ts`: spawns `claude -p --output-format json` with the prompt on stdin. Hardening:
  - runs in an **empty temporary cwd**, so the session cannot read the repo beyond what Bowi sends (AI-4 "never whole files");
  - all tools disabled and single turn, so it only answers;
  - user settings / hooks / CLAUDE.md not loaded where the CLI allows it, so output does not depend on the user's personal setup;
  - the exact flags are verified against the installed CLI version at M8 time (currently 2.1.312) and a missing `claude` binary gives a CLI-12 style error ("Install Claude Code or run `claude` once to log in").
- Concurrency limit (default 3), per-group timeout, failure of one call keeps the rule-based result for that group and adds a warning.
- First use prints "Bowi will send group diffs (no noise, no whole files) to Claude via Claude Code" (AI-1). Cache by input hash; `titleSource: 'ai'` (AI-6). Move-hunk suggestions that break the partition are rejected (AI-5).
- Config: `"ai": { "enabled": true, "provider": "claude-code", "model": "" }`; `provider` enum leaves room for `anthropic`, `openai`, `ollama`.

## Clarifications to the spec (resolve as I go, recorded in §15)

1. **Hunk with several symbols.** A hunk can touch more than one symbol, but must be in exactly one group. Rule: a hunk joins the group of its first (by position) non-file symbol; the others still contribute edges.
2. **Move pairs.** A move is a deleted-side hunk and an added-side hunk. Both get `kind: 'move'` and land in the same "Moved code" group, rendered as one item.
3. **Large-file threshold vs formatting.** A 5,000+ line file that is formatting-only is shown as noise; one with logic changes keeps its logic hunks and summarizes only the rest.
4. **Determinism risks.** Louvain is randomized → seeded RNG. Grammar and shiki versions are pinned since they change output.
