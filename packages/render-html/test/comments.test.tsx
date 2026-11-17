// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Review, ReviewComment, ReviewPlan } from '@bowi/core';
import { anchorFor, snippetOf } from '@bowi/core/review';
import { App } from '../ui/App.tsx';
import { draftKey, type Server } from '../ui/review-store.ts';
import { fixturePlan } from './plan.ts';

let plan: ReviewPlan;
let root: HTMLElement;
const NOW = Date.parse('2026-01-07T12:00:00Z');
const SERVICE = 'src/auth/auth.service.ts';

beforeAll(async () => {
  ({ plan } = await fixturePlan());
});

const show = (
  p: ReviewPlan,
  hash = '#g1:service',
  { keepStorage = false, server }: { keepStorage?: boolean; server?: Server } = {},
) => {
  if (root) render(null, root);
  if (!keepStorage) localStorage.clear();
  window.location.hash = hash;
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  render(<App plan={p} now={NOW} server={server} />, root);
};

beforeEach(() => show(plan));
afterEach(() => vi.restoreAllMocks());

const text = () => root.textContent ?? '';
// Waits until the page stops changing and, when given, until `ready` holds. A reply from the
// fake server takes a few turns, and the page asks for it from an effect that runs a frame or
// more after rendering (later on a busy machine, or on Node 24), so a fixed wait was flaky.
const settle = async (ready: () => boolean = () => true) => {
  let before: string | undefined;
  for (let i = 0; i < 100; i++) {
    const now = document.body.innerHTML;
    if (now === before && ready()) return;
    before = now;
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  }
  throw new Error('The page did not settle');
};
const pill = () => root.querySelector('.save-pill')?.textContent;
const press = (el: Element | undefined | null) => act(() => (el as HTMLElement).click());
const buttons = () => [...root.querySelectorAll('button')];
const button = (label: string | RegExp) => {
  const b = buttons().find((x) =>
    typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? ''),
  );
  if (!b)
    throw new Error(
      `No button ${label}: ${buttons()
        .map((x) => x.textContent)
        .join(' | ')}`,
    );
  return b;
};
const click = (label: string | RegExp) => press(button(label));

/** The "+" of a line, found by its accessible name ("Comment on line 45"). */
const plus = (name: string, scope: ParentNode = root) => {
  const b = [...scope.querySelectorAll('.add-comment')].find(
    (x) => x.getAttribute('aria-label') === `Comment on ${name}`,
  );
  if (!b) throw new Error(`No + for ${name}`);
  return b as HTMLElement;
};
const pick = (
  name: string,
  { shift = false, scope }: { shift?: boolean; scope?: ParentNode } = {},
) =>
  act(() => {
    plus(name, scope).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: shift }),
    );
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
const type = (value: string, el = root.querySelector('textarea')!) =>
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const card = (path: string) =>
  [...root.querySelectorAll('.card.file')].find((c) =>
    c.querySelector('.path')?.textContent?.includes(path),
  )!;
const threads = () => [...root.querySelectorAll('.thread')];

function seeded(comments: Partial<ReviewComment>[], body = ''): ReviewPlan {
  const p = structuredClone(plan);
  const file = p.files.find((f) => f.path === SERVICE)!;
  const hunk = p.hunks.filter((h) => h.fileId === file.id)[1]!;
  p.review = {
    body,
    comments: comments.map((c, i) => ({
      id: `c-${i}`,
      body: 'Why?',
      anchor: anchorFor(SERVICE, p.source.headSha, hunk, { index: 3 }, { index: 5 }),
      snippet: snippetOf(hunk, 3, 5),
      createdAt: '2026-01-07T11:00:00Z',
      updatedAt: '2026-01-07T11:00:00Z',
      status: 'active',
      ...c,
    })) as ReviewComment[],
  };
  return p;
}

describe('writing comments on lines (UI-25)', () => {
  it('selects a range with Shift and adds a comment, kept in the browser as a file', async () => {
    await pick('line 44', { scope: card(SERVICE) });
    await pick('line 46', { shift: true, scope: card(SERVICE) });
    expect(text()).toContain('Comment on lines 44–46');
    expect(card(SERVICE).querySelectorAll('.ln.sel')).toHaveLength(3);
    expect(button('Add comment').hasAttribute('disabled')).toBe(true);
    await type('Send **first**?');
    await click('Add comment');

    const [t] = threads();
    expect(t!.querySelector('.thread-where')!.textContent).toBe('Lines 44–46');
    expect(t!.querySelector('strong')!.textContent).toBe('first');
    // A plain file cannot save: the comment is a draft in this browser.
    expect(t!.textContent).toContain('Not saved');
    expect(root.querySelector('.save-pill')!.textContent).toBe('Not saved · plain file');
    const draft = JSON.parse(localStorage.getItem(draftKey(plan))!);
    expect(draft.review.comments[0]).toMatchObject({
      body: 'Send **first**?',
      anchor: { path: SERVICE, side: 'new', startLine: 44, line: 46 },
      snippet: [{ kind: 'add', newNo: 44 }, { newNo: 45 }, { newNo: 46 }],
      status: 'active',
    });
    expect([...root.querySelectorAll('.tab')].at(-1)!.textContent).toBe('Comments1');
    expect(card(SERVICE).querySelector('.cnote')!.textContent).toBe('1 comment');
  });

  it('keeps the drafts of a plain file after a reload', async () => {
    await pick('line 52', { scope: card(SERVICE) });
    await type('Unknown token?');
    await click('Add comment');
    show(plan, '#g1:service', { keepStorage: true });
    expect(threads()[0]!.textContent).toContain('Unknown token?');
    expect(threads()[0]!.textContent).toContain('Not saved');
  });

  it('cancels with the button and with Escape', async () => {
    await pick('line 45', { scope: card(SERVICE) });
    await click('Cancel');
    expect(root.querySelector('.composer')).toBeNull();
    await pick('line 45', { scope: card(SERVICE) });
    await act(() => {
      root
        .querySelector('textarea')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(root.querySelector('.composer')).toBeNull();
  });

  it('formats with the toolbar and previews the Markdown', async () => {
    await pick('line 45', { scope: card(SERVICE) });
    const area = root.querySelector('textarea')!;
    await type('use update');
    area.setSelectionRange(4, 10);
    await press(root.querySelector('[aria-label="Code"]'));
    expect(root.querySelector('textarea')!.value).toBe('use `update`');
    await press(root.querySelector('[aria-label="Bulleted list"]'));
    expect(root.querySelector('textarea')!.value).toBe('- use `update`');
    await click('Preview');
    expect(root.querySelector('.editor-preview li code')!.textContent).toBe('update');
  });

  it('comments on a whole file from its header', async () => {
    await press(card(SERVICE).querySelector('.file-comment-btn'));
    expect(text()).toContain('Comment on the file');
    await type('Needs a test for a used token.');
    await click('Add comment');
    expect(threads()[0]!.querySelector('.thread-where')!.textContent).toBe('File comment');
  });
});

describe('editing, deleting, hiding', () => {
  beforeEach(() => show(seeded([{}, { id: 'c-1', body: 'Second' }])));

  it('edits a comment in place', async () => {
    await press(threads()[0]!.querySelector('.link-btn:nth-of-type(2)'));
    expect(threads()[0]!.querySelector('textarea')!.value).toBe('Why?');
    await type('Why now?', threads()[0]!.querySelector('textarea')!);
    await click('Save');
    expect(threads()[0]!.textContent).toContain('Why now?');
    expect(threads()[0]!.textContent).toContain('edited');
  });

  it('deletes without asking and undoes from the toast', async () => {
    await press(
      [...threads()[0]!.querySelectorAll('.link-btn')].find((b) => b.textContent === 'Delete'),
    );
    expect(threads()).toHaveLength(1);
    expect(root.querySelector('.toast')!.textContent).toBe('Comment deletedUndo');
    await click('Undo');
    expect(threads().map((t) => t.querySelector('.thread-body')!.textContent)).toEqual([
      'Why?',
      'Second',
    ]);
    expect(root.querySelector('.toast')).toBeNull();
  });

  it('hides every comment, or one, and shows them again from the line', async () => {
    await click('Hide comments');
    expect(threads()).toHaveLength(0);
    expect(button(/^Show comments \(2\)$/)).toBeDefined();
    const badge = card(SERVICE).querySelector('.hidden-badge')!;
    expect(badge.getAttribute('aria-label')).toBe('2 hidden comments on line 46: show');
    await press(badge);
    expect(threads()).toHaveLength(2);

    await press(
      [...threads()[1]!.querySelectorAll('.link-btn')].find((b) => b.textContent === 'Hide'),
    );
    expect(threads()).toHaveLength(1);
    expect(card(SERVICE).querySelector('.hidden-badge')!.textContent).toBe('1');
    // Hiding is not remembered: a new page shows everything.
    show(seeded([{}, { id: 'c-1', body: 'Second' }]), '#g1:service');
    expect(threads()).toHaveLength(2);
  });

  it('shows comment text as safe Markdown: no HTML, images as links (UI-15)', () => {
    show(
      seeded([
        {
          body: 'Look <script>alert(1)</script> ![shot](https://x/a.png) [x](javascript:alert(1))\nnext line',
        },
      ]),
    );
    const body = threads()[0]!.querySelector('.thread-body')!;
    expect(body.querySelector('script, img')).toBeNull();
    expect(body.textContent).toContain('<script>alert(1)</script>');
    expect(body.querySelector('a.md-image')!.getAttribute('href')).toBe('https://x/a.png');
    expect(body.querySelector('a.md-image')!.textContent).toBe('Image: shot');
    expect(body.innerHTML).not.toContain('javascript:');
    expect(body.querySelectorAll('br')).toHaveLength(1);
  });
});

describe('Changes tab comments', () => {
  it('shows comments under their lines, and comments in the old column of split', async () => {
    show(seeded([{}]), '#changes');
    const file = () =>
      [...root.querySelectorAll('.gh-file')].find((f) => f.getAttribute('aria-label') === SERVICE)!;
    expect(file().querySelector('.thread.gh')!.textContent).toContain('Why?');
    await click('Split');
    // Old line 1 of the first hunk, in the left column.
    await pick('old line 1', { scope: file() });
    expect(text()).toContain('Comment on old line 1');
    await type('Unused now?');
    await click('Add comment');
    const draft = JSON.parse(localStorage.getItem(draftKey(plan))!);
    expect(draft.review.comments.at(-1).anchor).toMatchObject({ side: 'old', line: 1 });
    expect(file().querySelectorAll('.sr-below .thread')).toHaveLength(2);
  });
});

describe('Comments tab (UI-27)', () => {
  it('lists comments by file with their lines and the summary', async () => {
    const outdated = { id: 'c-9', status: 'outdated' as const, body: 'Old' };
    show(seeded([{}, outdated], 'Looks good.'), '#comments');
    expect(root.querySelector('.side-total')!.textContent).toBe('2 comments');
    expect(root.querySelector('#summary-label')).not.toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>('.summary-card textarea')!.value).toBe(
      'Looks good.',
    );
    const cards = [...root.querySelectorAll('.comment-card')];
    expect(cards.map((c) => c.querySelector('.loc')!.textContent)).toEqual([
      'Lines 44–46',
      'Lines 44–46',
    ]);
    expect(cards[0]!.querySelectorAll('.snip-line')).toHaveLength(3);
    expect(cards[1]!.closest('.comment-section')!.classList.contains('outdated')).toBe(true);
    // Filters, and folding a file.
    await press(
      [...root.querySelectorAll('.pill')].find((x) => x.textContent?.startsWith('Outdated')),
    );
    expect(root.querySelector('.comments-title')!.textContent).toBe('Outdated comments');
    await press(root.querySelector('.pill'));
    await press(root.querySelector('.section-toggle'));
    expect(text()).toContain('1 comment hidden');
  });

  it('copies everything as Markdown', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show(seeded([{}], 'Looks good.'), '#comments');
    await click('Copy all as Markdown');
    expect(writeText.mock.calls[0]![0]).toMatch(
      /^Looks good\.\n\n### `src\/auth\/auth.service.ts` lines 44–46\n\n```diff\n/,
    );
  });

  it('clears all comments and the summary only after confirming', async () => {
    show(seeded([{}], 'Looks good.'), '#comments');
    await click('Clear all comments');
    expect(text()).toContain('Delete all 1 comment and the summary?');
    await click('Cancel');
    expect(root.querySelectorAll('.comment-card')).toHaveLength(1);
    await click('Clear all comments');
    await click('Delete');
    expect(text()).toContain('No comments yet');
    expect(root.querySelector<HTMLTextAreaElement>('.summary-card textarea')!.value).toBe('');
  });

  it('tells a plain file how to save', async () => {
    show(plan, '#comments');
    await press(root.querySelector('.save-pill'));
    expect(root.querySelector('.save-pop')!.textContent).toContain('bowi serve');
    await type('Summary', root.querySelector('.summary-card textarea')!);
    expect(root.querySelector('.banner')!.textContent).toContain(
      'The review summary is only in this browser.',
    );
  });
});

describe('served by bowi serve', () => {
  const server: Server = { base: 'http://127.0.0.1:4000', token: 'secret' };

  function fakeServer(saved: Review, { failPut = false } = {}) {
    const calls: { method: string; body?: { review: Review; generatedAt: string } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('http://127.0.0.1:4000/api/review');
        expect((init.headers as Record<string, string>)['X-Bowi-Token']).toBe('secret');
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ method: init.method!, body });
        if (init.method === 'GET') {
          return new Response(
            JSON.stringify({ generatedAt: plan.generatedAt, review: saved, dir: '/r' }),
          );
        }
        if (failPut) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ savedAt: 'now' }));
      }),
    );
    return calls;
  }

  it('loads the saved comments and saves each change into the plan', async () => {
    const saved = seeded([{ body: 'From the plan' }]).review!;
    const calls = fakeServer(saved);
    show(plan, '#g1:service', { server });
    await settle(() => pill() === 'Saved to review-plan.json');
    expect(threads()[0]!.textContent).toContain('From the plan');
    expect(root.querySelector('.save-pill')!.textContent).toBe('Saved to review-plan.json');
    await pick('line 52', { scope: card(SERVICE) });
    await type('Unknown token?');
    await click('Add comment');
    await settle(() => calls.some((c) => c.method === 'PUT') && pill() !== 'Saving…');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body!.generatedAt).toBe(plan.generatedAt);
    expect(put.body!.review.comments.map((c) => c.body)).toEqual([
      'From the plan',
      'Unknown token?',
    ]);
    expect(threads().some((t) => t.textContent?.includes('Not saved'))).toBe(false);
    expect(localStorage.getItem(draftKey(plan))).toBeNull();
  });

  it('finds the server in its own address and loads once', async () => {
    const calls = fakeServer({ body: 'Saved', comments: [] });
    const happy = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    happy.setURL('http://127.0.0.1:4000/?t=secret#g1:service');
    try {
      if (root) render(null, root);
      document.body.innerHTML = '<div id="app"></div>';
      root = document.getElementById('app')!;
      render(<App plan={plan} now={NOW} />, root);
      await settle(() => pill() === 'Saved to review-plan.json');
      await settle();
      expect(root.querySelector('.save-pill')!.textContent).toBe('Saved to review-plan.json');
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    } finally {
      happy.setURL('http://localhost:3000/');
    }
  });

  it('keeps a change in the browser when the server is gone', async () => {
    fakeServer({ body: '', comments: [] }, { failPut: true });
    show(plan, '#g1:service', { server });
    await settle(() => pill() === 'Saved to review-plan.json');
    await pick('line 52', { scope: card(SERVICE) });
    await type('Unknown token?');
    await click('Add comment');
    await settle(() => pill() === 'bowi serve stopped');
    expect(root.querySelector('.save-pill')!.textContent).toBe('bowi serve stopped');
    expect(root.querySelector('.banner')!.textContent).toContain('bowi serve /r');
    expect(threads()[0]!.textContent).toContain('Not saved');
    expect(localStorage.getItem(draftKey(plan))).toContain('Unknown token?');
  });

  it('offers to save drafts written while the report was a plain file', async () => {
    show(plan);
    await pick('line 52', { scope: card(SERVICE) });
    await type('Written offline');
    await click('Add comment');
    const calls = fakeServer({ body: '', comments: [] });
    show(plan, '#g1:service', { keepStorage: true, server });
    await settle(() => !!root.querySelector('.banner'));
    expect(root.querySelector('.banner')!.textContent).toContain(
      '1 change written in this browser is not in review-plan.json yet.',
    );
    await click('Save it');
    await settle(() => calls.some((c) => c.method === 'PUT') && !root.querySelector('.banner'));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body!.review.comments.map((c) => c.body)).toEqual(['Written offline']);
    expect(root.querySelector('.banner')).toBeNull();
  });
});
