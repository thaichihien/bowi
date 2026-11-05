/**
 * Smoke test of the published package (plan M9).
 *
 * Usage: bun run smoke   (builds the package first)
 *
 * Packs build/npm/ the way `npm publish` would, checks what goes in, installs the tarball with
 * plain npm into an empty folder (install scripts off: Bowi must not need any), then runs the
 * installed `bowi` on the email-verification fixture. Its plan must equal the one the sources
 * produce. Then `bowi serve` serves that report and saves a comment into it. Needs the npm
 * registry for the dependencies; never GitHub.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparablePlanJson, type ReviewPlan } from '@bowi/core';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { PACKAGE_DIR } from './build-package.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Files allowed in the tarball; anything else (tests, sources, fixtures) fails the test. */
const ALLOWED = [
  /^package\.json$/,
  /^(README|CHANGELOG)\.md$/,
  /^LICENSE$/,
  /^dist\/(bin|bowi)\.js$/,
  /^grammars\/(tree-sitter-[a-z]+\.wasm|LICENSE-tree-sitter-[a-z]+|VERSIONS)$/,
  /^queries\/[a-z]+\.scm$/,
  /^template\/index\.html$/,
];

interface PackResult {
  filename: string;
  size: number;
  unpackedSize: number;
  files: { path: string }[];
}

function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

// On Windows npm and the installed `bowi` are .cmd shims, which only cmd.exe runs; the
// arguments here are paths and flags without quotes, so quoting each one is enough. A bare
// command name stays unquoted: cmd.exe gives a .cmd found on PATH under a quoted name the
// current folder as `%~dp0`, and npm.cmd then looks for npm in the wrong place.
const WINDOWS = process.platform === 'win32';

function run(cmd: string, args: string[], cwd: string): string {
  const r = WINDOWS
    ? spawnSync(
        [/^[\w.-]+$/.test(cmd) ? cmd : `"${cmd}"`, ...args.map((a) => `"${a}"`)].join(' '),
        {
          cwd,
          encoding: 'utf8',
          shell: true,
        },
      )
    : spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

if (!existsSync(join(PACKAGE_DIR, 'package.json')))
  fail('build/npm is missing: run `bun run build:package`.');
const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
  version: string;
};

const temp = mkdtempSync(join(tmpdir(), 'bowi-smoke-'));
try {
  // 1. Pack, and check the contents.
  const [pack] = JSON.parse(
    run(
      'npm',
      ['pack', PACKAGE_DIR, '--pack-destination', temp, '--json', '--loglevel=error'],
      ROOT,
    ),
  ) as PackResult[];
  if (!pack) fail('npm pack printed nothing.');
  const unexpected = pack.files.map((f) => f.path).filter((p) => !ALLOWED.some((re) => re.test(p)));
  if (unexpected.length) fail(`unexpected files in the package:\n  ${unexpected.join('\n  ')}`);
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  console.log(
    `✓ packed ${pack.filename}: ${pack.files.length} files, ${kb(pack.size)} (${kb(pack.unpackedSize)} unpacked)`,
  );

  // 2. Install into an empty folder, as a user would.
  const app = join(temp, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), '{ "private": true }\n');
  run(
    'npm',
    [
      'install',
      join(temp, pack.filename),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    app,
  );
  const bowi = join(app, 'node_modules', '.bin', WINDOWS ? 'bowi.cmd' : 'bowi');
  const printed = run(bowi, ['--version'], app).trim();
  if (printed !== version) fail(`bowi --version printed ${printed}, expected ${version}`);
  console.log(`✓ installed with npm; bowi --version: ${printed}`);

  // 3. The installed CLI and the sources produce the same plan.
  const repo = join(temp, 'repo');
  const fixture = buildFixtureRepo(emailVerification, repo);
  const args = ['--local', '--base', fixture.baseBranch, '--no-open', '--quiet'];
  run(bowi, [...args, '--out', join(temp, 'out-package')], repo);
  run(
    process.execPath,
    [
      ...process.execArgv,
      join(ROOT, 'packages', 'cli', 'src', 'bin.ts'),
      ...args,
      '--json-only',
      '--out',
      join(temp, 'out-sources'),
    ],
    repo,
  );
  const plan = (dir: string) =>
    JSON.parse(readFileSync(join(temp, dir, 'review-plan.json'), 'utf8')) as ReviewPlan;
  if (comparablePlanJson(plan('out-package')) !== comparablePlanJson(plan('out-sources'))) {
    fail('the installed package and the sources produced different plans.');
  }
  const html = readFileSync(join(temp, 'out-package', 'review.html'), 'utf8');
  if (html.includes('__BOWI_PLAN__') || !html.includes(`Bowi`))
    fail('review.html was not filled in.');
  const { groups } = plan('out-package');
  console.log(
    `✓ bowi --local on the email-verification fixture: ${groups.length} groups, review.html ${kb(html.length)}, same plan as the sources`,
  );

  // 4. `bowi serve` from the package: the page, and a save into the plan. Started with node
  // and the package's own bin.js, so it can be stopped on Windows too (no .cmd shim around it).
  const bin = join(app, 'node_modules', '@bowi', 'cli', 'dist', 'bin.js');
  const server = spawn(process.execPath, [bin, 'serve', join(temp, 'out-package'), '--no-open'], {
    cwd: app,
  });
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => reject(new Error(`no address after 20 s\n${err}`)), 20_000);
      server.stderr.on('data', (d: Buffer) => {
        err += d.toString();
        const m = /→ Open (\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      server.once('exit', (code) => reject(new Error(`bowi serve exited ${code}\n${err}`)));
    }).catch((e: Error) => fail(e.message));
    const page = await fetch(url);
    if (!page.ok || !(await page.text()).includes('bowi-features'))
      fail(`${url} did not serve the page.`);
    const address = new URL(url);
    const saved = await fetch(`${address.origin}/api/review`, {
      method: 'PUT',
      headers: {
        'X-Bowi-Token': address.searchParams.get('t')!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        generatedAt: plan('out-package').generatedAt,
        review: { body: 'From the smoke test', comments: [] },
      }),
    });
    if (!saved.ok) fail(`saving a comment answered ${saved.status}: ${await saved.text()}`);
  } finally {
    server.kill('SIGINT');
    await exited;
  }
  if (plan('out-package').review?.body !== 'From the smoke test')
    fail('bowi serve did not save the comment into review-plan.json.');
  console.log('✓ bowi serve: served the report and saved a comment into its plan');
  console.log(`  node ${process.versions.node}, npm ${run('npm', ['--version'], temp).trim()}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
