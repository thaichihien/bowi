/**
 * Grouping quality benchmark (requirement.md §12.3), a development tool:
 *
 *   bun run bench:select <owner/repo …> [--cases 10]   pick cases, write bench/cases/*.json
 *   bun run bench [owner/repo …] [--json <file>]        run the cases, print the report
 *   bun run bench explain <case>                        show one case's groups and links
 *
 * Cases stay on this machine (bench/cases/ is git-ignored: they name the repositories used), so
 * every run here scores the same commits. Repositories are fetched into the
 * Bowi cache folder (`bench/`), without file contents except those the cases need.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultPlugins } from '@bowi/plugins';
import { gitText } from '@bowi/sources';
import { analyzeCase, evaluateCase } from './evaluate.ts';
import { formatExplanation } from './explain.ts';
import {
  benchCacheDir,
  caseSnapshot,
  fetchMainLine,
  openBenchRepo,
  prepareCase,
  SELECT_DEPTH,
  type BenchRepo,
} from './repo.ts';
import { formatReport, type RepoResults } from './report.ts';
import { parseLog, selectCases, type BenchCase } from './select.ts';

interface CaseFile {
  repo: string;
  selectedAt: string;
  cases: BenchCase[];
}

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const caseFile = (r: BenchRepo) => join(CASES_DIR, `${r.owner}__${r.repo}.json`);

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cases: { type: 'string', default: '10' }, json: { type: 'string' } },
  });
  // `run` is the default: `bench <owner/repo>` runs one repository.
  const command = ['run', 'select', 'explain'].includes(positionals[0] ?? '')
    ? positionals[0]!
    : 'run';
  const names = command === positionals[0] ? positionals.slice(1) : positionals;
  const cacheDir = benchCacheDir();

  if (command === 'select') {
    if (names.length === 0) {
      process.stderr.write(
        'Name the repositories to pick cases from: bun run bench:select <owner/repo> …\n',
      );
      return 1;
    }
    for (const r of names.map(parseRepo)) {
      const dir = await openBenchRepo(r, cacheDir);
      const ref = await fetchMainLine(dir);
      const log = parseLog(
        await gitText(
          [
            'log',
            '--first-parent',
            `--max-count=${SELECT_DEPTH}`,
            '--format=%x1e%H %P%x1f%s',
            '--raw',
            '--no-abbrev',
            '--no-renames',
            ref,
          ],
          { cwd: dir },
        ),
      );
      const cases = selectCases(log, r.repo, Number(values.cases));
      const file: CaseFile = {
        repo: `${r.owner}/${r.repo}`,
        selectedAt: new Date().toISOString().slice(0, 10),
        cases,
      };
      await mkdir(CASES_DIR, { recursive: true });
      await writeFile(caseFile(r), `${JSON.stringify(file, null, 2)}\n`);
      process.stderr.write(`${file.repo}: ${cases.length} cases → ${caseFile(r)}\n`);
    }
    return 0;
  }

  if (command === 'explain') {
    for (const name of (await readdir(CASES_DIR).catch(() => [] as string[])).filter((f) =>
      f.endsWith('.json'),
    )) {
      const file = JSON.parse(await readFile(join(CASES_DIR, name), 'utf8')) as CaseFile;
      const c = file.cases.find((x) => x.id === names[0]);
      if (!c) continue;
      const dir = await openBenchRepo(parseRepo(file.repo), cacheDir);
      await prepareCase(dir, c);
      const { plan, labels } = await analyzeCase(
        dir,
        c,
        caseSnapshot(dir, file.repo, c),
        defaultPlugins,
      );
      process.stdout.write(`${formatExplanation(c, plan, labels)}\n`);
      return 0;
    }
    process.stderr.write(`No case "${names[0] ?? ''}" in ${CASES_DIR}.\n`);
    return 1;
  }
  if (command !== 'run') {
    process.stderr.write(`Unknown command "${command}". Use "select", "run" or "explain".\n`);
    return 1;
  }
  const local = await readdir(CASES_DIR).catch(() => [] as string[]);
  const files = names.length
    ? names.map((n) => caseFile(parseRepo(n)))
    : local
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(CASES_DIR, f));
  if (files.length === 0) {
    process.stderr.write(
      'No benchmark cases on this machine yet. Pick some first: bun run bench:select <owner/repo> …\n',
    );
    return 1;
  }
  const results: RepoResults[] = [];
  for (const path of files) {
    const file = JSON.parse(await readFile(path, 'utf8')) as CaseFile;
    const dir = await openBenchRepo(parseRepo(file.repo), cacheDir);
    const repo: RepoResults = { repo: file.repo, cases: [] };
    for (const c of file.cases) {
      const start = Date.now();
      await prepareCase(dir, c);
      const result = await evaluateCase(dir, c, caseSnapshot(dir, file.repo, c), defaultPlugins);
      repo.cases.push(result);
      process.stderr.write(
        `✓ ${c.id.padEnd(26)} ${result.hunks} hunks · Bowi ${result.all.bowi.toFixed(2)} · ${((Date.now() - start) / 1000).toFixed(1)}s\n`,
      );
    }
    results.push(repo);
  }
  process.stdout.write(`${formatReport(results)}\n`);
  if (values.json) await writeFile(values.json, `${JSON.stringify(results, null, 2)}\n`);
  return 0;
}

function parseRepo(name: string): BenchRepo {
  const [owner, repo] = name.split('/');
  if (!owner || !repo) throw new Error(`Expected owner/repo, got "${name}"`);
  return { owner, repo };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`bench failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
