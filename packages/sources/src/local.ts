/**
 * Local source (CLI-2): the merge base of a base branch vs the working tree.
 *
 * Input: a directory inside a git repository and options. Output: a Snapshot whose "new" side is
 * the working tree, including staged, unstaged and (by default) untracked, not-ignored files.
 *
 * Untracked files are made visible to `git diff` with `git add --intent-to-add` on a temporary
 * copy of the index (GIT_INDEX_FILE), so the user's real index is never modified.
 *
 * History and search run on the working tree too: blame annotates the working tree file over
 * the commits since the merge base, and grep includes untracked files.
 *
 * Line endings: git diffs a file checked out with CRLF (core.autocrlf, text/eol attributes) as
 * LF, so the working tree text of such a file is read with CRLF turned into LF as well.
 */

import { copyFile, lstat, mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  SourceError,
  UsageError,
  type Commit,
  type FileVersion,
  type Snapshot,
  type SnapshotMeta,
} from '@bowi/core';
import { DIFF_FLAGS, git, gitText, readBlob, resolveCommit } from './git.ts';
import {
  BLAME_CONFIG,
  grepArgs,
  historyArgs,
  parseBlame,
  parseGrep,
  parseHistory,
} from './history.ts';

export interface LocalSourceOptions {
  /** Any directory inside the repository. */
  cwd: string;
  /** Base branch or revision; default `origin/HEAD`, else `main`, else `master`. */
  base?: string;
  /** Include untracked, not-ignored files (default true). */
  includeUntracked?: boolean;
  /** Absolute paths never included as untracked files, e.g. Bowi's own output folder. */
  excludeUntracked?: string[];
}

export async function openLocalSnapshot(options: LocalSourceOptions): Promise<Snapshot> {
  const root = await repoRoot(options.cwd);
  const headSha = await resolveCommit('HEAD', root);
  if (!headSha) {
    throw new SourceError(
      'This repository has no commits yet.',
      'Commit something first, then run bowi --local.',
    );
  }

  const base = await resolveBase(root, options.base);
  const mergeBaseSha = await mergeBase(root, base.sha, headSha, base.ref);
  const headRef =
    (
      await git(['symbolic-ref', '--short', '--quiet', 'HEAD'], { cwd: root, okCodes: [1] })
    ).stdout.trim() || 'HEAD';

  const { diff, uncommitted, crlf } = await diffWorkingTree(root, mergeBaseSha, options);
  const readNew = (path: string) => readWorkingFile(root, path, crlf.has(path));

  const meta: SnapshotMeta = {
    kind: 'local',
    repo: basename(root),
    baseRef: base.ref,
    headRef,
    baseSha: base.sha,
    headSha,
    mergeBaseSha,
    commits: await commitsBetween(root, mergeBaseSha, headSha),
  };
  if (uncommitted) meta.uncommitted = true;
  const outputDirs = await repoRelative(root, options.excludeUntracked ?? []);

  return {
    meta,
    readDiff: async () => diff,
    readFile: (version: FileVersion, path: string) =>
      version === 'old' ? readBlob(root, mergeBaseSha, path) : readNew(path),
    async blame(paths) {
      const out = new Map<string, (string | null)[]>();
      for (const path of paths) {
        if ((await readNew(path)) === null) continue;
        // Exit 128: the file is not in HEAD (untracked or only staged), so it has no history.
        const r = await git(
          [
            ...BLAME_CONFIG,
            'blame',
            '--porcelain',
            '--contents',
            path,
            `${mergeBaseSha}..HEAD`,
            '--',
            path,
          ],
          { cwd: root, okCodes: [128] },
        );
        if (r.code === 0) out.set(path, parseBlame(r.stdout));
      }
      return out;
    },
    async baseHistory(limit) {
      return parseHistory(await gitText(historyArgs(mergeBaseSha, limit), { cwd: root }));
    },
    async grep(words, extensions) {
      if (words.length === 0) return [];
      // Exit 1: nothing found.
      const r = await git(grepArgs(words, extensions, undefined, outputDirs), {
        cwd: root,
        okCodes: [1],
      });
      return parseGrep(r.stdout);
    },
  };
}

/** Top folder of the repository containing `cwd` (SourceError when there is none). */
export async function repoRoot(cwd: string): Promise<string> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd, okCodes: [128] });
  const root = r.stdout.trim();
  if (r.code !== 0 || !root) {
    throw new SourceError(
      `Not inside a git repository: ${cwd}`,
      'Run bowi --local from inside the repository you want to review.',
    );
  }
  return root;
}

async function resolveBase(
  root: string,
  requested?: string,
): Promise<{ ref: string; sha: string }> {
  if (requested) {
    const sha = await resolveCommit(requested, root);
    if (!sha) {
      throw new UsageError(
        `Base "${requested}" is not a branch or commit in this repository.`,
        'Check the name with `git branch -a`.',
      );
    }
    return { ref: requested, sha };
  }

  // origin/HEAD points at the remote's default branch; show its real name, e.g. origin/main.
  const originHead = await git(['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD'], {
    cwd: root,
    okCodes: [1, 128],
  });
  const candidates = [originHead.stdout.trim(), 'main', 'master'].filter(Boolean);
  for (const ref of candidates) {
    const sha = await resolveCommit(ref, root);
    if (sha) return { ref, sha };
  }
  throw new UsageError(
    'Could not find a base branch (tried origin/HEAD, main, master).',
    'Pass the branch to compare against, e.g. `bowi --local --base develop`.',
  );
}

async function mergeBase(
  root: string,
  baseSha: string,
  headSha: string,
  baseRef: string,
): Promise<string> {
  const r = await git(['merge-base', baseSha, headSha], { cwd: root, okCodes: [1] });
  if (r.code !== 0) {
    throw new SourceError(
      `HEAD and ${baseRef} have no common history.`,
      'Pass a base branch that HEAD was created from with --base.',
    );
  }
  return r.stdout.trim();
}

/**
 * The diff from the merge base, whether the working tree (with untracked files) differs from
 * HEAD, and the paths git reads with CRLF turned into LF.
 */
async function diffWorkingTree(
  root: string,
  mergeBaseSha: string,
  options: LocalSourceOptions,
): Promise<{ diff: string; uncommitted: boolean; crlf: Set<string> }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'bowi-index-'));
  try {
    const indexPath = join(tempDir, 'index');
    const realIndex = resolve(
      root,
      await gitText(['rev-parse', '--git-path', 'index'], { cwd: root }),
    );
    await copyFile(realIndex, indexPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    const env = { GIT_INDEX_FILE: indexPath };

    if (options.includeUntracked ?? true) {
      const excludes = (await repoRelative(root, options.excludeUntracked ?? [])).map(
        (p) => `:(exclude,top,literal)${p}`,
      );
      const untracked = await git(
        ['ls-files', '-z', '--others', '--exclude-standard', '--', ':(top)', ...excludes],
        {
          cwd: root,
          env,
        },
      );
      if (untracked.stdout) {
        // Literal pathspecs: an untracked file named `*.ts` must not act as a glob.
        await git(['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          cwd: root,
          env: { ...env, GIT_LITERAL_PATHSPECS: '1' },
          input: untracked.stdout,
        });
      }
    }

    const diff = (await git(['diff', ...DIFF_FLAGS, mergeBaseSha, '--'], { cwd: root, env }))
      .stdout;
    const vsHead = await git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], {
      cwd: root,
      env,
      okCodes: [1],
    });
    return { diff, uncommitted: vsHead.code === 1, crlf: await crlfPaths(root, env) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Working tree files with CRLF that git turns into LF when it reads them (convert.c): always
 * with the `text` or `eol` attribute; with `text=auto`, or no attribute and core.autocrlf
 * true/input, only when the index copy has no CRLF (a file committed with CRLF stays as it is).
 * `env` points at the temporary index, so untracked files (intent-to-add) are listed too.
 */
async function crlfPaths(root: string, env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const out = new Set<string>();
  const listed = (await git(['ls-files', '--eol', '-z'], { cwd: root, env })).stdout;
  if (!/w\/(crlf|mixed)/.test(listed)) return out;
  const autocrlf = (
    await git(['config', '--get', 'core.autocrlf'], { cwd: root, okCodes: [1] })
  ).stdout
    .trim()
    .toLowerCase();
  const auto = ['true', 'yes', 'on', '1', 'input'].includes(autocrlf);
  for (const record of listed.split('\0')) {
    // `i/lf    w/crlf  attr/text=auto eol=lf <TAB>path`
    const m = /^i\/(\S*)\s+w\/(\S+)\s+attr\/(.*?)\s*\t(.*)$/s.exec(record);
    if (!m || (m[2] !== 'crlf' && m[2] !== 'mixed')) continue;
    const [, index, , attr, path] = m as unknown as [string, string, string, string, string];
    const attrs = attr.split(/\s+/);
    if (attrs.includes('-text')) continue;
    const textAuto = attrs.includes('text=auto');
    const explicit = !textAuto && attrs.some((a) => a === 'text' || a.startsWith('eol='));
    const indexHasCrlf = index === 'crlf' || index === 'mixed';
    if (explicit || ((textAuto || auto) && !indexHasCrlf)) out.add(path);
  }
  return out;
}

/**
 * Absolute paths as repository-relative pathspecs with `/` (git on Windows reports the root as
 * `C:/…`, path.relative returns `\`), dropping those outside the repository.
 */
async function repoRelative(root: string, paths: string[]): Promise<string[]> {
  return (await Promise.all(paths.map(realPathLoose)))
    .map((p) => relative(root, p))
    .filter((p) => p !== '' && !p.startsWith('..') && !isAbsolute(p))
    .map((p) => p.split(sep).join('/'));
}

/**
 * Real path of `p`, also for paths that do not exist yet (resolves the nearest existing parent).
 * git reports the repository root as a real path, so symlinked prefixes such as macOS
 * `/var` → `/private/var` must be resolved before comparing.
 */
async function realPathLoose(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(await realPathLoose(parent), basename(p));
  }
}

const FIELD = '\x1f';
const RECORD = '\x1e';

async function commitsBetween(root: string, from: string, to: string): Promise<Commit[]> {
  const format = ['%H', '%s', '%an', '%aI', '%cn', '%cI', '%b'].join('%x1f') + '%x1e';
  const out = await gitText(
    ['log', '--no-show-signature', '--reverse', `--format=${format}`, `${from}..${to}`],
    { cwd: root },
  );
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = '', an = '', aI = '', cn = '', cI = '', body = ''] =
        record.split(FIELD);
      const commit: Commit = {
        sha,
        subject,
        author: { name: an },
        authoredAt: aI,
        committedAt: cI,
      };
      if (body.trim()) commit.body = body.trim();
      if (cn !== an) commit.committer = { name: cn };
      return commit;
    });
}

async function readWorkingFile(
  root: string,
  path: string,
  crlfToLf: boolean,
): Promise<string | null> {
  const normalized = normalize(path);
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`))
    return null;
  const full = join(root, normalized);
  try {
    // A symlink's content in git is its target; never follow it out of the repository.
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) return await readlink(full);
    if (!stat.isFile()) return null;
    const text = await readFile(full, 'utf8');
    return crlfToLf ? text.replace(/\r\n/g, '\n') : text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
