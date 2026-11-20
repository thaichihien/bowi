---
name: bowi
description: Review a pull request or a branch with Bowi, which groups related changes, orders them foundations first, collapses noise (lockfiles, formatting, moved code) and explains every group with evidence. Use it whenever the user asks to review a pull request (a GitHub PR URL, "review #42", "review this PR"), asks what a branch or the local changes do ("what does this branch change", "walk me through these changes"), or asks whether a change is safe to merge, even without naming Bowi. Bowi only reads; posting review comments stays the user's action.
---

# Review with Bowi

Bowi turns a pull request into a guided review and writes two files: `review-plan.json` (groups, steps, hunks, hints) and `review.html` (the same review as a page). Run it, read the plan in parts, and walk the user through the change in Bowi's order.

## 1. Run Bowi

Find it, else run the published package (it needs Node 22.12 or later and git 2.31 or later):

```bash
command -v bowi >/dev/null && BOWI=bowi || BOWI="npx --yes @bowi/cli"
```

- A GitHub pull request: `$BOWI https://github.com/<owner>/<repo>/pull/<n> --no-open`. Private repositories need `GITHUB_TOKEN` or a logged-in `gh`.
- The current branch or local changes, from inside the repository: `$BOWI --local --no-open` (against `origin/HEAD`, else `main`, else `master`; `--base <branch>` picks another).
- "Review #42" without a URL: build the URL from the repository's GitHub remote (`git remote get-url origin`).

Always pass `--no-open`; offer to open the page afterwards. Do not pass `--ai`: you are the one explaining the review. Bowi prints the report folder (`Wrote …/review-plan.json`), by default `./.bowi/<repo>-<pr or branch>/` under the current directory. If `.bowi/` is not ignored by git there, say so, or pass `--out <folder>` outside the repository. On an error, Bowi prints the next step to take (exit code 1 usage, 2 source such as a missing token, 3 analysis); follow it or tell the user.

## 2. Read the plan in parts

`review-plan.json` is often hundreds of kilobytes: never read it whole. Start with the overview (replace `PLAN` with the printed path):

```bash
node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const path = new Map(p.files.map((f) => [f.id, f.path]));
const hunk = new Map(p.hunks.map((h) => [h.id, h]));
const s = p.source;
console.log(`${s.repo} ${s.prNumber ? "#" + s.prNumber : s.headRef}: ${s.title ?? ""}`);
console.log(`${p.stats.files} files, +${p.stats.additions} -${p.stats.deletions}, ${p.stats.reviewLines} lines to read carefully`);
for (const w of p.meta.warnings) console.log(`warning: ${w}`);
p.groups.forEach((g, i) => {
  const sure = g.confidence === "high" || g.kind === "noise" || g.kind === "move" ? "" : `, ${g.confidence} confidence`;
  console.log(`\nGroup ${i + 1} [${g.kind}${sure}] ${g.title}`);
  for (const r of g.reasons) console.log(`  why: ${r}`);
  if (g.summary) console.log(`  summary: ${g.summary.replace(/\n/g, "; ")}`);
  for (const h of p.hints.filter((h) => h.target.groupId === g.id)) console.log(`  hint (${h.severity}): ${h.message}`);
  for (const st of g.steps) {
    const files = [...new Set(st.hunkIds.map((id) => path.get(hunk.get(id).fileId)))];
    console.log(`  step ${st.id} ${st.title}: ${files.join(", ")}`);
  }
});
' PLAN
```

Then one step at a time, in that order (`STEP` is a step id such as `g1:service`). Long steps can be cut with `| head -n 300`:

```bash
node -e '
const [plan, stepId] = process.argv.slice(1);
const p = JSON.parse(require("fs").readFileSync(plan, "utf8"));
const step = p.groups.flatMap((g) => g.steps).find((s) => s.id === stepId);
if (!step) throw new Error(`No step ${stepId}`);
const path = new Map(p.files.map((f) => [f.id, f.path]));
const name = new Map(p.symbols.map((s) => [s.id, s.qualifiedName]));
const hunks = step.hunkIds.map((id) => p.hunks.find((h) => h.id === id));
for (const h of hunks) {
  console.log(`\n${path.get(h.fileId)} (${h.id}, ${h.kind}) ${h.header}`);
  if (h.kind === "generated" || h.kind === "format") { console.log(`  ${h.kind}: ${h.lines.length} lines, not shown`); continue; }
  const changed = new Set(h.move?.changedLineIndexes ?? []);
  if (h.move && !h.lines.some((l) => l.kind === "add")) {
    console.log(`  where the code was; its lines that changed on the way, as they were:`);
    for (const i of changed) console.log(`~ ${h.lines[i].text}`);
    continue;
  }
  if (h.move) console.log(`  moved from ${path.get(h.move.fromFileId)}; lines marked ~ changed on the way (${changed.size})`);
  h.lines.forEach((l, i) => console.log(`${changed.has(i) ? "~" : l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`));
}
for (const x of p.hints.filter((x) => x.target.stepId === stepId)) console.log(`\nhint (${x.severity}): ${x.message}`);
const used = new Set(hunks.flatMap((h) => h.symbolIds));
for (const r of p.outsideRefs.filter((r) => used.has(r.symbolId))) console.log(`unchanged code using ${name.get(r.symbolId)}: ${r.path}:${r.line}: ${r.excerpt.trim()}`);
' PLAN STEP
```

## 3. Walk the user through it

- Follow Bowi's order: one section per group, in the plan's order, headed by its number and title ("Group 1: …"), and its steps in order inside it. Do not regroup the change by topic or go file by file: the reviewer will open the report next to your answer, and Bowi's order puts foundations (data shape, helpers, services) before the code that uses them. A short summary may come first.
- For each group, say what it does and why its changes belong together (the `why` lines are the evidence), then go through its steps: what changed, what to look at closely, and anything that looks wrong or risky in the lines you read.
- Mention every hint and every piece of unchanged code that uses a changed symbol: those are the places a change can break something outside the diff.
- Summarize noise without reading it: generated files, formatting-only changes, and code moved unchanged. For moved code, look only at the lines changed on the way.
- If the grouping looks unsure (low or medium confidence, a `mixed` group, "Other changes"), say so instead of inventing a story.
- End with the overall picture: is it ready to merge, what to ask the author, what to test.

## 4. The report and comments

- Offer to open `review.html` (`open` on macOS, `xdg-open` on Linux, `start ""` on Windows). It works offline and keeps the reviewer's progress in the browser.
- To write line comments, the user runs `bowi serve <report folder>` and comments in the page; it keeps running until Ctrl+C, so suggest it rather than running it in the foreground. Read their comments back with `bowi comments <report folder>` (`--markdown` for text to paste).
- Never post anything to the pull request. Sending comments to GitHub is the user's decision: they use "Post to GitHub" in the served page, or run `bowi comments push <report folder>` themselves and confirm there. Never run `bowi comments push` for them and never pass `--yes`.
