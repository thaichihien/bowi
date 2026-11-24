<p align="center">
  <img src="docs/images/logo_bowi.png" alt="Bowi, a bowerbird mascot, presenting review.html: data models, then services, then API endpoints, checked off step by step" width="640">
</p>

<h1 align="center">Bowi</h1>

<p align="center"><strong>Bowi</strong> (short for <em>bowerbird</em>) turns a pull request into a guided review: related changes grouped together,<br>foundations before the code that uses them, noise collapsed, and every group explained with evidence.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/@bowi/cli"><img src="https://img.shields.io/npm/v/@bowi/cli?label=version&color=green" alt="npm version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.12-green" alt="Node 22.12 or newer"></a>
</p>

![A Bowi report: the change grouped into steps on the left (data shape, services, controller, tests, docs); on the right the group "Verify email addresses after sign-up" with an AI summary, hints such as "New route: GET /auth/verify-email", and the current step's diff](docs/images/review.png)

## Why Bowi

A pull request tells a story, but review tools present it differently:

- You see a list of files sorted alphabetically.
- You open the controller before the service it calls.
- You see the tests before the code they test.
- A 2,000-line lockfile sits in the middle of it all.

That work is where reviews go wrong. Reviewers get tired, skim, and approve what they did not really read, or they leave a big pull request waiting because it is hard to start.

Bowi does that sorting for you, so your attention goes to the change itself. It lays the pull request out the way its author would walk you through it: one topic at a time, foundations first, with the noise set aside.

## What Bowi does

Give Bowi a branch, a GitHub pull request or a GitLab merge request, and it:

1. **Sets the noise aside.** Generated files, lockfiles, formatting-only edits and code that was only moved are collapsed, never hidden, so they do not compete with real changes.
2. **Groups related changes.** It follows how the code connects (calls, types, imports, tests, shared names, commits) and puts changes that belong to one idea into one group, even when they are spread across many files.
3. **Orders them for reading.** Inside each group, steps go from foundations to the code that uses them: data shapes, then services, then API, then tests.
4. **Explains each group.** Every group says why its changes belong together, with the evidence. Hints point at things worth a second look, such as a new route or a newly added guard, and unchanged code that calls a changed function is listed so you can check what else might break.
5. **Writes one page.** The result is a single `review.html` that works offline and makes no requests: open it, step through it, mark steps reviewed.

Bowi only reads your code. It never builds, installs or runs anything from the repository it reviews. With `--ai`, it can also have an AI write the titles and a summary (see [AI enrichment](#ai-enrichment-optional));

## Installation

You need:

- **Node 22.12 or newer**
- **git 2.31 or newer**

Install the `bowi` command:

```bash
npm install -g @bowi/cli      # or: pnpm add -g @bowi/cli, bun add -g @bowi/cli
bowi --version
```

Installing runs nothing (Bowi has no install scripts), and Bowi itself connects only to GitHub or GitLab, for pull and merge request URLs, and to the AI provider when you turn AI on.

## Usage

In any git repository, on the branch you want to review:

```bash
bowi --local                                       # this branch against main (or origin/HEAD), uncommitted work included
bowi --local --base develop                        # against another branch
bowi https://github.com/<owner>/<repo>/pull/<n>    # a GitHub pull request; no clone of that repository needed
bowi https://gitlab.com/<group>/<project>/-/merge_requests/<n>  # a GitLab merge request (subgroups and self-managed servers too)
```

Both write `review-plan.json` and `review.html` to `.bowi/<repo>-<pr-or-branch>/` and open the page. Private GitHub repositories need `gh auth login` ([GitHub CLI](https://cli.github.com)) or a `GITHUB_TOKEN` environment variable. Private GitLab projects need `glab auth login` ([GitLab CLI](https://gitlab.com/gitlab-org/cli)) or a `GITLAB_TOKEN` that can read the API and the code (scopes `read_api` and `read_repository`; a fine-grained token also needs Code: Download); Bowi sends `GITLAB_TOKEN` only to gitlab.com, or to the server named in `GITLAB_HOST`, and for any other server uses glab's login there. Public repositories and `--local` need nothing. Fetched code is cached (`bowi cache clear` removes it).

In the report, `j` / `k` move to the next and previous step and `r` marks the current step reviewed.

To try Bowi on a small sample first, build the demo repository (a NestJS backend with an "email verification" branch) from inside a clone of this repository (see [Development](#development)):

```bash
bun run fixture email-verification ~/bowi-demo
cd ~/bowi-demo && bowi --local
```

### Comments

Comment on any line, range or file of the report, as on GitHub; serve the report so the comments are saved into `review-plan.json` (opened as a file, they stay in your browser).

```bash
bowi --local --serve                                     # write the report, then serve it: comments are saved from the start
bowi https://github.com/<owner>/<repo>/pull/<n> --serve  # the same for a GitHub pull request
bowi serve .bowi/<repo>-<pr-or-branch>                   # serve an existing report on this computer and open it; Ctrl+C stops
bowi comments .bowi/<repo>-<pr-or-branch>                # list the comments
bowi comments .bowi/<repo>-<pr-or-branch> --markdown     # print them as Markdown, to paste anywhere
```

`bowi serve` listens on `127.0.0.1` only, with a random token in the link it prints, and writes nothing but the comments of that report. When you run Bowi again into the same folder, comments move with their lines; a comment whose lines changed is kept as outdated, with the code it was written on. `--no-comments` leaves them out of `review.html` (for sharing the page); the plan keeps them.

<details>
<summary><strong>Sending comments to GitHub or GitLab</strong></summary>

When the report is of a pull request, **Post to GitHub** in the served page sends your comments to it, under your own login. A dialog first shows where they go and as whom, and you can leave any comment out. Nothing is ever sent without this step, and Bowi contacts GitHub only when you press the button.

- **Pending review** (the default) is a draft on GitHub that only you can see. It is not public until you submit it on GitHub: **Open on GitHub**, at the top of the report, takes you to the pull request's files, and on GitHub you can also approve or request changes.
- **Post now** makes the comments public right away.

From the terminal:

```bash
bowi comments push .bowi/<repo>-<pr>            # lists what goes where, then asks
bowi comments push .bowi/<repo>-<pr> --yes       # no question; stops if the pull request has new commits
bowi comments push .bowi/<repo>-<pr> --now       # post at once, public
bowi comments push .bowi/<repo>-<pr> --outdated  # also send outdated comments, on their files
```

Posting needs a GitHub login that can write to the pull request: `gh auth login` ([GitHub CLI](https://cli.github.com)), or a `GITHUB_TOKEN` with "Pull requests: write" (the `repo` scope for a classic token). The token stays on your computer, in the local server. In the dialog, **Use another token** lets you paste a different token (and give it a name), even when you are logged in with `gh`; Bowi keeps it in memory until `bowi serve` stops and never saves it.

Bowi only sends. What you sent is read-only in the report, and you change it on GitHub; Bowi never changes or removes anything there, and it does not read comments back. So after you submit a pending review on GitHub, press **I submitted it** in the report to have its comments marked as posted.

A merge request's report has **Post to GitLab** instead, and `bowi comments push` works the same way. A pending review is your draft comments on the merge request, which GitLab shows only to you until you submit the review there (**Open on GitLab** takes you to its changes); **Post now** publishes them together. Posting needs `glab auth login` or a `GITLAB_TOKEN` with the `api` scope, found as for reading; **Use another token** takes a GitLab token too.

</details>

### Reviewing with Claude Code or Codex

Bowi ships a skill that teaches Claude Code and Codex to use it: ask your agent "review https://github.com/owner/repo/pull/42" or "what does this branch change?" and it runs Bowi, reads the plan step by step and walks you through the change in Bowi's order, with its hints and the unchanged code that uses what changed. It offers to open the report; it never posts anything to the pull request.

Copy the skill from the installed package once:

```bash
SKILL="$(npm root -g)/@bowi/cli/skills/bowi"
cp -R "$SKILL" ~/.claude/skills/      # Claude Code (or .claude/skills/ in one repository)
cp -R "$SKILL" ~/.agents/skills/      # Codex (or .agents/skills/ in one repository)
```

Create the folder first if it does not exist (`mkdir -p ~/.claude/skills ~/.agents/skills`). The agent runs `bowi` if it is installed, else `npx --yes @bowi/cli`.

### AI enrichment (optional)

With `--ai`, Bowi asks an AI model to name each group of code changes, explain in 1–3 sentences what it does, and write an overview of the whole change (shown in the Description tab). Everything the AI wrote is marked "AI" in the report, together with the model that wrote it. AI is off by default; without it, Bowi writes its own titles and descriptions.

What is sent: for each group, its changed lines with a few lines around them, the functions and classes they touch and why Bowi grouped them; and the pull request's title, description and commit messages (first lines only). Never sent: generated files, formatting-only changes, moved code or whole files. Bowi checks every answer against the expected format before using it and caches it, so running again on the same changes makes no new calls. If a call fails or times out, that group keeps Bowi's own title.

The AI is reached through a provider, chosen with `ai.provider` in the config:

| Provider            | What it uses                                                                                                                         | Default model        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `claude-code`       | Your local [Claude Code](https://claude.com/claude-code) and its login (no API key for Bowi)                                         | Claude Code's own    |
| `codex`             | Your local [Codex CLI](https://github.com/openai/codex) and its login, which can be a ChatGPT plan (no API key)                      | Codex's own          |
| `anthropic`         | The Anthropic API with your `ANTHROPIC_API_KEY`                                                                                      | `claude-opus-5-5`    |
| `openai`            | The OpenAI API with your `OPENAI_API_KEY`                                                                                            | `gpt-5.6-sol`        |
| `openai-compatible` | Any server that speaks OpenAI's Chat Completions API (Ollama, LM Studio, vLLM, a gateway), with an optional key in `BOWI_AI_API_KEY` | none: set `ai.model` |

Keys are read only from environment variables, never from a config file. With `claude-code` and `codex`, the provider's own program sends the code; with the three API providers, Bowi connects to the endpoint itself, and the line it prints before the analysis names it: "AI is on: group diffs … go to claude-opus-5-5 at api.anthropic.com, with your ANTHROPIC_API_KEY". With the API providers, the progress line also shows the tokens used.

<details>
<summary><strong>Set up Claude Code</strong></summary>

1. Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash` (or `npm install -g @anthropic-ai/claude-code`; see the [setup guide](https://docs.claude.com/en/docs/claude-code/setup)). On Windows, use the native installer in PowerShell, `irm https://claude.ai/install.ps1 | iex`: Bowi cannot run the npm package's `claude.cmd` there.
2. Run `claude` once in a terminal and log in (a Claude subscription or an Anthropic Console account), then quit it. `claude --version` should work in the terminal you run Bowi from.
3. Run Bowi with `--ai`:

```bash
bowi --local --ai
```

To pick the model and effort, or to turn AI on without `--ai`, put an `ai` section in your config file:

```json
{
  "ai": { "enabled": true, "provider": "claude-code", "model": "sonnet", "effort": "low" }
}
```

- `model` is a Claude Code model name or alias (`sonnet`, `opus`, `haiku`; empty: Claude Code's default).
- `effort` is `low`, `medium`, `high`, `xhigh` or `max` (empty: Claude Code's default); lower is faster.
- For `--local`, the file can be the repository's `.bowi.json`. For a pull request, the repository's own `.bowi.json` cannot turn AI on (otherwise whoever opened the pull request could make Bowi send code using your account), so keep your settings in a file of your own and pass it: `bowi <pr-url> --config ~/bowi.json`. All AI keys are listed under [Configuration](#configuration).

Bowi runs Claude Code locked down: in an empty temporary folder, with no tools and no MCP servers, and without your CLAUDE.md, hooks or plugins. Your own Claude Code setup does not see Bowi's requests and cannot change the answers. Calls use your Claude Code login and count toward its usage limits.

</details>

<details>
<summary><strong>Set up Codex (ChatGPT plans)</strong></summary>

1. Install Codex: `npm install -g @openai/codex` (see the [Codex docs](https://developers.openai.com/codex)). On Windows Bowi needs a native `codex.exe` on PATH; it cannot run the npm package's `codex.cmd`.
2. Run `codex login` once (a ChatGPT plan or an OpenAI API key).
3. Use your own config file with `"ai": { "enabled": true, "provider": "codex" }` (`model` and `effort` are optional), and run `bowi --local --config ~/bowi.json`.

Bowi runs Codex locked down: in an empty temporary folder with a read-only sandbox, the shell tool, web search and image viewing turned off, without your `config.toml` (and so without your MCP servers), and with no session saved. Calls use your Codex login and count toward its usage limits.

</details>

<details>
<summary><strong>Set up an API key (Anthropic, OpenAI)</strong></summary>

1. Create a key in the [Claude Console](https://platform.claude.com/settings/keys) or on the [OpenAI platform](https://platform.openai.com/api-keys), and set it in the environment you run Bowi from: `export ANTHROPIC_API_KEY=…` or `export OPENAI_API_KEY=…`.
2. Use your own config file with `"ai": { "enabled": true, "provider": "anthropic" }` (or `"openai"`); `model` and `effort` are optional.

Calls are billed to your API account. Bowi asks for the answer's format with the API's structured output and uses no tools. With `anthropic`, a request the model declines on the models that support it is answered by the fallback model Anthropic recommends.

</details>

<details>
<summary><strong>Set up a local model or another server (OpenAI-compatible)</strong></summary>

Name the server and the model in your own config file, passed with `--config`:

```json
{
  "ai": {
    "enabled": true,
    "provider": "openai-compatible",
    "baseUrl": "http://localhost:11434/v1",
    "model": "qwen3-coder"
  }
}
```

`baseUrl` is the server's address up to `/v1` (Ollama: `http://localhost:11434/v1`, LM Studio: `http://localhost:1234/v1`). It is read only from a file you pass with `--config`: a repository's own `.bowi.json` cannot pick where code is sent. If the server needs a key, set `BOWI_AI_API_KEY`; Bowi never sends your `OPENAI_API_KEY` to another server. The model must support JSON-schema output (`response_format`). With a local model, the code never leaves your machine.

</details>

## What Bowi understands

Supported: **TypeScript and JavaScript**, **Python**, **Go**, **Java**, **Kotlin** and **C#** projects, with framework support for NestJS, Express, Koa, Fastify, Hono, tRPC, React, Next.js, React Router, Angular, Vue, Nuxt, Svelte, SvelteKit, SolidJS and Astro, and for the TypeORM, Sequelize, Mongoose and Drizzle database libraries; Spring Boot for Java and Kotlin; ASP.NET Core with EF Core for C#; Django, FastAPI and Flask for Python; and net/http, Gin, Echo, chi, gorilla/mux and Fiber for Go. Projects without one of these frameworks (libraries) get everything except framework-specific layers, links and hints. Files in other languages are still shown, grouped and never dropped, but as plain text.

For the details (languages, frameworks and layers) see [What Bowi understands](docs/what-bowi-understands.md).

## Configuration

Bowi reads `.bowi.json` from the repository root (for a pull request: the file as it is on the base branch, so a PR cannot change how it is presented), or the file given with `--config <path>`. Every key is optional; unknown keys are reported and ignored.

```json
{
  "base": "main",
  "generated": ["src/graphql/generated/**", "**/*.pb.ts"],
  "layers": { "schema": ["db/migrations/**"], "api": ["src/**/routes/**"] },
  "grouping": { "edgeThreshold": 0.5, "moveSimilarity": 0.8, "maxGroupShare": 0.4 },
  "outsideRefs": { "maxPerSymbol": 5 },
  "order": "dependency",
  "ai": { "enabled": false, "provider": "claude-code", "model": "sonnet", "effort": "low" }
}
```

| Key                        | Meaning                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`                     | Base branch for `--local` (default `origin/HEAD`, else `main`, else `master`). `--base` wins                                                            |
| `generated`                | Extra globs for generated files, shown collapsed as noise                                                                                               |
| `layers`                   | Globs per layer (`schema`, `data`, `util`, `domain`, `service`, `api`, `ui`, `config`, `test`, `docs`), checked before framework plugins and path rules |
| `grouping.edgeThreshold`   | Minimum link weight (0–1) that puts two changes in one group                                                                                            |
| `grouping.moveSimilarity`  | How similar (0–1) moved code must stay to count as a move                                                                                               |
| `grouping.maxGroupShare`   | Share of all changes (0–1] above which a large group is split                                                                                           |
| `outsideRefs.maxPerSymbol` | Unchanged callers listed per changed symbol (0–50); `0` turns the search off                                                                            |
| `order`                    | Reading order the report opens with: `dependency` or `tests-first`. `--order` wins                                                                      |
| `ai.enabled`               | AI enrichment (see above). `--ai` / `--no-ai` win. Ignored in a pull request's own `.bowi.json`: only you can turn it on                                |
| `ai.provider`              | `claude-code` (default), `codex`, `anthropic`, `openai` or `openai-compatible` (see above). Ignored in a pull request's own `.bowi.json`                |
| `ai.model`                 | Model for the provider, e.g. `sonnet` for Claude Code (empty: the provider's default; required for `openai-compatible`)                                 |
| `ai.baseUrl`               | `openai-compatible` only: the server's address up to `/v1`. Read only from your own file (`--config`), never from a repository's `.bowi.json`           |
| `ai.effort`                | `low`, `medium`, `high`, `xhigh` or `max` (empty: the provider's default)                                                                               |
| `ai.concurrency`           | Calls to the AI at once (1–10, default 3)                                                                                                               |
| `ai.timeoutSeconds`        | Time per call before that group keeps Bowi's own title (default 120)                                                                                    |

### Command-line options

Options on the command line win over `.bowi.json`. `bowi <command> --help` prints the same list.

`bowi <pull request URL>` or `bowi --local`: write the report.

| Option              | What it does                                                                            |
| ------------------- | --------------------------------------------------------------------------------------- |
| `--local`           | Review the current repository: the merge base with `--base` against the working tree    |
| `--base <branch>`   | Base branch for `--local` (default `origin/HEAD`, else `main`, else `master`)           |
| `--no-untracked`    | With `--local`, leave out untracked files                                               |
| `--out <dir>`       | Output folder (default `./.bowi/<repo>-<pr-or-branch>/`)                                |
| `--json-only`       | Write only `review-plan.json`, not `review.html`                                        |
| `--no-open`         | Do not open `review.html` in the browser                                                |
| `--serve`           | After writing the report, serve it so comments are saved (Ctrl+C stops)                 |
| `--no-comments`     | Leave the comments out of `review.html`, e.g. for sharing the page; the plan keeps them |
| `--config <path>`   | Config file (default `.bowi.json` in the repository, if present)                        |
| `--order <order>`   | Reading order the report opens with: `dependency` (default) or `tests-first`            |
| `--ai`              | AI titles, intents and an overview (sends group diffs to the provider of `ai.provider`) |
| `--no-ai`           | No AI enrichment, even when the config file turns it on                                 |
| `--cache-dir <dir>` | Cache folder (default: the system cache folder, e.g. `~/Library/Caches/bowi` on macOS)  |
| `-q`, `--quiet`     | Print nothing but errors                                                                |
| `-v`, `--verbose`   | Print more detail                                                                       |
| `-V`, `--version`   | Print the version                                                                       |

Other commands:

| Command                    | Option              | What it does                                                           |
| -------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `bowi serve <dir>`         |                     | Serve a report on this computer so comments written in it are saved    |
|                            | `--no-open`         | Do not open the page in the browser                                    |
|                            | `-q`, `--quiet`     | Print nothing but errors                                               |
| `bowi comments <dir>`      |                     | List the comments written in a report                                  |
|                            | `--markdown`        | Print them as Markdown, ready to paste                                 |
| `bowi comments push <dir>` |                     | Send the comments to the report's pull request; asks first             |
|                            | `--yes`             | Do not ask; stops if the pull request has new commits since the report |
|                            | `--now`             | Post at once, public, instead of as a pending review                   |
|                            | `--outdated`        | Also send outdated comments, on their files with the old lines quoted  |
| `bowi cache clear`         |                     | Delete everything Bowi has cached                                      |
|                            | `--cache-dir <dir>` | Cache folder to clear                                                  |

## FAQ

<details>
<summary><strong>Does Bowi review the code for me?</strong></summary>

No. Bowi does not hunt for bugs or write review comments. It answers a different question: in what order should a person read this change? Your judgment stays where it belongs, and you get a clear place to start and a path through the change.

</details>

<details>
<summary><strong>How does Bowi decide what belongs together? Is it guessing?</strong></summary>

No guessing. Groups come from how the code actually connects (calls, types, imports, tests, commits), not from a model's impression. Every group shows the links that hold it together, every change appears in exactly one step, and the same input always gives the same report.

</details>

<details>
<summary><strong>How do I know the grouping is any good?</strong></summary>

It is measured. A benchmark squashes real runs of clean commits into synthetic pull requests and checks how well Bowi recovers the original commits, so every change to the engine is judged by numbers, not by feel.

</details>

<details>
<summary><strong>Will I miss something because it was marked as noise?</strong></summary>

No. Noise is collapsed, never hidden. Moved code is recognized even when it was edited during the move, and the edited lines stay in the review. Formatting-only edits are found by comparing code structure, not text, and lockfiles get a short summary of what changed.

</details>

<details>
<summary><strong>Do I need AI or an account?</strong></summary>

No. Everything above runs locally, with no AI and no sign-up. AI is an opt-in extra that sees only the changed code that matters, never noise or whole files, and a pull request cannot turn it on. The report is one offline file you can keep, share or archive.

</details>

<details>
<summary><strong>Does my code leave my machine?</strong></summary>

Only when you ask for it: Bowi fetches a pull request from GitHub, or a merge request from GitLab, when you give it a URL, and sends changed code to the AI provider when you turn AI on. It never builds, installs or runs anything from the repository it reviews.

</details>

<details>
<summary><strong>What does it cost?</strong></summary>

Nothing. Bowi is open source under the MIT license, with no per-seat price and no service to sign up for.

</details>

## Development

Running from a clone needs **Node 22.18 or newer**, which runs the TypeScript sources directly (on 22.12–22.17, add `--experimental-strip-types` after `node`), and **Bun** (`curl -fsSL https://bun.sh/install | bash`, `brew install oven-sh/bun/bun`, or on Windows `npm install -g bun@1.4.4`).

```bash
git clone https://github.com/thaichihien/bowi.git
cd bowi
bun install
bun run build:ui       # builds the report page template; Bowi cannot write review.html without it
node packages/cli/src/bin.ts --help
```

To use the clone as your `bowi` command, add an alias inside the clone (use `~/.bashrc` for bash): `echo "alias bowi='node $PWD/packages/cli/src/bin.ts'" >> ~/.zshrc`. Update it with `git pull && bun install && bun run build:ui`.

```bash
bun run check          # typecheck, lint, format check, tests
bun run fixture email-verification /tmp/ev   # build a fixture repo to play with
```

| Script                                      | What it does                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`                              | vitest                                                                                                                                             |
| `bun run typecheck`                         | tsc over sources, tests and fixtures                                                                                                               |
| `bun run lint` / `bun run format`           | ESLint / Prettier                                                                                                                                  |
| `bun run build`                             | compile every package to `dist/`                                                                                                                   |
| `bun run show-plan <plan-or-dir> [hunk-id]` | print a `review-plan.json` readably (dev tool)                                                                                                     |
| `BOWI_REPORT=<review.html> bun run dev:ui`  | the report page with hot reload, for working on its look: edits to `packages/render-html/ui/` show at once; the plan comes from an existing report |
| `bun run bench`                             | grouping benchmark: Bowi vs folder grouping on real commits; `bun run bench explain <case>` details one case                                       |
| `bun run build:package`                     | the npm package `@bowi/cli` in `build/npm/`: every `@bowi/*` package bundled, grammars, queries and the page template                              |
| `bun run smoke`                             | builds the package, installs it with npm into an empty folder and checks that it produces the same plan as the sources                             |

## License

MIT
