/**
 * Bowi CLI (requirement.md §7.1).
 *
 * `run(argv, io)` does everything and returns the exit code (CLI-11), so it can be tested
 * in-process; bin.ts only wires it to the real process.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { checkClaudeCode, claudeCode, createEnricher } from '@bowi/ai';
import { clearCache, defaultCacheDir } from '@bowi/cache';
import {
  AiError,
  analyze,
  BowiError,
  createStageContext,
  DEFAULT_CONFIG,
  parseConfig,
  UsageError,
  type AiEnricher,
  type BowiConfig,
  type LoadedConfig,
  type ReadingOrder,
  type ReviewPlan,
  type Snapshot,
} from '@bowi/core';
import { defaultPlugins } from '@bowi/plugins';
import { renderHtml } from '@bowi/render-html';
import { defaultRules } from '@bowi/rules';
import {
  fetchPullRequest,
  openGithubSnapshot,
  openLocalSnapshot,
  parsePullRequestUrl,
  repoRoot,
  resolveToken,
  type GithubOptions,
} from '@bowi/sources';
import { createProgress, type Progress } from './progress.ts';

export const VERSION = '0.0.0';

export interface Writable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface CliIo {
  cwd: string;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Opens the report in a browser (CLI-5). Default: the system opener. */
  openFile?: (path: string) => void;
  /** For tests: GitHub API access and where to clone from. */
  github?: GithubOptions & { remoteUrl?: string };
  /** For tests: the Claude Code executable, or a whole enricher instead of Claude Code. */
  ai?: { command?: string; enricher?: AiEnricher };
}

interface CliOptions {
  local?: boolean;
  base?: string;
  out?: string;
  jsonOnly?: boolean;
  untracked: boolean;
  open: boolean;
  config?: string;
  order?: ReadingOrder;
  ai?: boolean;
  cacheDir?: string;
  quiet?: boolean;
  verbose?: boolean;
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  if (argv[0] === 'cache') return runCache(argv.slice(1), io);

  const program = new Command('bowi')
    .description('Turn a pull request into a guided, grouped review.')
    .usage('<github-pr-url> | --local [options]\n       bowi cache clear')
    .argument('[pr-url]', 'GitHub pull request URL, e.g. https://github.com/owner/repo/pull/123')
    .option('--local', 'review the current repository: merge base of --base vs the working tree')
    .option(
      '--base <branch>',
      'base branch for --local (default: origin/HEAD, else main, else master)',
    )
    .option('--out <dir>', 'output folder (default: ./.bowi/<repo>-<pr-or-branch>/)')
    .option('--json-only', 'write only review-plan.json, not review.html')
    .option('--no-untracked', 'with --local, leave out untracked files')
    .option('--no-open', 'do not open review.html in the browser')
    .option('--config <path>', 'config file (default: .bowi.json in the repository, if present)')
    .addOption(
      new Option(
        '--order <order>',
        'reading order the report opens with (default: dependency)',
      ).choices(['dependency', 'tests-first']),
    )
    .option(
      '--ai',
      'AI titles, intents and an overview through Claude Code (sends group diffs to Claude)',
    )
    .option('--no-ai', 'no AI enrichment, even when the config file turns it on')
    .option('--cache-dir <dir>', `cache folder (default: ${defaultCacheDir(io.env)})`)
    .option('-q, --quiet', 'print nothing but errors')
    .option('-v, --verbose', 'print more detail')
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 1;
    throw e;
  }

  const opts = program.opts<CliOptions>();
  const progress = createProgress(io.stderr, { quiet: !!opts.quiet, verbose: !!opts.verbose });
  try {
    const target = program.args[0];
    // --local reads its config first: it may name the base branch.
    let loaded = !target && opts.local ? await localConfig(opts, io) : undefined;
    const snapshot = await openSnapshot(target, opts, loaded?.config.base, io, progress);
    loaded ??= await prConfig(opts, io, snapshot);
    for (const w of loaded.warnings) progress.warn(w);
    const config = opts.order ? { ...loaded.config, order: opts.order } : loaded.config;
    const enricher = await aiEnricher(config, opts, io);
    if (enricher) {
      // AI-1: say who receives code before anything is sent.
      progress.note(
        `AI is on: group diffs (no noise, no whole files) and the PR title and description go to ${enricher.describe()}.`,
      );
    }
    const plan = await analyze(
      snapshot,
      createStageContext(config, {
        ...(io.now && { now: io.now }),
        logger: progress.logger,
      }),
      {
        toolVersion: VERSION,
        onStageStart: progress.stageStart,
        onStage: progress.stage,
        plugins: defaultPlugins,
        hintRules: defaultRules,
        ...(enricher && {
          ai: {
            enricher,
            concurrency: config.ai.concurrency,
            timeoutMs: config.ai.timeoutSeconds * 1000,
          },
        }),
      },
    );
    for (const w of plan.meta.warnings) progress.warn(w);

    const outDir = outDirFor(plan, opts, io.cwd);
    await mkdir(outDir, { recursive: true });
    const planPath = join(outDir, 'review-plan.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n');
    if (opts.jsonOnly) {
      progress.done(`Wrote ${planPath}`);
      return 0;
    }
    // Highlighting is added to the page's copy of the plan only; review-plan.json stays lean.
    const html = await progress.time(
      'Rendered',
      () => renderHtml(plan, { readFile: (version, path) => snapshot.readFile(version, path) }),
      (page) => `review.html, ${formatSize(Buffer.byteLength(page))}`,
    );
    const htmlPath = join(outDir, 'review.html');
    await writeFile(htmlPath, html);
    progress.done(`Wrote ${htmlPath}`);
    // CLI-5: only for a person at a terminal, never for scripts or pipes.
    if (opts.open && io.stdout.isTTY) (io.openFile ?? openWithSystem)(htmlPath);
    return 0;
  } catch (e) {
    progress.fail();
    if (e instanceof BowiError) {
      io.stderr.write(`error: ${e.message}\n`);
      if (e.hint) io.stderr.write(`  ${e.hint}\n`);
      return e.exitCode;
    }
    io.stderr.write(`error: unexpected failure: ${e instanceof Error ? e.message : String(e)}\n`);
    if (opts.verbose && e instanceof Error && e.stack) io.stderr.write(`${e.stack}\n`);
    return 3;
  }
}

/** `bowi cache clear [--cache-dir <dir>]` (CLI-10). */
async function runCache(argv: string[], io: CliIo): Promise<number> {
  const program = new Command('bowi cache')
    .description('Manage the cache of fetched repositories.')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    });
  program
    .command('clear')
    .description('delete everything Bowi has cached')
    .option('--cache-dir <dir>', 'cache folder')
    .action(async (o: { cacheDir?: string }) => {
      const dir = o.cacheDir ? resolve(io.cwd, o.cacheDir) : defaultCacheDir(io.env);
      await clearCache(dir);
      io.stderr.write(`Cleared ${dir}\n`);
    });
  try {
    await program.parseAsync(argv, { from: 'user' });
    if (argv.length === 0) program.help();
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 1;
    throw e;
  }
}

/**
 * The AI enricher when AI is on (`--ai`, or `ai.enabled` in the config, unless `--no-ai`).
 * Checks first that Claude Code is installed, so a run does not fail after the analysis.
 */
async function aiEnricher(
  config: BowiConfig,
  opts: CliOptions,
  io: CliIo,
): Promise<AiEnricher | undefined> {
  if (!(opts.ai ?? config.ai.enabled)) return undefined;
  if (io.ai?.enricher) return io.ai.enricher;
  if (config.ai.provider !== 'claude-code') {
    throw new UsageError(
      `The AI provider "${config.ai.provider}" is not available yet.`,
      'Set "ai": { "provider": "claude-code" } in the config file, or run without --ai.',
    );
  }
  const options = {
    model: config.ai.model,
    effort: config.ai.effort,
    ...(io.ai?.command && { command: io.ai.command }),
    ...(io.env && { env: io.env }),
  };
  try {
    await checkClaudeCode(options);
  } catch (e) {
    if (e instanceof AiError) throw new UsageError(e.message, e.hint);
    throw e;
  }
  return createEnricher({
    transport: claudeCode(options),
    cacheDir: join(cacheDirOf(opts, io), 'ai'),
  });
}

function cacheDirOf(opts: CliOptions, io: CliIo): string {
  return opts.cacheDir ? resolve(io.cwd, opts.cacheDir) : defaultCacheDir(io.env);
}

/**
 * Config for --local (CLI-9): `--config <path>`, else `.bowi.json` at the repository root (the
 * working tree, like the code being reviewed), else the defaults.
 */
async function localConfig(opts: CliOptions, io: CliIo): Promise<LoadedConfig> {
  if (opts.config) return configFile(resolve(io.cwd, opts.config), opts.config);
  const root = await repoRoot(io.cwd);
  const text = await readFile(join(root, '.bowi.json'), 'utf8').catch(() => null);
  return text === null ? { config: DEFAULT_CONFIG, warnings: [] } : parseConfig(text, '.bowi.json');
}

/**
 * Config for a pull request: `--config <path>`, else `.bowi.json` as it is on the base side
 * (merge base). Never the PR's own version: a pull request must not be able to change how it is
 * presented, e.g. mark its own code as generated noise. Its `ai` settings are ignored too: the
 * repository must not turn AI on, or pick the model, on the reviewer's own Claude account.
 */
async function prConfig(opts: CliOptions, io: CliIo, snapshot: Snapshot): Promise<LoadedConfig> {
  if (opts.config) return configFile(resolve(io.cwd, opts.config), opts.config);
  const text = await snapshot.readFile('old', '.bowi.json');
  const loaded =
    text === null ? { config: DEFAULT_CONFIG, warnings: [] } : parseConfig(text, '.bowi.json');
  // The pull request already names its base branch.
  const { base: _ignored, ...config } = loaded.config;
  const warnings = [...loaded.warnings];
  if (JSON.stringify(config.ai) !== JSON.stringify(DEFAULT_CONFIG.ai)) {
    warnings.push(
      '.bowi.json: "ai" settings of the repository are ignored for pull requests (use --ai, or --config with your own file)',
    );
  }
  return { warnings, config: { ...config, ai: DEFAULT_CONFIG.ai } };
}

async function configFile(path: string, label: string): Promise<LoadedConfig> {
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
    throw new UsageError(
      `Cannot read the config file ${label} (${e.code ?? e.message}).`,
      'Check the path given to --config.',
    );
  });
  return parseConfig(text, label);
}

async function openSnapshot(
  target: string | undefined,
  opts: CliOptions,
  configBase: string | undefined,
  io: CliIo,
  progress: Progress,
): Promise<Snapshot> {
  if (target && opts.local) {
    throw new UsageError('Pass either a PR URL or --local, not both.');
  }
  if (!target && !opts.local) {
    throw new UsageError(
      'Nothing to review.',
      'Run `bowi <github-pr-url>` or `bowi --local`. See `bowi --help`.',
    );
  }
  if (target) {
    const ref = parsePullRequestUrl(target);
    if (!ref) {
      throw new UsageError(
        `Not a GitHub pull request URL: ${target}`,
        'Expected https://github.com/<owner>/<repo>/pull/<number>.',
      );
    }
    const token = io.github?.token ?? (await resolveToken(io.env));
    const github: GithubOptions = { ...io.github, ...(token && { token }) };
    const info = await progress.time(
      'Resolved',
      () => fetchPullRequest(ref, github),
      (pr) =>
        `PR #${pr.ref.number} · head ${pr.headSha.slice(0, 7)} · merge base ${pr.mergeBaseSha.slice(0, 7)}`,
      `Asking GitHub about ${ref.owner}/${ref.repo}#${ref.number}`,
    );
    return progress.time(
      'Fetched',
      () =>
        openGithubSnapshot(info, {
          cacheDir: cacheDirOf(opts, io),
          ...(token && { token }),
          ...(io.github?.remoteUrl && { remoteUrl: io.github.remoteUrl }),
        }),
      (s) =>
        s.fromCache
          ? 'both commits already cached'
          : `head and merge base from github.com/${ref.owner}/${ref.repo}`,
      'Fetching code',
    );
  }

  return progress.time(
    'Resolved',
    () =>
      openLocalSnapshot({
        cwd: io.cwd,
        ...((opts.base ?? configBase) !== undefined && { base: opts.base ?? configBase }),
        includeUntracked: opts.untracked,
        excludeUntracked: [
          resolve(io.cwd, '.bowi'),
          ...(opts.out ? [resolve(io.cwd, opts.out)] : []),
        ],
      }),
    (s) => `${s.meta.headRef} vs ${s.meta.baseRef} · merge base ${s.meta.mergeBaseSha.slice(0, 7)}`,
  );
}

function openWithSystem(path: string): void {
  const command =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(command, [path], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // no opener installed: the path is printed anyway
    child.unref();
  } catch {
    // ignore: the report path is already printed
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function outDirFor(plan: ReviewPlan, opts: CliOptions, cwd: string): string {
  if (opts.out) return resolve(cwd, opts.out);
  const s = plan.source;
  // GitHub: "<name>-<pr>" (web-app-be-482); local: "<folder>-<branch>".
  const name =
    s.prNumber !== undefined
      ? `${s.repo.slice(s.repo.indexOf('/') + 1)}-${s.prNumber}`
      : `${s.repo}-${s.headRef}`;
  return resolve(cwd, '.bowi', name.replace(/[^A-Za-z0-9._-]+/g, '-'));
}
