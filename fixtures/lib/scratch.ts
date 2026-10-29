/**
 * Small throwaway repositories for tests: `main` holds `base`, branch `work` (checked out) applies
 * `head` on top, where `null` deletes a file. Deterministic like buildFixtureRepo.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFixtureRepo } from './git-repo.ts';

export function scratchRepo(
  base: Record<string, string>,
  head: Record<string, string | null>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'bowi-scratch-'));
  const write = (dir: string, files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) continue;
      mkdirSync(dirname(join(root, 'files', dir, path)), { recursive: true });
      writeFileSync(join(root, 'files', dir, path), content);
    }
  };
  write('base', base);
  write('head', head);
  mkdirSync(join(root, 'files', 'head'), { recursive: true });
  const deleted = Object.entries(head)
    .filter(([, c]) => c === null)
    .map(([p]) => p);
  return buildFixtureRepo(
    {
      name: 'scratch',
      filesDir: join(root, 'files'),
      baseBranch: 'main',
      headBranch: 'work',
      base: [{ message: 'base', dir: 'base' }],
      head: [{ message: 'head', dir: 'head', delete: deleted }],
    },
    join(root, 'repo'),
  ).dir;
}
