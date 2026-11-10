// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PostResult, PostStatus, ReviewComment, ReviewPlan, ReviewSync } from '@bowi/core';
import { anchorFor, snippetOf } from '@bowi/core/review';
import { App } from '../ui/App.tsx';
import type { Server } from '../ui/review-store.ts';
import { fixturePlan } from './plan.ts';

const SERVICE = 'src/auth/auth.service.ts';
const server: Server = { base: 'http://127.0.0.1:4000', token: 'secret' };
const STATUS: PostStatus = { login: 'alice', via: 'gh', headSha: 'head' };
const sync = (pending: boolean): ReviewSync => ({
  host: 'github',
  id: 'C_1',
  url: 'https://github.com/acme/api/pull/7#discussion_r1',
  syncedAt: '2026-01-07T11:00:00Z',
  pending,
});

let plan: ReviewPlan;
let root: HTMLElement;

beforeAll(async () => {
  ({ plan } = await fixturePlan());
});
afterEach(() => {
  if (root) render(null, root);
  vi.unstubAllGlobals();
});

/** The fixture as a pull request, with comments. */
function pullRequest(comments: Partial<ReviewComment>[], body = 'Looks good.'): ReviewPlan {
  const p = structuredClone(plan);
  p.source = { ...p.source, kind: 'github', repo: 'acme/api', prNumber: 7, headSha: 'head' };
  const file = p.files.find((f) => f.path === SERVICE)!;
  const hunk = p.hunks.filter((h) => h.fileId === file.id)[1]!;
  p.review = {
    body,
    comments: comments.map((c, i) => ({
      id: `c-${i}`,
      body: `Comment ${i}`,
      anchor: anchorFor(SERVICE, 'head', hunk, { index: 3 }, { index: 5 }),
      snippet: snippetOf(hunk, 3, 5),
      createdAt: '2026-01-07T11:00:00Z',
      updatedAt: '2026-01-07T11:00:00Z',
      status: 'active',
      ...c,
    })) as ReviewComment[],
  };
  return p;
}

interface Backend {
  status?: PostStatus | { status: number; kind: string; error: string; hint?: string };
  result?: (request: Record<string, unknown>, p: ReviewPlan) => Partial<PostResult>;
  posts: Record<string, unknown>[];
  puts: unknown[];
  marks: Record<string, unknown>[];
  tokens: Record<string, unknown>[];
}

function backend(p: ReviewPlan, given: Partial<Backend> = {}): Backend {
  const b: Backend = { posts: [], puts: [], marks: [], tokens: [], ...given };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/review/posted')) {
        b.marks.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ savedAt: 'now' }));
      }
      if (url.endsWith('/api/review')) {
        if (init.method === 'GET') {
          return new Response(JSON.stringify({ generatedAt: p.generatedAt, review: p.review }));
        }
        b.puts.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ savedAt: 'now' }));
      }
      expect((init.headers as Record<string, string>)['X-Bowi-Token']).toBe('secret');
      if (url.endsWith('/api/github/token')) {
        if (init.method === 'DELETE') {
          b.tokens.push({ forget: true });
          b.status = STATUS;
          return new Response('{}');
        }
        const given = JSON.parse(init.body as string) as { token: string; name: string };
        b.tokens.push(given);
        if (given.token !== 'ghp_good') {
          return new Response(
            JSON.stringify({ kind: 'login', error: 'GitHub rejected your token (401).' }),
            { status: 502 },
          );
        }
        b.status = {
          ...STATUS,
          login: 'bob',
          via: 'token',
          ...(given.name && { tokenName: given.name }),
        };
        return new Response(JSON.stringify(b.status));
      }
      if (init.method === 'GET') {
        const s = b.status ?? STATUS;
        return 'kind' in s
          ? new Response(JSON.stringify(s), { status: s.status })
          : new Response(JSON.stringify(s));
      }
      const request = JSON.parse(init.body as string) as Record<string, unknown>;
      b.posts.push(request);
      const ids = request.commentIds as string[];
      const pending = request.mode === 'pending';
      const review = {
        ...p.review!,
        ...(request.summary ? { bodySync: sync(pending) } : {}),
        comments: p.review!.comments.map((c) =>
          ids.includes(c.id) ? { ...c, sync: sync(pending) } : c,
        ),
      };
      const answer: PostResult = {
        review,
        mode: request.mode as PostResult['mode'],
        sent: ids.length,
        summarySent: request.summary as boolean,
        summaryLeftOut: false,
        onFile: [],
        failed: [],
        ...b.result?.(request, p),
      };
      return new Response(JSON.stringify(answer));
    }),
  );
  return b;
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

async function show(p: ReviewPlan, withServer: Server | null = server, hash = '#comments') {
  if (root) render(null, root);
  localStorage.clear();
  window.location.hash = hash;
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  render(
    <App plan={p} now={Date.parse('2026-01-07T12:00:00Z')} server={withServer ?? undefined} />,
    root,
  );
  await settle();
}

const text = () => root.textContent ?? '';
const dialog = () => root.querySelector('.post-dialog');
const button = (label: string | RegExp) => {
  const all = [...root.querySelectorAll('button')];
  const b = all.find((x) =>
    typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? ''),
  );
  if (!b) throw new Error(`No button ${label}: ${all.map((x) => x.textContent).join(' | ')}`);
  return b;
};
const click = async (label: string | RegExp) => {
  await act(() => button(label).click());
  await settle();
};
const links = (label: string) =>
  [...root.querySelectorAll('a')].filter((a) => a.textContent?.includes(label));

describe('Post to GitHub (UI-28)', () => {
  it('has no button on a local report', async () => {
    const p = pullRequest([{}]);
    p.source = { ...p.source, kind: 'local' };
    backend(p);
    await show(p);
    expect(text()).not.toContain('Post to GitHub');
  });

  it('counts what is not sent, outdated aside, and asks GitHub only when pressed', async () => {
    const p = pullRequest([{}, {}, { status: 'outdated' }]);
    backend(p);
    await show(p);
    expect(button(/Post to GitHub/).textContent).toContain('2');
    const calls = vi.mocked(fetch).mock.calls.map((c) => c[0]);
    expect(calls.some((u) => String(u).endsWith('/api/github'))).toBe(false);
    await click(/Post to GitHub/);
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).endsWith('/api/github'))).toBe(
      true,
    );
  });

  it('says where and as whom, and sends a pending review of what is ticked', async () => {
    const p = pullRequest([{}, {}, { status: 'outdated' }]);
    const b = backend(p);
    await show(p);
    await click(/Post to GitHub/);
    const d = dialog()!;
    expect(d.textContent).toContain('Send 2 comments and the summary as a pending review');
    expect(d.textContent).toContain('acme/api#7');
    expect(d.textContent).toContain('@alice');
    expect(d.textContent).toContain('your gh login');
    expect(d.textContent).toContain('Top of the review');
    expect(d.textContent).toContain('Once posted, a comment is read-only here');
    const boxes = [...d.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    // Summary, two comments, and the outdated one unticked.
    expect(boxes.map((x) => x.checked)).toEqual([true, true, true, false]);
    await act(() => boxes[1]!.click());
    await settle();
    expect(dialog()!.textContent).toContain('Send 1 comment and the summary as a pending review');
    await click('Send 1 comment as a pending review');
    expect(b.posts).toEqual([
      {
        generatedAt: p.generatedAt,
        mode: 'pending',
        commentIds: ['c-1'],
        summary: true,
      },
    ]);
    expect(dialog()!.textContent).toContain('1 comment sent as a pending review. Not public yet.');
    expect(dialog()!.textContent).toContain('One step left');
  });

  it('never looks the same for pending and posted', async () => {
    const p = pullRequest([{}]);
    const b = backend(p);
    await show(p);
    await click(/Post to GitHub/);
    const now = [...dialog()!.querySelectorAll<HTMLInputElement>('input[type=radio]')][1]!;
    await act(() => now.click());
    await settle();
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Post 1 comment and the summary now');
    await click('Post 1 comment now');
    expect(b.posts[0]!.mode).toBe('now');
    expect(dialog()!.textContent).toContain('1 comment posted. Public now.');
    await click('Done');
    expect(root.querySelector('.chip.k-posted')!.textContent).toContain('Posted');
    expect(root.querySelector('.chip.k-pending')).toBeNull();
    // Nothing is waiting on GitHub: the button opens the pull request itself.
    const open = links('Open on GitHub').find((l) => l.closest('.header-actions'))!;
    expect(open.getAttribute('href')).toBe('https://github.com/acme/api/pull/7');
    expect(root.querySelector('.banner.warn')).toBeNull();
  });

  it('opens GitHub from the top, at the files after a pending review', async () => {
    const p = pullRequest([{}]);
    backend(p);
    await show(p);
    const top = () =>
      [...root.querySelector('.header-actions')!.querySelectorAll('a')].map((a) => [
        a.textContent,
        a.getAttribute('href'),
      ]);
    expect(top()).toEqual([['Open on GitHub', 'https://github.com/acme/api/pull/7']]);
    expect(text()).not.toContain('Submit on GitHub');

    const sent = pullRequest([{ sync: sync(true) }, {}]);
    backend(sent);
    await show(sent);
    expect(top()).toEqual([['Open on GitHub', 'https://github.com/acme/api/pull/7/files']]);
    expect(root.querySelector('.chip.k-pending')!.textContent).toContain('Sent as pending');
    expect(root.querySelector('.comments-side')!.textContent).toContain(
      '1 sent as pending · 1 not yet',
    );
  });

  it('lets the pending reminder be dismissed, until something new is sent', async () => {
    const p = pullRequest([{ sync: sync(true) }, {}]);
    backend(p);
    await show(p);
    const banner = () => root.querySelector('.banner.warn');
    expect(banner()!.textContent).toContain('Once you did, mark it as posted here.');
    await click('Dismiss');
    expect(banner()).toBeNull();
    // Remembered in this browser (show() clears storage, so render again by hand).
    render(null, root);
    render(<App plan={p} now={0} server={server} />, root);
    await settle();
    expect(banner()).toBeNull();
    // A later send as pending brings it back.
    const later = structuredClone(p);
    later.review!.comments[1]!.sync = {
      ...sync(true),
      id: 'C_2',
      syncedAt: '2026-01-08T09:00:00Z',
    };
    backend(later);
    render(null, root);
    render(<App plan={later} now={0} server={server} />, root);
    await settle();
    expect(banner()).not.toBeNull();
  });

  it('makes sent comments and summary read-only, everywhere', async () => {
    const p = pullRequest([{ sync: sync(true) }, {}]);
    p.review!.bodySync = sync(true);
    const b = backend(p);
    await show(p);
    const cards = [...root.querySelectorAll('.comment-card')];
    const sent = cards.find((c) => c.textContent?.includes('Comment 0'))!;
    const open = cards.find((c) => c.textContent?.includes('Comment 1'))!;
    expect(sent.querySelector('[aria-label="Edit comment"]')).toBeNull();
    expect(sent.querySelector('[aria-label="Delete comment"]')).toBeNull();
    expect(sent.textContent).toContain('Read-only · change it on GitHub');
    expect(sent.querySelector('.sent-view')!.getAttribute('href')).toBe(sync(true).url);
    expect(open.querySelector('[aria-label="Edit comment"]')).not.toBeNull();
    // The summary is shown, not offered for editing.
    expect(root.querySelector('#comments-summary textarea')).toBeNull();
    expect(root.querySelector('#comments-summary')!.textContent).toContain('Looks good.');

    // "Clear all" leaves them.
    await click('Clear all comments');
    expect(text()).toContain('Delete 1 comment? The 1 on GitHub stay.');
    await click('Delete');
    expect(text()).toContain('Comment 0');
    expect(text()).not.toContain('Comment 1');
    expect(text()).toContain('Looks good.');
    expect((b.puts.at(-1) as { review: { comments: unknown[] } }).review.comments).toHaveLength(1);
    // Nothing left to clear.
    expect(text()).not.toContain('Clear all comments');
  });

  it('shows the threads on the lines read-only too', async () => {
    const p = pullRequest([{ sync: sync(false) }]);
    backend(p);
    await show(p, server, '#g1:service');
    const thread = root.querySelector('.thread')!;
    expect(thread.textContent).toContain('Posted');
    expect(thread.textContent).toContain('Read-only');
    expect(thread.textContent).toContain('Hide');
    expect([...thread.querySelectorAll('button')].map((x) => x.textContent)).toEqual(['Hide']);
  });

  it('filters what is not on GitHub yet', async () => {
    const p = pullRequest([{ sync: sync(true) }, {}, { status: 'outdated' }]);
    backend(p);
    await show(p);
    await click(/^Not on GitHub/);
    expect(root.querySelector('.comments-title')!.textContent).toBe('Not on GitHub yet');
    expect(text()).not.toContain('Comment 0');
    expect(text()).toContain('Comment 1');
    expect(text()).toContain('Comment 2');
  });

  it('shows only outdated comments under Outdated', async () => {
    const p = pullRequest([{}, { status: 'outdated' }]);
    backend(p);
    await show(p);
    await click(/^Outdated/);
    expect(text()).not.toContain('Comment 0');
    expect(text()).toContain('Comment 1');
  });

  it('says when nothing is new', async () => {
    const p = pullRequest([{ sync: sync(true) }], '');
    backend(p);
    await show(p);
    expect(button(/Post to GitHub/).classList.contains('primary')).toBe(false);
    await click(/Post to GitHub/);
    expect(dialog()!.textContent).toContain('Nothing new to post');
    expect(dialog()!.textContent).toContain('1 comment already on GitHub, not sent again.');
    expect(button('Nothing to send').disabled).toBe(true);
  });

  it('warns about new commits and names the head it posts on', async () => {
    const p = pullRequest([{}], '');
    backend(p, { status: { ...STATUS, headSha: 'f'.repeat(40) } });
    await show(p);
    await click(/Post to GitHub/);
    expect(dialog()!.textContent).toContain('This pull request has new commits.');
    expect(dialog()!.textContent).toContain('ffffff');
    button(/Send 1 comment as pending, on head head/);
  });

  it('joins a pending review it finds, without the choice to post now', async () => {
    const p = pullRequest([{}]);
    const b = backend(p, {
      status: { ...STATUS, pending: { comments: 3, hasBody: true, headSha: 'head' } },
    });
    await show(p);
    await click(/Post to GitHub/);
    const d = dialog()!;
    expect(d.textContent).toContain('You already have a pending review here, with 3 comments.');
    expect(d.textContent).toContain('so yours stays here');
    expect(d.querySelector('input[type=radio]')).toBeNull();
    await click('Add 1 comment to your pending review');
    expect(b.posts[0]).toMatchObject({ mode: 'pending', summary: false });
  });

  it('stops at a pending review on another commit', async () => {
    const p = pullRequest([{}]);
    const b = backend(p, {
      status: { ...STATUS, pending: { comments: 1, hasBody: false, headSha: 'e'.repeat(40) } },
    });
    await show(p);
    await click(/Post to GitHub/);
    expect(dialog()!.textContent).toContain('Your pending review on GitHub is on commit eeeeeee');
    expect(dialog()!.querySelector('input[type=checkbox]')).toBeNull();
    expect(b.posts).toEqual([]);
  });

  it('tells no login apart, and tries again without a restart', async () => {
    const p = pullRequest([{}]);
    const b = backend(p, {
      status: {
        status: 502,
        kind: 'login',
        error: 'Bowi needs a GitHub login to post, and the GitHub CLI is not installed.',
        hint: 'Install it from https://cli.github.com and run `gh auth login`.',
      },
    });
    await show(p);
    await click(/Post to GitHub/);
    const banner = dialog()!.querySelector('.banner.danger')!;
    expect(banner.textContent).toContain('the GitHub CLI is not installed');
    expect(banner.querySelector('code')!.textContent).toBe('gh auth login');
    expect(banner.textContent).toContain('Your comments stay saved');
    b.status = STATUS;
    await click('Try again');
    expect(dialog()!.querySelector('.banner.danger')).toBeNull();
    expect(dialog()!.textContent).toContain('@alice');
  });

  it('says to look first when GitHub did not answer, and keeps what went through', async () => {
    const p = pullRequest([{}, {}], '');
    const b = backend(p, {
      result: (_r, plan2) => ({
        sent: 1,
        review: {
          ...plan2.review!,
          comments: plan2.review!.comments.map((c, i) =>
            i === 0 ? { ...c, sync: sync(true) } : c,
          ),
        },
        error: {
          kind: 'uncertain',
          message: 'GitHub did not answer in time.',
          hint: 'The last comment may have arrived. Check the pull request before you try again, so it is not posted twice.',
        },
      }),
    });
    await show(p);
    await click(/Post to GitHub/);
    await click('Send 2 comments as a pending review');
    const banner = dialog()!.querySelector('.banner.warn[role=alert]')!;
    expect(banner.textContent).toContain('GitHub did not answer in time.');
    expect(banner.textContent).toContain('1 comment went through');
    expect(links('Open the pull request')).toHaveLength(1);
    // Only the comment that did not go through is left to send.
    expect(dialog()!.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
    await click('Try again');
    expect((b.posts.at(-1) as { commentIds: string[] }).commentIds).toEqual(['c-1']);
  });

  it('lists what went on the file and what was not sent', async () => {
    const p = pullRequest([{}, {}], '');
    backend(p, {
      result: () => ({
        onFile: [{ id: 'c-0', path: SERVICE, label: 'Line 35' }],
        failed: [{ id: 'c-1', path: SERVICE, label: 'Line 40', message: 'Path is missing' }],
        sent: 1,
      }),
    });
    await show(p);
    await click(/Post to GitHub/);
    await click('Send 2 comments as a pending review');
    expect(dialog()!.textContent).toContain('On the file');
    expect(dialog()!.textContent).toContain('line 35');
    expect(dialog()!.textContent).toContain('Not sent');
    expect(dialog()!.textContent).toContain('Path is missing');
  });

  it('saves what is waiting before it posts, and does not post what could not be saved', async () => {
    const p = pullRequest([{}], '');
    const b = backend(p);
    await show(p);
    const typeSummary = (value: string) =>
      act(() => {
        const box = root.querySelector<HTMLTextAreaElement>('#comments-summary textarea')!;
        box.value = value;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
    // Typing saves after a pause, and the send comes before that pause ends.
    await typeSummary('Typed just now');
    expect(b.puts).toEqual([]);
    await click(/Post to GitHub/);
    await click('Send 1 comment as a pending review');
    expect(b.puts).toHaveLength(1);
    expect(b.posts).toHaveLength(1);

    b.posts.length = 0;
    await show(p);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/review') && init?.method === 'PUT') {
        throw new TypeError('Failed to fetch');
      }
      return original(url as string, init as RequestInit);
    });
    await typeSummary('Typed just now');
    await click(/Post to GitHub/);
    await click('Send 1 comment as a pending review');
    expect(dialog()!.querySelector('.banner.danger')!.textContent).toContain(
      'could not be saved, so nothing was posted',
    );
    expect(b.posts).toEqual([]);
  });

  it('opens a note instead when the report is a plain file', async () => {
    const p = pullRequest([{}]);
    backend(p);
    await show(p, null);
    await click(/Post to GitHub/);
    expect(dialog()!.textContent).toContain('This report is a plain file');
    expect(dialog()!.textContent).toContain('bowi serve');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const p = pullRequest([{}], '');
    backend(p);
    await show(p);
    await click(/Post to GitHub/);
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await settle();
    expect(dialog()).toBeNull();
  });

  it('marks a submitted review as posted in one click, with Undo', async () => {
    const p = pullRequest([{ sync: sync(true) }, { sync: { ...sync(true), id: 'C_2' } }, {}]);
    p.review!.bodySync = sync(true);
    const b = backend(p);
    await show(p);
    await click('I submitted it');
    expect(b.marks).toEqual([
      { generatedAt: p.generatedAt, ids: ['c-0', 'c-1'], summary: true, posted: true },
    ]);
    expect(root.querySelector('.chip.k-pending')).toBeNull();
    expect(root.querySelectorAll('.chip.k-posted')).toHaveLength(3);
    expect(root.querySelector('.banner.warn')).toBeNull();
    expect(root.querySelector('.header-actions a')!.getAttribute('href')).toBe(
      'https://github.com/acme/api/pull/7',
    );
    expect(root.querySelector('.toast')!.textContent).toContain(
      'Marked 2 comments and the summary as posted',
    );
    await click('Undo');
    expect(b.marks.at(-1)).toMatchObject({ ids: ['c-0', 'c-1'], summary: true, posted: false });
    expect(root.querySelectorAll('.chip.k-pending')).toHaveLength(3);
    expect(root.querySelector('.banner.warn')).not.toBeNull();
    // Nothing went through a save: that cannot change what was sent.
    expect(b.puts).toEqual([]);
  });

  it('filters by how comments were sent, and marks from the pending filter', async () => {
    const p = pullRequest([{ sync: sync(true) }, { sync: sync(false) }, {}]);
    backend(p);
    await show(p);
    await click(/^Sent as pending/);
    expect(root.querySelector('.comments-title')!.textContent).toBe('Sent as pending');
    expect(text()).toContain('Comment 0');
    expect(text()).not.toContain('Comment 1');
    expect(text()).not.toContain('Comment 2');
    await click(/^Posted/);
    expect(text()).toContain('Comment 1');
    expect(text()).not.toContain('Comment 0');
    await click(/^Sent as pending/);
    const inToolbar = root.querySelector('.toolbar-group button')!;
    expect(inToolbar.textContent).toBe('I submitted it');
    await act(() => (inToolbar as HTMLElement).click());
    await settle();
    // Nothing is pending any more: the filter is gone and all comments show.
    expect(root.querySelector('.comments-title')!.textContent).toBe('All comments');
    expect(button(/^Posted/).textContent).toContain('2');
    expect(() => button(/^Sent as pending/)).toThrow();
  });

  it('offers no marking on a plain file, which cannot save it', async () => {
    const p = pullRequest([{ sync: sync(true) }]);
    backend(p);
    await show(p, null);
    expect(() => button('I submitted it')).toThrow();
  });

  it('switches to a token of your own, even with a login, and back', async () => {
    const p = pullRequest([{}], '');
    const b = backend(p);
    await show(p);
    await click(/Post to GitHub/);
    expect(dialog()!.querySelector('.post-who')!.textContent).toContain('your gh login');
    await click('Use another token');
    const field = (label: string) =>
      [...dialog()!.querySelectorAll<HTMLLabelElement>('.post-field')]
        .find((l) => l.textContent?.startsWith(label))!
        .querySelector('input')!;
    expect(field('GitHub token').type).toBe('password');
    expect(document.activeElement).toBe(field('GitHub token'));
    const fill = (label: string, value: string) =>
      act(() => {
        const box = field(label);
        box.value = value;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await fill('GitHub token', 'ghp_bad');
    await click('Use this token');
    expect(dialog()!.querySelector('.post-token .banner.danger')!.textContent).toContain(
      'GitHub rejected your token',
    );
    await fill('GitHub token', 'ghp_good');
    await fill('Name', 'Work');
    await click('Use this token');
    expect(b.tokens.at(-1)).toEqual({ token: 'ghp_good', name: 'Work' });
    expect(dialog()!.querySelector('.post-token')).toBeNull();
    const who = dialog()!.querySelector('.post-who')!.textContent;
    expect(who).toContain('@bob');
    expect(who).toContain('token “Work”');
    // The page keeps no copy of it.
    expect(root.innerHTML).not.toContain('ghp_good');
    expect(JSON.stringify(localStorage)).not.toContain('ghp_good');
    await click('Use my usual login');
    expect(b.tokens.at(-1)).toEqual({ forget: true });
    expect(dialog()!.querySelector('.post-who')!.textContent).toContain('@alice');
  });

  it('opens the token field at once when there is no login', async () => {
    const p = pullRequest([{}], '');
    backend(p, {
      status: { status: 502, kind: 'login', error: 'Bowi needs a GitHub login to post.' },
    });
    await show(p);
    await click(/Post to GitHub/);
    expect(dialog()!.querySelector('.post-token')).not.toBeNull();
    // Nothing to cancel back to.
    expect(dialog()!.querySelector('.post-token button[type=button]')).toBeNull();
  });

  it('says so in the middle when a filter finds nothing', async () => {
    const p = pullRequest([{ sync: sync(true) }]);
    backend(p);
    await show(p);
    await click(/^Not on GitHub/);
    const empty = root.querySelector('.comments-none')!;
    expect(empty.textContent).toContain('Every comment is on GitHub');
    await click('Show all comments');
    expect(root.querySelector('.comments-title')!.textContent).toBe('All comments');
    expect(root.querySelector('.comments-none')).toBeNull();
    await click(/^Outdated/);
    expect(root.querySelector('.comments-none')!.textContent).toContain('No outdated comments');
  });

  it('says nothing about where it saves, when served', async () => {
    const p = pullRequest([{}]);
    backend(p);
    await show(p);
    expect(text()).not.toContain('saved to review-plan.json');
    await act(() => (root.querySelector('.save-pill') as HTMLElement).click());
    expect(root.querySelector('.save-pop')!.textContent).toBe(
      'Comments are savedEvery change goes into review-plan.json right away.',
    );
  });
});
