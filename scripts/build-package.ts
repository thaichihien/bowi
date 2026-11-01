/**
 * Builds the npm package `bowi` into build/npm/ (plan M9).
 *
 * Usage: bun run build:package   (builds the page template first)
 *
 * Only `bowi` is published. Every internal `@bowi/*` package is bundled into dist/; third-party
 * packages stay dependencies of `bowi`, pinned to the exact versions the internal packages
 * declare (shiki and the grammars change output). Layout:
 *
 *   dist/bin.js       Node version check, then loads dist/bowi.js
 *   dist/bowi.js      the CLI and every @bowi/* package
 *   grammars/ queries/ template/
 *
 * Code that finds those folders, and package.json for the version, goes one folder up from its
 * own module: that holds in the sources (packages/<name>/src/) and in dist/ alike.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_DIR = join(ROOT, 'build', 'npm');

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Manifest;
const cli = readJson(join(ROOT, 'packages', 'cli', 'package.json'));

/** Third-party dependencies declared by the internal packages, by name. */
function declaredDependencies(): Map<string, string> {
  const deps = new Map<string, string>();
  for (const name of [
    'ai',
    'cache',
    'cli',
    'core',
    'lang',
    'plugins',
    'render-html',
    'rules',
    'sources',
  ]) {
    const manifest = readJson(join(ROOT, 'packages', name, 'package.json'));
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (dep.startsWith('@bowi/')) continue;
      const known = deps.get(dep);
      if (known && known !== spec) {
        throw new Error(`${dep} is declared as both ${known} and ${spec}; use one version.`);
      }
      deps.set(dep, spec);
    }
  }
  return deps;
}

/** `shiki/core` → `shiki`, `@scope/pkg/x` → `@scope/pkg`. */
const packageName = (spec: string) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

/** Leaves third-party packages as imports and records which ones the code uses. */
function externals(used: Set<string>): Plugin {
  return {
    name: 'bowi-externals',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith('node:') || args.path.startsWith('@bowi/')) return undefined;
        used.add(packageName(args.path));
        return { path: args.path, external: true };
      });
    },
  };
}

export async function buildPackage(): Promise<string> {
  const template = join(ROOT, 'packages', 'render-html', 'template', 'index.html');
  if (!existsSync(template))
    throw new Error('The page template is missing: run `bun run build:ui`.');

  rmSync(PACKAGE_DIR, { recursive: true, force: true });
  mkdirSync(PACKAGE_DIR, { recursive: true });

  const used = new Set<string>();
  await build({
    entryPoints: { bin: join(ROOT, 'packages', 'cli', 'src', 'bin.ts') },
    outdir: join(PACKAGE_DIR, 'dist'),
    bundle: true,
    // bin.js loads the rest with a dynamic import: splitting keeps that a separate file, so the
    // version check runs before any dependency is loaded.
    splitting: true,
    chunkNames: 'bowi',
    format: 'esm',
    platform: 'node',
    target: 'node22.12',
    plugins: [externals(used)],
    logLevel: 'warning',
  });

  const declared = declaredDependencies();
  const dependencies: Record<string, string> = {};
  for (const dep of [...used].sort()) {
    const spec = declared.get(dep);
    if (!spec) throw new Error(`${dep} is imported but no package declares it as a dependency.`);
    if (!/^\d+\.\d+\.\d+$/.test(spec))
      throw new Error(`${dep} must be pinned exactly, not ${spec}.`);
    dependencies[dep] = spec;
  }

  cpSync(join(ROOT, 'packages', 'lang', 'grammars'), join(PACKAGE_DIR, 'grammars'), {
    recursive: true,
  });
  cpSync(join(ROOT, 'packages', 'lang', 'queries'), join(PACKAGE_DIR, 'queries'), {
    recursive: true,
  });
  mkdirSync(join(PACKAGE_DIR, 'template'));
  cpSync(template, join(PACKAGE_DIR, 'template', 'index.html'));
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
    cpSync(join(ROOT, file), join(PACKAGE_DIR, file));
  }

  const manifest = {
    name: cli.name,
    version: cli.version,
    description:
      'Turns a pull request into a guided review: related changes grouped, foundations first, noise collapsed, every group explained.',
    keywords: ['code-review', 'pull-request', 'review', 'diff', 'git', 'github', 'cli'],
    license: 'MIT',
    author: 'thaichihien',
    homepage: 'https://github.com/thaichihien/bowi#readme',
    repository: { type: 'git', url: 'git+https://github.com/thaichihien/bowi.git' },
    bugs: { url: 'https://github.com/thaichihien/bowi/issues' },
    type: 'module',
    bin: { bowi: 'dist/bin.js' },
    files: ['dist', 'grammars', 'queries', 'template'],
    engines: { node: '>=22.12.0' },
    // Windows comes in 0.2.0 (plan M10); until then npm says so instead of installing.
    os: ['darwin', 'linux'],
    dependencies,
  };
  writeFileSync(join(PACKAGE_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return PACKAGE_DIR;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = await buildPackage();
  const { name, version, dependencies } = readJson(join(dir, 'package.json'));
  console.log(`Built ${name} ${version} in ${dir}`);
  console.log(`  dependencies: ${Object.keys(dependencies ?? {}).join(', ')}`);
}
