/**
 * Picks benchmark cases from a repository's history (§12.3 step 1): runs of 3–6 consecutive
 * clean, single-purpose commits on the main branch's first-parent line.
 *
 * A commit qualifies when it has one parent, is not a release, dependency bump, revert or CI
 * change, touches 1–20 files and at least one code file outside tests and docs. Cases never
 * contain a disqualified commit (squashing it in would add a change no commit "owns" cleanly),
 * never overlap, and take the most recent history first. Sizes cycle 3, 4, 5, 6 so the set
 * mixes small and large synthetic PRs.
 */

export interface LogCommit {
  sha: string;
  parents: string[];
  subject: string;
  /** Paths the commit changes (old and new path for a rename). */
  files: string[];
}

export interface BenchCase {
  id: string;
  /** Parent of the first commit: the synthetic PR's base. */
  base: string;
  /** Oldest first; the last one is the synthetic PR's head. */
  commits: { sha: string; subject: string }[];
}

const SKIP_SUBJECT =
  /^(merge\b|revert\b|release\b|bump\b|v?\d+\.\d+\.\d+|(chore|build|fix|ci)\((deps|deps-dev|release)\)|chore: release|ci[:(]|update dependency|\[skip ci\])/i;
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|py|go)$/;
const NOT_APP_CODE = /(^|\/)(docs?|examples?|\.github|benchmarks?)\//;
const MAX_FILES = 20;
const SIZES = [3, 4, 5, 6];

export function qualifies(c: LogCommit): boolean {
  return (
    c.parents.length === 1 &&
    !SKIP_SUBJECT.test(c.subject.trim()) &&
    c.files.length >= 1 &&
    c.files.length <= MAX_FILES &&
    c.files.some((f) => CODE.test(f) && !NOT_APP_CODE.test(f) && !f.endsWith('.d.ts'))
  );
}

/**
 * Cases from a first-parent log (newest first). `prefix` names them: `<repo>-1`, `<repo>-2`, …
 */
export function selectCases(log: LogCommit[], prefix: string, maxCases: number): BenchCase[] {
  const cases: BenchCase[] = [];
  let run: LogCommit[] = []; // consecutive qualifying commits, newest first
  const flush = () => {
    // Cut the run (newest first) into windows of the next sizes; leftovers shorter than 3 go.
    while (cases.length < maxCases) {
      const size = SIZES[cases.length % SIZES.length]!;
      if (run.length < size) break;
      const window = run.slice(0, size).reverse(); // oldest first
      run = run.slice(size);
      cases.push({
        id: `${prefix}-${cases.length + 1}`,
        base: window[0]!.parents[0]!,
        commits: window.map((c) => ({ sha: c.sha, subject: c.subject })),
      });
    }
    run = [];
  };
  for (let i = 0; i < log.length && cases.length < maxCases; i++) {
    const c = log[i]!;
    // The next (older) commit must be this one's parent: a first-parent chain without gaps.
    if (run.length > 0 && run.at(-1)!.parents[0] !== c.sha) flush();
    if (qualifies(c)) run.push(c);
    else flush();
  }
  flush();
  return cases;
}

/** Parses `git log --first-parent --format=%x1e%H %P%x1f%s --raw --no-abbrev --no-renames`. */
export function parseLog(stdout: string): LogCommit[] {
  return stdout
    .split('\x1e')
    .slice(1)
    .map((record) => {
      const [head = '', ...rest] = record.split('\n');
      const [ids = '', subject = ''] = head.split('\x1f');
      const [sha = '', ...parents] = ids.trim().split(' ').filter(Boolean);
      const files = rest
        .filter((l) => l.startsWith(':'))
        .flatMap((l) => l.slice(l.indexOf('\t') + 1).split('\t'));
      return { sha, parents, subject, files: [...new Set(files)] };
    });
}
