/**
 * Sending comments to a GitHub pull request (M11, §15 #70), the only place Bowi writes to GitHub.
 *
 * Everything goes through GraphQL, one comment per request: a review is always created pending,
 * comments join it one by one, and "post now" submits it at the end. So one refused line does not
 * refuse the whole review (REST takes all comments at once and has no file comments there), each
 * comment gets its own id and address, new comments can join a pending review the reviewer already
 * has, and nothing is public before the last step.
 */

import { HostError, type HostComment, type HostRef, type ReviewHost } from '@bowi/core';
import { ghToken, type PullRequestRef } from './github.ts';

export interface GithubLogin {
  token: string;
  via: 'gh' | 'GITHUB_TOKEN' | 'token';
}

/** GITHUB_TOKEN, else the GitHub CLI's login; without either, says which next step applies. */
export async function findGithubLogin(env: NodeJS.ProcessEnv = process.env): Promise<GithubLogin> {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, via: 'GITHUB_TOKEN' };
  const gh = await ghToken(env);
  if ('token' in gh) return { token: gh.token, via: 'gh' };
  if (gh.missing === 'not-installed') {
    throw new HostError(
      'login',
      'Bowi needs a GitHub login to post, and the GitHub CLI is not installed.',
      'Install it from https://cli.github.com and run `gh auth login`, or set `GITHUB_TOKEN` and start Bowi again.',
    );
  }
  throw new HostError(
    'login',
    'Bowi needs a GitHub login to post.',
    'Run `gh auth login`, then try again. Or set `GITHUB_TOKEN` and start Bowi again.',
  );
}

const TIMEOUT_MS = 30_000;

const STATUS = `query BowiStatus($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      headRefOid
      reviews(states: [PENDING], first: 10) {
        nodes { id body viewerDidAuthor commit { oid } comments { totalCount } }
      }
    }
  }
}`;
const START = `mutation BowiStartReview($pr: ID!, $commit: GitObjectID, $body: String) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, body: $body }) {
    pullRequestReview { id url }
  }
}`;
const SET_SUMMARY = `mutation BowiSetSummary($review: ID!, $body: String!) {
  updatePullRequestReview(input: { pullRequestReviewId: $review, body: $body }) {
    pullRequestReview { id url }
  }
}`;
const ADD_THREAD = `mutation BowiAddThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) {
    thread { comments(first: 1) { nodes { id url } } }
  }
}`;
const SUBMIT = `mutation BowiSubmit($review: ID!) {
  submitPullRequestReview(input: { pullRequestReviewId: $review, event: COMMENT }) {
    pullRequestReview { id url }
  }
}`;

interface GraphqlError {
  type?: string;
  message?: string;
}

interface StatusData {
  viewer: { login: string };
  repository: {
    pullRequest: {
      id: string;
      headRefOid: string;
      reviews: {
        nodes: {
          id: string;
          body: string;
          viewerDidAuthor: boolean;
          commit: { oid: string } | null;
          comments: { totalCount: number };
        }[];
      };
    } | null;
  } | null;
}

export function githubReviewHost(
  ref: PullRequestRef,
  login: GithubLogin,
  options: { fetch?: typeof fetch; apiBase?: string; timeoutMs?: number } = {},
): ReviewHost {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.apiBase ?? 'https://api.github.com'}/graphql`;
  const label = `${ref.owner}/${ref.repo}#${ref.number}`;
  const name = { gh: 'GitHub CLI login', GITHUB_TOKEN: '`GITHUB_TOKEN`', token: 'token' }[
    login.via
  ];
  let pullRequestId: string | undefined;

  /** A request's data and errors; everything that stops a send is thrown as a HostError. */
  async function request<T>(
    query: string,
    variables: Record<string, unknown>,
    writes: boolean,
  ): Promise<{ data?: T | null; errors: GraphqlError[] }> {
    // After a request that writes, no answer does not mean nothing happened.
    const noAnswer = (message: string) =>
      writes
        ? new HostError(
            'uncertain',
            message,
            'The last comment may have arrived. Check the pull request before you try again, so it is not posted twice.',
          )
        : new HostError('other', message, 'Check your network connection and try again.');
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${login.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'bowi',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      throw noAnswer('GitHub did not answer in time.');
    }
    if (res.status === 401) {
      throw new HostError(
        'login',
        `GitHub rejected your ${name} (401).`,
        {
          gh: 'Run `gh auth login` again.',
          GITHUB_TOKEN: 'Check `GITHUB_TOKEN`.',
          token: 'Check the token, or paste another one.',
        }[login.via],
      );
    }
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
      throw limitReached();
    }
    if (res.status === 403) throw cannotPost();
    if (res.status >= 500) throw noAnswer(`GitHub answered with an error (${res.status}).`);
    if (!res.ok) {
      throw new HostError('other', `GitHub API error ${res.status} for ${label}.`);
    }
    let body: { data?: T | null; errors?: GraphqlError[] };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw noAnswer('GitHub sent an answer Bowi could not read.');
    }
    const errors = body.errors ?? [];
    for (const e of errors) {
      if (e.type === 'RATE_LIMITED' || /rate limit/i.test(e.message ?? '')) throw limitReached();
      if (e.type === 'FORBIDDEN' || /not accessible/i.test(e.message ?? '')) throw cannotPost();
    }
    return { ...(body.data !== undefined && { data: body.data }), errors };
  }

  const limitReached = () =>
    new HostError(
      'limit',
      'GitHub says Bowi is sending too much at once (rate limit).',
      'Wait a few minutes and try again. What was sent is recorded and is not sent twice.',
    );
  const cannotPost = () =>
    new HostError(
      'read-only',
      `Your ${name} can read ${label} but cannot post to it.`,
      'Give it "Pull requests: write", or for a classic token the `repo` scope.',
    );
  const refusedBy = (errors: GraphqlError[], what: string) =>
    new HostError('other', `GitHub refused ${what}: ${errors[0]?.message ?? 'no reason given'}.`);

  async function reviewCall(
    query: string,
    variables: Record<string, unknown>,
    field: string,
    what: string,
  ): Promise<HostRef> {
    const { data, errors } = await request<
      Record<string, { pullRequestReview: HostRef | null } | null>
    >(query, variables, true);
    const review = data?.[field]?.pullRequestReview;
    if (!review) throw refusedBy(errors, what);
    return review;
  }

  return {
    async status() {
      const { data, errors } = await request<StatusData>(
        STATUS,
        { owner: ref.owner, repo: ref.repo, number: ref.number },
        false,
      );
      const pr = data?.repository?.pullRequest;
      if (!data || !pr) {
        throw new HostError(
          'other',
          `Pull request ${label} was not found.`,
          errors.length > 0
            ? 'Check that your login can read this repository.'
            : 'Check that it still exists.',
        );
      }
      pullRequestId = pr.id;
      // GitHub shows a pending review to its author only; the check is for safety.
      const mine = pr.reviews.nodes.find((r) => r.viewerDidAuthor);
      return {
        login: data.viewer.login,
        headSha: pr.headRefOid,
        ...(mine && {
          pendingId: mine.id,
          pending: {
            comments: mine.comments.totalCount,
            hasBody: mine.body.trim() !== '',
            headSha: mine.commit?.oid ?? '',
          },
        }),
      };
    },

    async startReview(headSha, body) {
      if (!pullRequestId) await this.status();
      return reviewCall(
        START,
        { pr: pullRequestId, commit: headSha, ...(body !== undefined && { body }) },
        'addPullRequestReview',
        'the review',
      );
    },

    setSummary(reviewId, body) {
      return reviewCall(
        SET_SUMMARY,
        { review: reviewId, body },
        'updatePullRequestReview',
        'the summary',
      );
    },

    async addComment(reviewId, comment) {
      const { data, errors } = await request<{
        addPullRequestReviewThread: {
          thread: { comments: { nodes: HostRef[] } } | null;
        } | null;
      }>(ADD_THREAD, { input: threadInput(reviewId, comment) }, true);
      if (errors.some((e) => e.type === 'NOT_FOUND')) throw refusedBy(errors, 'the comment');
      const made = data?.addPullRequestReviewThread?.thread?.comments.nodes[0];
      return made ?? { refused: errors[0]?.message ?? 'GitHub gave no reason' };
    },

    async publish(reviewId) {
      await reviewCall(SUBMIT, { review: reviewId }, 'submitPullRequestReview', 'the review');
    },
  };
}

const diffSide = (side: 'old' | 'new') => (side === 'old' ? 'LEFT' : 'RIGHT');

function threadInput(reviewId: string, c: HostComment): Record<string, unknown> {
  const base = { pullRequestReviewId: reviewId, path: c.path, body: c.body };
  if (c.line === undefined || c.side === undefined) return { ...base, subjectType: 'FILE' };
  return {
    ...base,
    subjectType: 'LINE',
    line: c.line,
    side: diffSide(c.side),
    ...(c.startLine !== undefined && {
      startLine: c.startLine,
      startSide: diffSide(c.startSide ?? c.side),
    }),
  };
}
