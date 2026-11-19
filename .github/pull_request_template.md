## 📝 Summary

<!-- What this pull request changes and why, in a few sentences. Name the milestone if it belongs to one (e.g. M11). -->

## 🏷️ Type of changes

- [ ] ✨ `feat`: a new feature
- [ ] 🐛 `fix`: a bug fix
- [ ] ⚡ `perf`: faster or lighter, same output
- [ ] ♻️ `refactor`: code changes with no change in behavior
- [ ] 🧪 `test`: tests only
- [ ] 📚 `docs`: documentation only
- [ ] 📦 `build`: packaging, dependencies, the page build
- [ ] 👷 `ci`: GitHub Actions
- [ ] 🔧 `chore`: anything else

## 🔗 Related issues

<!-- "Closes #12" closes the issue when this is merged; "Refs #12" only links it. Write "None" if there are none. -->

## 💬 Note

<!-- Anything a reviewer should know: decisions, trade-offs, what is left for later, commands to try it and what their output shows, screenshots before and after for changes to the report page. -->

## ✅ Checklist

<!-- Guards for every change, wherever it comes from. Tick what holds; say in the Note why an item does not apply. -->

- [ ] `bun run check` passes (typecheck, lint, format, tests)
- [ ] I ran Bowi with this change on a real repository or pull request, and the report looks right
- [ ] Tests cover the new or fixed behavior
- [ ] Bowi still never runs code from the repository it reviews: no installs, scripts, builds or git hooks
- [ ] No new network requests, and `review.html` still loads nothing from outside
- [ ] The same input still gives the same `review-plan.json`
- [ ] Nothing assumes one operating system: paths go through `node:path`, nothing runs through a shell
- [ ] New dependencies, if any, are pinned to an exact version and support Node 22.12
- [ ] No tokens, secrets or private code in the change, its tests or its screenshots
- [ ] README or CHANGELOG updated, if users will notice the change
