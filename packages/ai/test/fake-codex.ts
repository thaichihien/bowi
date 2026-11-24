/**
 * A stand-in for the `codex` CLI in tests: answers `--version`, and `exec` requests with JSON
 * Lines events like `codex exec --json`. It appends what it saw (arguments, working folder and
 * its contents, stdin, the answer schema, whether a GitHub token arrived) to $FAKE_CODEX_LOG.
 * $FAKE_CODEX_MODE: "ok" (default), "login" (not logged in), "hang" (never answers).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.98.0');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8').on('data', (d) => (stdin += d)).on('end', () => {
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
  if (process.env.FAKE_CODEX_LOG) {
    fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
      args, cwd: process.cwd(), entries: fs.readdirSync('.'), stdin, schema,
      githubToken: 'GITHUB_TOKEN' in process.env,
    }) + '\\n');
  }
  const mode = process.env.FAKE_CODEX_MODE || 'ok';
  if (mode === 'hang') return setInterval(() => {}, 1000);
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  if (mode === 'login') {
    console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'Not logged in. Run codex login.' } }));
    process.exit(1);
  }
  const group = (/^Group (g\\d+)/m.exec(stdin) || [])[1];
  const output = schema.properties.overview
    ? { overview: 'The pull request as a whole, in a sentence.' }
    : { title: 'AI title for ' + group, intent: 'What these changes do together.', moves: [] };
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'thinking' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: JSON.stringify(output) } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 80 } }));
});
`;

/** Writes the fake into `dir` and returns the command that runs it (see `fakeClaude`). */
export function fakeCodex(dir: string): string[] {
  const path = join(dir, 'codex.cjs');
  writeFileSync(path, SCRIPT);
  return [process.execPath, path];
}
