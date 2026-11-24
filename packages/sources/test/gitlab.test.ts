import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStageContext, DEFAULT_CONFIG, diffStage, SourceError } from '@bowi/core';
import {
  fetchMergeRequest,
  openGitlabSnapshot,
  openLocalSnapshot,
  parseMergeRequestUrl,
  remoteMessage,
  resolveGitlabLogin,
  type MergeRequestInfo,
} from '../src/index.ts';
import { fakeGitlabApi, fakeGitlabServer, MR_PATH } from './fake-gitlab.ts';

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'bowi-gl-'));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const ref = { host: 'gitlab.com', path: MR_PATH, iid: 7 };

describe('parseMergeRequestUrl', () => {
  it('accepts merge request URLs with subgroups, a tab, query or fragment', () => {
    for (const url of [
      'https://gitlab.com/acme/platform/api/-/merge_requests/7',
      'https://gitlab.com/acme/platform/api/-/merge_requests/7/',
      'https://gitlab.com/acme/platform/api/-/merge_requests/7/diffs',
      'https://gitlab.com/acme/platform/api/-/merge_requests/7/diffs?commit_id=abc#note_1',
    ]) {
      expect(parseMergeRequestUrl(url)).toEqual(ref);
    }
    expect(
      parseMergeRequestUrl('https://Git.Example.com:8443/team/app.web/-/merge_requests/12'),
    ).toEqual({
      host: 'git.example.com:8443',
      path: 'team/app.web',
      iid: 12,
    });
  });

  it('rejects anything else', () => {
    for (const url of [
      'https://gitlab.com/acme/api',
      'https://gitlab.com/acme/api/-/issues/7',
      'https://gitlab.com/acme/api/merge_requests/7',
      'https://gitlab.com/api/-/merge_requests/7',
      'https://gitlab.com/acme/../api/-/merge_requests/7',
      'http://gitlab.com/acme/api/-/merge_requests/7',
      'https://github.com/acme/api/pull/7',
    ]) {
      expect(parseMergeRequestUrl(url)).toBeUndefined();
    }
  });
});

describe('fetchMergeRequest', () => {
  let server: ReturnType<typeof fakeGitlabServer>;
  beforeAll(() => {
    server = fakeGitlabServer(tempDir());
  });

  it('reads the merge request, GitLab merge base, commits oldest first and closed issues', async () => {
    const info = await fetchMergeRequest(ref, { fetch: fakeGitlabApi(server.pr).fetch });
    expect(info).toMatchObject({
      url: 'https://gitlab.com/acme/platform/api/-/merge_requests/7',
      title: 'Add email verification',
      author: 'tanuki',
      baseRef: 'main',
      headRef: 'feature/email-verification',
      headSha: server.pr.headSha,
      mergeBaseSha: server.pr.mergeBaseSha,
      baseSha: server.pr.baseSha,
      totalCommits: server.pr.commits.length,
      linkedIssues: ['#12', 'acme/web#3'],
    });
    expect(info.commits.map((c) => c.sha)).toEqual(server.pr.commits.map((c) => c.sha));
    expect(info.commits[0]!.author.login).toBeUndefined();
  });

  it("names a fork's branch with the fork's path", async () => {
    const api = fakeGitlabApi(server.pr, { forkPath: 'bob/api' });
    const info = await fetchMergeRequest(ref, { fetch: api.fetch });
    expect(info.headRef).toBe('bob/api:feature/email-verification');
  });

  it('turns API errors into source errors with a next step', async () => {
    const notFound = await fetchMergeRequest(ref, {
      fetch: fakeGitlabApi(server.pr, { status: 404 }).fetch,
    }).catch((x) => x);
    expect(notFound).toBeInstanceOf(SourceError);
    expect(notFound.message).toContain('acme/platform/api!7 was not found');
    expect(notFound.hint).toContain('GITLAB_TOKEN');

    const rejected = await fetchMergeRequest(
      { ...ref, host: 'git.example.com' },
      { token: 'old', fetch: fakeGitlabApi(server.pr, { status: 401 }).fetch },
    ).catch((x) => x);
    expect(rejected.message).toContain('rejected the token');
    expect(rejected.hint).toContain('glab auth login --hostname git.example.com');

    const offline = await fetchMergeRequest(ref, {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    }).catch((x) => x);
    expect(offline.message).toContain('Could not reach the GitLab API at gitlab.com');
  });
});

describe('GitLab login', () => {
  /** A `glab` on PATH that prints a token per host, and the GitLab variables it was given. */
  const fakeGlab = () => {
    const bin = tempDir();
    const script = join(bin, 'glab');
    writeFileSync(
      script,
      '#!/bin/sh\n[ "$5" = "gitlab.com" ] && echo "glab-com-$GITLAB_TOKEN" && exit 0\n[ "$5" = "git.example.com" ] && echo "glab-example" && exit 0\nexit 0\n',
    );
    chmodSync(script, 0o755);
    return { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
  };

  it('sends GITLAB_TOKEN only to gitlab.com, or to the host in GITLAB_HOST', async () => {
    expect(await resolveGitlabLogin('gitlab.com', { GITLAB_TOKEN: 't' })).toEqual({
      token: 't',
      via: 'GITLAB_TOKEN',
    });
    const env = { GITLAB_TOKEN: 't', GITLAB_HOST: 'https://git.example.com/' };
    expect(await resolveGitlabLogin('git.example.com', env)).toEqual({
      token: 't',
      via: 'GITLAB_TOKEN',
    });
    expect(await resolveGitlabLogin('evil.example.org', { ...env, PATH: '' })).toEqual({
      missing: 'not-installed',
    });
  });

  it.skipIf(process.platform === 'win32')(
    "otherwise takes glab's token for that host, never glab's view of GITLAB_TOKEN",
    async () => {
      const env = { ...fakeGlab(), GITLAB_TOKEN: 'secret', GITLAB_HOST: 'other.example' };
      expect(await resolveGitlabLogin('gitlab.com', env)).toEqual({
        token: 'glab-com-',
        via: 'glab',
      });
      expect(await resolveGitlabLogin('git.example.com', env)).toEqual({
        token: 'glab-example',
        via: 'glab',
      });
      expect(await resolveGitlabLogin('evil.example.org', env)).toEqual({
        missing: 'not-logged-in',
      });
    },
  );
});

describe('openGitlabSnapshot', () => {
  let remoteUrl: string;
  let info: MergeRequestInfo;
  let localRepo: string;

  beforeAll(async () => {
    const root = tempDir();
    const server = fakeGitlabServer(root);
    remoteUrl = server.remoteUrl;
    localRepo = join(root, 'work');
    info = await fetchMergeRequest(ref, { fetch: fakeGitlabApi(server.pr).fetch });
  });

  it('caches the project under its whole path, then reuses it', async () => {
    const cacheDir = join(tempDir(), 'cache');
    const first = await openGitlabSnapshot(info, { cacheDir, remoteUrl });
    expect(first.fromCache).toBe(false);
    expect(first.meta).toMatchObject({
      kind: 'gitlab',
      repo: MR_PATH,
      prNumber: 7,
      url: 'https://gitlab.com/acme/platform/api/-/merge_requests/7',
      linkedIssues: ['#12', 'acme/web#3'],
    });
    expect(existsSync(join(cacheDir, 'repos', 'gitlab.com', 'acme', 'platform', 'api.git'))).toBe(
      true,
    );
    const second = await openGitlabSnapshot(info, { cacheDir, remoteUrl: 'file:///nonexistent' });
    expect(second.fromCache).toBe(true);
    expect(await second.readDiff()).toBe(await first.readDiff());
  });

  it('gives the same diff, history and search results as the local source', async () => {
    const gl = await openGitlabSnapshot(info, { cacheDir: join(tempDir(), 'cache'), remoteUrl });
    const local = await openLocalSnapshot({ cwd: localRepo });
    const ctx = createStageContext(DEFAULT_CONFIG);
    expect(await diffStage(gl, ctx)).toEqual(await diffStage(local, ctx));
    const paths = ['src/users/user.entity.ts', 'src/auth/auth.service.ts'];
    expect(await gl.blame!(paths)).toEqual(await local.blame!(paths));
    expect(await gl.baseHistory!(300)).toEqual(await local.baseHistory!(300));
    const words = ['User', 'register'];
    expect(await gl.grep!(words, ['.ts'])).toEqual(await local.grep!(words, ['.ts']));
  });

  it('never downloads a missing commit while checking the cache', async () => {
    // A fetch refused half way (a token without access to the code) leaves a partial clone
    // with no commits; checking it must not fetch them outside the shallow fetch.
    const cacheDir = join(tempDir(), 'cache');
    const refused = await openGitlabSnapshot(info, {
      cacheDir,
      remoteUrl: 'file:///nonexistent/repo.git',
    }).catch((x) => x);
    expect(refused).toBeInstanceOf(SourceError);
    const dir = join(cacheDir, 'repos', 'gitlab.com', 'acme', 'platform', 'api.git');
    execFileSync('git', ['-C', dir, 'config', 'remote.origin.promisor', 'true']);
    execFileSync('git', ['-C', dir, 'config', 'remote.origin.url', remoteUrl]);
    const gl = await openGitlabSnapshot(info, { cacheDir, remoteUrl });
    expect(gl.fromCache).toBe(false);
    const shallow = execFileSync('git', ['-C', dir, 'rev-parse', '--is-shallow-repository'], {
      encoding: 'utf8',
    });
    expect(shallow.trim()).toBe('true');
  });

  it('reports an unreachable remote as a source error', async () => {
    const e = await openGitlabSnapshot(info, {
      cacheDir: join(tempDir(), 'cache'),
      remoteUrl: 'file:///nonexistent/repo.git',
    }).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
  });
});

describe('remoteMessage', () => {
  it("keeps GitLab's own reason for refusing git", () => {
    const stderr =
      'remote: Access denied: This operation requires a fine-grained personal access token with the following project permissions: [Code: Download].\nfatal: unable to access ...: 403\n';
    expect(remoteMessage(stderr)).toBe(
      'Access denied: This operation requires a fine-grained personal access token with the following project permissions: [Code: Download].',
    );
    expect(remoteMessage('fatal: 403\n')).toBeUndefined();
  });
});
