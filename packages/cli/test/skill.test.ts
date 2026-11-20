import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureRepo, emailVerification } from '@bowi/fixtures';
import { run } from '../src/index.ts';

/** The skill for Claude Code and Codex (M19), shipped in the package next to dist/. */
const SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'skills',
  'bowi',
  'SKILL.md',
);
const text = readFileSync(SKILL, 'utf8');

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The `node -e '…'` snippets that read the plan in parts, in the order the skill gives them. */
const snippets = [...text.matchAll(/```bash\nnode -e '([\s\S]*?)' PLAN(?: STEP)?\n```/g)].map(
  (m) => m[1]!,
);
const node = (code: string, ...args: string[]) =>
  execFileSync(process.execPath, ['-e', code, ...args], { encoding: 'utf8' });

describe('the Bowi skill (M19)', () => {
  it('has the Agent Skills frontmatter Claude Code and Codex read', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    expect(front).toBeDefined();
    const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(front!)?.[1];
    // The name matches the folder: lower case, digits and single hyphens, at most 64 characters.
    expect(field('name')).toBe('bowi');
    const description = field('description')!;
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/review a pull request/i);
  });

  it('never lets the agent post for the user', () => {
    expect(text).toContain('Never run `bowi comments push` for them and never pass `--yes`.');
    expect(text).not.toMatch(/comments push[^\n]*--yes`? *$/m);
  });

  describe('reading the plan in parts', () => {
    let plan: string;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), 'bowi-skill-'));
      roots.push(root);
      const repo = buildFixtureRepo(emailVerification, join(root, 'repo')).dir;
      const out = join(root, 'out');
      const io = { write: () => {} };
      const code = await run(['--local', '--json-only', '--out', out], {
        cwd: repo,
        env: {},
        stdout: io,
        stderr: io,
        now: () => new Date('2026-01-01T00:00:00Z'),
        github: { token: '', apiBase: 'http://127.0.0.1:9' },
      });
      expect(code).toBe(0);
      plan = join(out, 'review-plan.json');
    });

    it('gives an overview: groups, why, hints and the steps with their files', () => {
      expect(snippets).toHaveLength(2);
      const overview = node(snippets[0]!, plan);
      expect(overview).toContain('11 files, +115 -25, 94 lines to read carefully');
      expect(overview).toContain('Group 1 [feature] New `AuthService.verifyEmail()`');
      expect(overview).toContain('hint (attention): New route: GET /auth/verify-email');
      expect(overview).toMatch(/step g1:service Services: .*src\/auth\/auth\.service\.ts/);
      expect(overview).toContain('Group 3 [noise] Generated files and formatting');
    });

    it('shows one step: diff lines, moved code with its changes, noise left out', () => {
      const service = node(snippets[1]!, plan, 'g1:service');
      expect(service).toContain('+     await this.mail.sendVerificationEmail(user.email, token);');
      expect(service).toContain(
        'unchanged code using AuthService.register: src/auth/auth.controller.ts:',
      );
      const moved = node(snippets[1]!, plan, 'g2:move1');
      expect(moved).toContain('lines marked ~ changed on the way (1)');
      expect(moved).toMatch(/^~ +\.replace\(\/\[\^a-z0-9\]\+\/g, '-'\)$/m);
      const generated = node(snippets[1]!, plan, 'g3:generated');
      expect(generated).toMatch(/generated: \d+ lines, not shown/);
      expect(generated).not.toContain('"resolved"');
    });
  });
});
