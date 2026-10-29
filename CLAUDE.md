# Bowi — instructions for Claude Code

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, then a body that says what changed and why.

- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
- Scope (optional) is the package or area: `core`, `cli`, `sources`, `lang`, `render-html`, `cache`, `fixtures`.
- Summary in the imperative, lower case, no period, about 72 characters at most, e.g. `feat(sources): review GitHub pull requests by URL`.
- The body explains the change for a reader of `git log`: what it does, why, and anything surprising. Wrap it at about 72 characters.
- A milestone that spans packages is one `feat` commit with the milestone named in the body (e.g. "Milestone M6").
- Do not use milestone prefixes such as `M5: …` in the summary.
