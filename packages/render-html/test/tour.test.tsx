// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewPlan } from '@bowi/core';
import { App } from '../ui/App.tsx';
import { fixturePlan } from './plan.ts';

let plan: ReviewPlan;
let root: HTMLElement;
const NOW = Date.parse('2026-01-07T12:00:00Z');
const SERVICE = 'src/auth/auth.service.ts';

beforeAll(async () => {
  ({ plan } = await fixturePlan());
});

const show = (p: ReviewPlan, hash = '#g1:service') => {
  if (root) render(null, root);
  localStorage.clear();
  window.location.hash = hash;
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  render(<App plan={p} now={NOW} />, root);
};

beforeEach(() => show(plan));

const press = (el: Element | undefined | null) => act(() => (el as HTMLElement).click());
const click = (label: string, scope: ParentNode = root) => {
  const b = [...scope.querySelectorAll('button')].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`No button ${label}`);
  return press(b);
};
const tour = () => root.querySelector<HTMLElement>('.tour');
const shown = () => tour()!.querySelector('.tour-fh .path')!.getAttribute('title');
const position = () => tour()!.querySelector('.tour-pos')!.textContent;
const key = (k: string, target: Element = tour()!) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const open = async () => {
  await click('Focus tour');
  expect(tour()).not.toBeNull();
};

describe('Focus tour (M20)', () => {
  it('opens at the first file of the current step, with its group and step on top', async () => {
    await open();
    expect(shown()).toBe('src/mail/mail.service.ts');
    expect(position()).toMatch(/^3 of 11/);
    const head = tour()!.querySelector('.tour-head')!.textContent;
    expect(head).toContain('Step 2 of 8 · Services');
    expect(head).toContain('New AuthService.verifyEmail() and 10 related changes');
    expect(head).toContain('Symbols: 8 new, 3 changed inside; across 7 files.');
    // The group title keeps its code as code.
    expect(tour()!.querySelector('.tour-title code')!.textContent).toBe(
      'AuthService.verifyEmail()',
    );
  });

  it('goes through every file once, in reading order, then finishes the review', async () => {
    show(plan, '#g1:data');
    await open();
    const seen: string[] = [];
    for (;;) {
      seen.push(shown()!);
      const next = tour()!.querySelector('.tour-foot .btn.primary')!;
      if (next.textContent?.trim() === 'Finish review') break;
      await press(next);
    }
    expect(seen).toEqual([
      'src/migrations/1730_add_email_verified.ts',
      'src/users/user.entity.ts',
      'src/mail/mail.service.ts',
      SERVICE,
      'src/auth/auth.controller.ts',
      'test/auth.service.spec.ts',
      'README.md',
      'src/utils/string.ts',
      'src/utils/helpers.ts',
      'package-lock.json',
      'src/utils/date.ts',
    ]);
    expect(new Set(seen).size).toBe(plan.files.length);
    // A step's notes: what moved where for moved code, a short line for noise.
    await press(tour()!.querySelector('.tour-foot .btn:not(.primary)'));
    expect(tour()!.querySelector('.tour-note')!.textContent).toBe(
      'Changes you usually do not need to read line by line.',
    );
    await key('ArrowLeft');
    await key('ArrowLeft');
    expect(tour()!.querySelector('.tour-note')!.textContent).toBe(
      'slugify() moves from helpers.ts to string.ts, with 1 line changed on the way.',
    );
    await key('ArrowRight');
    await key('ArrowRight');
    await key('ArrowRight');
    // The last file has "Finish review", as the step bar does: the tour closes and the same
    // dialog opens, complete since every step was gone through with Next.
    await click('Finish review', tour()!);
    expect(tour()).toBeNull();
    expect(root.querySelector('.progress')!.textContent).toContain('All 8 steps reviewed');
    expect(root.querySelector('.dialog.done')!.textContent).toContain('Review complete');
  });

  it('marks a step reviewed when going on from its last file, and says so first', async () => {
    await open();
    const next = () => tour()!.querySelector('.tour-foot .btn.primary')!.textContent?.trim();
    const reviewedCount = () => root.querySelector('.progress strong')!.textContent;
    // mail.service.ts is not the last file of Services.
    expect(next()).toBe('Next: auth.service.ts');
    await key('ArrowRight');
    expect(next()).toBe('Mark Services reviewed · Next: auth.controller.ts');
    expect(reviewedCount()).toBe('0 of 8');
    await key('ArrowRight');
    expect(reviewedCount()).toBe('1 of 8');
    // Going back shows the step as reviewed; going on again marks nothing twice.
    await key('ArrowLeft');
    expect(tour()!.querySelector('.tour-meta')!.textContent).toContain('Reviewed');
    expect(next()).toBe('Next: auth.controller.ts');
    await key('ArrowRight');
    expect(next()).toBe('Mark Auth controller reviewed · Next: auth.service.spec.ts');
    // Jumping from the tree is not going through: nothing is marked.
    await press(
      [...tour()!.querySelectorAll('.tour-tree button.frow')].find(
        (b) => b.textContent === 'README.md',
      ),
    );
    expect(reviewedCount()).toBe('1 of 8');
  });

  it('finishes with the steps still to review when it started midway', async () => {
    await open();
    for (let i = 0; i < 20 && position()!.startsWith('11 of') === false; i++)
      await key('ArrowRight');
    await click('Finish review', tour()!);
    expect(tour()).toBeNull();
    // The data step (before where the tour started) is still to review.
    expect(root.querySelector('.dialog')!.textContent).toContain('Data shape');
    expect(root.querySelector('.dialog.done')).toBeNull();
  });

  it('ends with the files that have no diff, which are in no step', async () => {
    const renamed = structuredClone(plan);
    renamed.files.push({
      ...renamed.files[0]!,
      id: 'f99',
      path: 'docs/old-notes.md',
      oldPath: 'notes.md',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    });
    show(renamed);
    await open();
    for (
      let i = 0;
      i < 20 &&
      tour()!.querySelector('.tour-foot .btn.primary')!.textContent?.trim() !== 'Finish review';
      i++
    )
      await key('ArrowRight');
    expect(shown()).toBe('docs/old-notes.md');
    expect(position()).toMatch(/^12 of 12/);
    expect(tour()!.querySelector('.tour-title')!.textContent).toBe('Files without a diff');
    expect(tour()!.querySelector('.tfh-sub')!.textContent).toContain('Renamed from notes.md');
    expect(tour()!.querySelector('.tour-msg')!.textContent).toBe('File renamed without changes.');
  });

  it('shows the whole tree folded but for the current file, and jumps from it', async () => {
    await open();
    const tree = () => tour()!.querySelector('.tour-tree')!;
    const openDirs = () =>
      [...tree().querySelectorAll('.fdir[aria-expanded="true"]')].map((d) => d.textContent);
    expect(openDirs()).toEqual(['src', 'mail']);
    expect(tree().querySelector('.tour-on')!.textContent).toBe('mail.service.ts');
    // Root files always show.
    expect(tree().textContent).toContain('README.md');
    expect(tree().textContent).toContain('package-lock.json');
    await press(
      [...tree().querySelectorAll('button.frow')].find((b) => b.textContent === 'README.md'),
    );
    expect(shown()).toBe('README.md');
    expect(openDirs()).toEqual([]);
  });

  it('moves with the arrow keys and closes with Esc, never while typing', async () => {
    await open();
    await key('ArrowRight');
    expect(shown()).toBe(SERVICE);
    await key('ArrowLeft');
    expect(shown()).toBe('src/mail/mail.service.ts');
    // The page's own keys (j / k) wait while the tour is open.
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    });
    expect(window.location.hash).toBe('#g1:service');
    // Writing a comment: the arrows and Esc belong to the text.
    await press(tour()!.querySelector('.tour .add-comment'));
    const area = tour()!.querySelector('textarea')!;
    await key('ArrowRight', area);
    expect(shown()).toBe('src/mail/mail.service.ts');
    await key('Escape', area);
    expect(tour()).not.toBeNull();
    expect(tour()!.querySelector('.composer')).toBeNull();
    await key('Escape');
    expect(tour()).toBeNull();
  });

  it('writes the same comments as the step view, with the box only in front', async () => {
    await open();
    await key('ArrowRight');
    expect(shown()).toBe(SERVICE);
    const plus = [...tour()!.querySelectorAll('.add-comment')].find(
      (b) => b.getAttribute('aria-label') === 'Comment on line 44',
    )!;
    await act(() => {
      plus.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    // The step view behind shows the same file, but the box is only in the tour.
    expect(tour()!.querySelectorAll('.composer')).toHaveLength(1);
    expect(root.querySelectorAll('.composer')).toHaveLength(1);
    const area = tour()!.querySelector('textarea')!;
    await act(() => {
      area.value = 'Should this expire?';
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Add comment', tour()!);
    expect(tour()!.querySelector('.thread')!.textContent).toContain('Should this expire?');
    await key('Escape');
    const card = [...root.querySelectorAll('.card.file')].find(
      (c) => c.querySelector('.path')?.getAttribute('title') === SERVICE,
    )!;
    expect(card.querySelector('.thread')!.textContent).toContain('Should this expire?');
  });

  it('cuts long file names in the middle, with the full name on hover', async () => {
    const long = structuredClone(plan);
    const file = long.files.find((f) => f.path === 'src/mail/mail.service.ts')!;
    file.path = 'src/mail/a-very-long-mail-service-name-for-verification.service.ts';
    show(long);
    await open();
    const name = tour()!.querySelector('.tour-fh .path-name')!;
    expect(name.getAttribute('title')).toBe(
      'a-very-long-mail-service-name-for-verification.service.ts',
    );
    expect(name.querySelector('.mb')!.textContent).toBe('ervice.ts');
    expect(tour()!.querySelector('.tour-on .mb')!.textContent).toBe('ervice.ts');
  });
});
