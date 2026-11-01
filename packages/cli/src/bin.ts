#!/usr/bin/env node
// Checked before the rest of Bowi is loaded (a dynamic import, not a static one), so an old Node
// gets this message instead of a syntax or module error (NFR-6).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(
    `Bowi needs Node 22.12 or newer; this is Node ${process.versions.node}.\n` +
      'Install a current Node from https://nodejs.org (or with nvm, fnm, Homebrew, …).\n',
  );
  process.exit(1);
}

const { run } = await import('./index.ts');
process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
