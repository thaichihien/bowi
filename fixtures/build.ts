/**
 * Builds a fixture repo for manual testing.
 *
 * Usage: bun run fixture <name> <target-dir>
 */

import { resolve } from 'node:path';
import { buildFixtureRepo, fixtures } from './index.ts';

const [name, target] = process.argv.slice(2);
const spec = name ? fixtures[name] : undefined;
if (!spec || !target) {
  console.error(
    `Usage: bun run fixture <name> <target-dir>\nFixtures: ${Object.keys(fixtures).join(', ')}`,
  );
  process.exit(1);
}

const built = buildFixtureRepo(spec, resolve(target));
console.log(`Built ${spec.name} in ${built.dir}`);
console.log(`  ${built.baseBranch} ${built.baseSha}`);
console.log(`  ${built.headBranch} ${built.headSha} (checked out)`);
