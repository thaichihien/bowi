import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorFor, snippetOf, type DiffLine, type ReviewPlan } from '@bowi/core';
import type { FakePr } from '../../sources/test/fake-github.ts';
import {
  fakeGitlabApi,
  fakeGitlabServer,
  MR_PATH,
  MR_URL,
} from '../../sources/test/fake-gitlab.ts';
import { run, type CliIo } from '../src/index.ts';

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bowi-gitlab-'));
  roots.push(dir);
  return dir;
}
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SERVICE = 'src/auth/auth.service.ts';
const readPlan = (dir: string): ReviewPlan =>
  JSON.parse(readFileSync(join(dir, 'review-plan.json'), 'utf8'));

let pr: FakePr;
let remoteUrl: string;
let cache: string;
let work: string;

async function bowi(argv: string[], gitlab: Partial<NonNullable<CliIo['gitlab']>> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    cwd: work,
    env: { PATH: process.env.PATH },
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    now: () => new Date('2026-01-01T00:00:00Z'),
    github: { token: '', apiBase: 'http://127.0.0.1:9' },
    gitlab: { apiBase: 'https://gitlab.com/api/v4', remoteUrl, token: 't', ...gitlab },
  });
  return { code, stdout, stderr };
}

beforeAll(() => {
  const root = tempDir();
  ({ remoteUrl, pr } = fakeGitlabServer(root));
  cache = join(root, 'cache');
  work = tempDir();
});

describe('bowi <gitlab-mr-url> (M13)', () => {
  it('reviews a merge request through the GitLab source', async () => {
    const api = fakeGitlabApi(pr);
    const r = await bowi([`${MR_URL}/diffs`, '--cache-dir', cache, '--no-open'], {
      fetch: api.fetch,
    });
    expect(r.stderr).not.toContain('error:');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('✓ Resolved  MR !7 · head');
    expect(r.stderr).toContain('✓ Fetched   head and merge base from gitlab.com/acme/platform/api');
    const dir = join(work, '.bowi', 'api-7');
    const plan = readPlan(dir);
    expect(plan.source).toMatchObject({
      kind: 'gitlab',
      repo: MR_PATH,
      prNumber: 7,
      url: MR_URL,
      author: 'tanuki',
      linkedIssues: ['#12', 'acme/web#3'],
    });
    expect(plan.groups.map((g) => g.kind)).toEqual(['feature', 'move', 'noise']);
    const html = readFileSync(join(dir, 'review.html'), 'utf8');
    expect(html).toContain('"kind":"gitlab"');
  });

  it('sends comments as draft notes on the merge request, placed by both line numbers', async () => {
    const out = join(tempDir(), 'out');
    expect(
      (
        await bowi([MR_URL, '--out', out, '--cache-dir', cache, '--no-open'], {
          fetch: fakeGitlabApi(pr).fetch,
        })
      ).code,
    ).toBe(0);

    const plan = readPlan(out);
    const file = plan.files.find((f) => f.path === SERVICE)!;
    const hunk = plan.hunks.filter((h) => h.fileId === file.id)[1]!;
    const comment = (id: string, a: number, b: number, body: string) => ({
      id,
      body,
      anchor: anchorFor(SERVICE, plan.source.headSha, hunk, { index: a }, { index: b }),
      snippet: snippetOf(hunk, a, b),
      createdAt: '2026-01-01T10:00:00Z',
      updatedAt: '2026-01-01T10:00:00Z',
      status: 'active' as const,
    });
    plan.review = {
      body: 'Looks good.',
      comments: [comment('c-1', 3, 5, 'A range'), comment('c-2', 11, 11, 'One line')],
    };
    writeFileSync(join(out, 'review-plan.json'), JSON.stringify(plan, null, 2));

    const api = fakeGitlabApi(pr);
    const r = await bowi(['comments', 'push', out, '--yes', '--now'], { fetch: api.fetch });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Posting to ${MR_PATH}!7 as @alice (GITLAB_TOKEN)`);
    expect(r.stdout).toContain('✓ Posted    2 comments and the summary, public now');
    expect(r.stdout).toContain(`→ Open      ${MR_URL}`);

    const [summary, range, line] = api.drafts;
    expect(summary).toMatchObject({ note: 'Looks good.', published: true });
    // Each row's numbers in both versions, as GitLab counts them.
    const place = (l: DiffLine) => ({
      ...(l.kind !== 'add' && { old_line: l.oldNo }),
      ...(l.kind !== 'del' && { new_line: l.newNo }),
    });
    expect(range!.position).toMatchObject({
      position_type: 'text',
      head_sha: pr.headSha,
      base_sha: pr.mergeBaseSha,
      new_path: SERVICE,
      ...place(hunk.lines[5]!),
      line_range: { start: place(hunk.lines[3]!), end: place(hunk.lines[5]!) },
    });
    expect(line!.position).toMatchObject(place(hunk.lines[11]!));
    expect(line!.position).not.toHaveProperty('line_range');

    const saved = readPlan(out).review!;
    expect(saved.bodySync).toMatchObject({ host: 'gitlab', url: MR_URL, pending: false });
    expect(saved.comments[0]!.sync).toMatchObject({
      host: 'gitlab',
      url: `${MR_URL}/diffs`,
      pending: false,
    });
  });

  it('points a pending review at the merge request’s changes, where GitLab submits it', async () => {
    const out = join(tempDir(), 'out');
    await bowi([MR_URL, '--out', out, '--cache-dir', cache, '--no-open'], {
      fetch: fakeGitlabApi(pr).fetch,
    });
    const plan = readPlan(out);
    plan.review = { body: 'Summary only.', comments: [] };
    writeFileSync(join(out, 'review-plan.json'), JSON.stringify(plan));
    const api = fakeGitlabApi(pr);
    const r = await bowi(['comments', 'push', out, '--yes'], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`→ Submit    ${MR_URL}/diffs`);
    expect(api.drafts).toEqual([{ id: 100, note: 'Summary only.', published: false }]);
  });
});
