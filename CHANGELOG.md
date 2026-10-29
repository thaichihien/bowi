# Changelog

## Unreleased

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
