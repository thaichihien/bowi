/**
 * A stand-in for the `claude` CLI in tests: answers `--version`, and `-p` requests with a
 * result object like Claude Code's `--output-format json`. It appends what it saw (arguments,
 * working folder and its contents, stdin, whether a GitHub token arrived) to $FAKE_CLAUDE_LOG.
 * $FAKE_CLAUDE_MODE: "ok" (default), "login" (not logged in), "hang" (never answers).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.314 (Claude Code)');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8').on('data', (d) => (stdin += d)).on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
      args, cwd: process.cwd(), entries: fs.readdirSync('.'), stdin,
      githubToken: 'GITHUB_TOKEN' in process.env,
    }) + '\\n');
  }
  const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'login') {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true,
      result: 'Not logged in · Please run /login' }));
    process.exit(1);
  }
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  const group = (/^Group (g\\d+)/m.exec(stdin) || [])[1];
  const output = schema.properties.overview
    ? { overview: 'The pull request as a whole, in a sentence.' }
    : { title: 'AI title for ' + group, intent: 'What these changes do together.' };
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify(output), structured_output: output,
    modelUsage: { 'claude-small': { outputTokens: 3 }, 'claude-test-1': { outputTokens: 40 } } }));
});
`;

/**
 * Writes the fake into `dir` and returns the command that runs it: this Node with the script, so
 * it works with an empty PATH and on Windows, which cannot run a script by its `#!` line.
 */
export function fakeClaude(dir: string): string[] {
  const path = join(dir, 'claude.cjs');
  writeFileSync(path, SCRIPT);
  return [process.execPath, path];
}

export interface FakeCall {
  args: string[];
  cwd: string;
  entries: string[];
  stdin: string;
  githubToken: boolean;
}

export function fakeCalls(log: string): FakeCall[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FakeCall);
}
