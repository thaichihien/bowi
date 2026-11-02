import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearCache, defaultCacheDir, repoCacheDir, withLock } from '../src/index.ts';

const roots: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('cache locations', () => {
  it('follows XDG_CACHE_HOME and keeps repository folders safe', () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/x' })).toBe(join('/x', 'bowi'));
    expect(repoCacheDir('/c', 'github.com', 'acme', '../evil')).toBe(
      join('/c', 'repos', 'github.com', 'acme', '.._evil.git'),
    );
  });

  it('uses the usual cache folder of each system', () => {
    expect(defaultCacheDir({}, 'darwin')).toBe(join(homedir(), 'Library', 'Caches', 'bowi'));
    expect(defaultCacheDir({}, 'linux')).toBe(join(homedir(), '.cache', 'bowi'));
    expect(defaultCacheDir({ LOCALAPPDATA: join('/l') }, 'win32')).toBe(join('/l', 'bowi'));
    expect(defaultCacheDir({}, 'win32')).toBe(join(homedir(), 'AppData', 'Local', 'bowi'));
  });
});

describe('withLock', () => {
  it('runs holders one at a time and releases the lock', async () => {
    const dir = join(tempDir('bowi-lock-'), 'repo.git');
    const events: string[] = [];
    const holder = (name: string) =>
      withLock(dir, async () => {
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 50));
        events.push(`${name}:end`);
      });
    await Promise.all([holder('a'), holder('b')]);
    // Either may get the lock first; the other must wait until it is released.
    const first = events[0]!.split(':')[0]!;
    const second = first === 'a' ? 'b' : 'a';
    expect(events).toEqual([`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  it('takes over a lock abandoned for more than 10 minutes', async () => {
    const dir = join(tempDir('bowi-lock-'), 'repo.git');
    mkdirSync(`${dir}.lock`);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(`${dir}.lock`, old, old);
    expect(await withLock(dir, async () => 'ran')).toBe('ran');
  });

  it('clears the whole cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bowi-cache-'));
    await clearCache(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
