#!/usr/bin/env node
import { run } from './index.ts';

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
