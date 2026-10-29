# Bowi

**Bowi** (short for _bowerbird_) turns a pull request into a guided review: related changes grouped together, foundations before the code that uses them, noise collapsed, and every group explained with evidence. The result is one self-contained `review.html`.

Status: early development (milestone M0). See [docs/requirement.md](docs/requirement.md) and [docs/plan.md](docs/plan.md).

## Development

Bun is the package manager and script runner. The CLI itself targets **Node ≥ 20**, so code uses only `node:` APIs, never `Bun.*`. Tests run on vitest under Node.

```bash
bun install
bun run check          # typecheck, lint, format check, tests
bun run fixture email-verification /tmp/ev   # build a fixture repo to play with
```

| Script                            | What it does                         |
| --------------------------------- | ------------------------------------ |
| `bun run test`                    | vitest                               |
| `bun run typecheck`               | tsc over sources, tests and fixtures |
| `bun run lint` / `bun run format` | ESLint / Prettier                    |
| `bun run build`                   | compile every package to `dist/`     |

Layout: `packages/*` are the workspace packages from requirement.md §11.3 (`@bowi/core`, `@bowi/sources`, …; the CLI package is `bowi`). `fixtures/` builds deterministic git repos with known PRs; each fixture's source files live in `fixtures/<name>/files/` and are excluded from lint, format and typecheck because they are test data.

## License

MIT
