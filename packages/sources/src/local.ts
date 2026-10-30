/**
 * Local source (CLI-2): the merge base of a base branch vs the working tree.
 *
 * Input: a directory inside a git repository and options. Output: a Snapshot whose "new" side is
 * the working tree, including staged, unstaged and (by default) untracked, not-ignored files.
 *
 * Untracked files are made visible to `git diff` with `git add --intent-to-add` on a temporary
 * copy of the index (GIT_INDEX_FILE), so the user's real index is never modified.
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

  const { diff, uncommitted } = await diffWorkingTree(root, mergeBaseSha, options);

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

  return {
    meta,
    readDiff: async () => diff,
    readFile: (version: FileVersion, path: string) =>
      version === 'old' ? readBlob(root, mergeBaseSha, path) : readWorkingFile(root, path),
  };
}

async function repoRoot(cwd: string): Promise<string> {
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

/** The diff from the merge base, and whether the working tree (with untracked files) differs from HEAD. */
async function diffWorkingTree(
  root: string,
  mergeBaseSha: string,
  options: LocalSourceOptions,
): Promise<{ diff: string; uncommitted: boolean }> {
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
      const excludes = (await Promise.all((options.excludeUntracked ?? []).map(realPathLoose)))
        .map((p) => relative(root, p))
        .filter((p) => p !== '' && !p.startsWith('..') && !isAbsolute(p))
        .map((p) => `:(exclude,top,literal)${p}`);
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
    return { diff, uncommitted: vsHead.code === 1 };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

async function readWorkingFile(root: string, path: string): Promise<string | null> {
  const normalized = normalize(path);
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`))
    return null;
  const full = join(root, normalized);
  try {
    // A symlink's content in git is its target; never follow it out of the repository.
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) return await readlink(full);
    if (!stat.isFile()) return null;
    return await readFile(full, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
