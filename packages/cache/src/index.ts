/**
 * Bowi's on-disk cache (CLI-10, SRC-4): where it lives, per-repository folders, a simple
 * cross-process lock, and clearing it.
 *
 * Default location: $XDG_CACHE_HOME/bowi, else ~/Library/Caches/bowi on macOS, else
 * ~/.cache/bowi. Everything in it can be deleted at any time.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'bowi');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches', 'bowi');
  return join(homedir(), '.cache', 'bowi');
}

/** Folder for one remote repository, e.g. <cache>/repos/github.com/owner/name.git. */
export function repoCacheDir(cacheDir: string, host: string, owner: string, repo: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(cacheDir, 'repos', safe(host), safe(owner), `${safe(repo)}.git`);
}

export async function clearCache(cacheDir: string): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true });
}

const LOCK_STALE_MS = 10 * 60_000;
const LOCK_WAIT_MS = 120_000;

/**
 * Runs `fn` while holding `<dir>.lock`, so two Bowi runs do not fetch into the same cache
 * repository at once. A lock older than 10 minutes is considered abandoned.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${dir}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock, { recursive: false });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(join(lock, '..'), { recursive: true });
        continue;
      }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(
          `Another Bowi run is using ${dir} (lock ${lock}). Try again, or delete the lock if no run is active.`,
          { cause: e },
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
