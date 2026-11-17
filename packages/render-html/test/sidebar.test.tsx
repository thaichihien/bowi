// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewPlan } from '@bowi/core';
import { App } from '../ui/App.tsx';
import { fixturePlan } from './plan.ts';

let plan: ReviewPlan;
let root: HTMLElement;

beforeAll(async () => {
  ({ plan } = await fixturePlan());
});

const show = (hash = '#g1:service', { keepStorage = false } = {}) => {
  if (root) render(null, root);
  if (!keepStorage) localStorage.clear();
  window.location.hash = hash;
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  render(<App plan={plan} now={Date.parse('2026-01-07T12:00:00Z')} />, root);
};
beforeEach(() => show());

const press = (el: Element | undefined | null) => act(() => (el as HTMLElement).click());
const leftTab = (name: 'Steps' | 'Files') =>
  [...root.querySelectorAll('.lswitch [role="tab"]')].find((t) => t.textContent === name)!;
const rows = (scope: string) =>
  [...root.querySelectorAll(`${scope} .frow`)].map((r) => r.textContent?.trim());

describe('Review tab, Steps view (UI-3)', () => {
  it("shows where the current step's files live instead of its subtitle", () => {
    const current = root.querySelector('.step-row.on .step-btn')!;
    expect(current.querySelector('.tree-hint')!.textContent).toBe('2 files');
    expect(current.getAttribute('aria-expanded')).toBe('true');
    expect(rows('#step-files')).toEqual([
      'src',
      'auth',
      'auth.service.ts',
      'mail',
      'mail.service.ts',
    ]);
    // Other steps keep their subtitle and have no tree.
    expect(root.querySelectorAll('.tree-hint')).toHaveLength(1);
  });

  it('hides the tree on a click on the current row, and remembers it on the next step', async () => {
    await press(root.querySelector('.step-row.on .step-btn'));
    expect(root.querySelector('#step-files')).toBeNull();
    show('#g1:api', { keepStorage: true });
    expect(root.querySelector('#step-files')).toBeNull();
    expect(root.querySelector('.step-row.on .tree-hint')).not.toBeNull();
  });

  it("jumps to a file's card and opens it, and folds folders", async () => {
    const seen: string[] = [];
    window.addEventListener('bowi:show-file', (e) => seen.push((e as CustomEvent<string>).detail));
    const file = [...root.querySelectorAll('#step-files button.frow')].find(
      (b) => b.textContent?.trim() === 'mail.service.ts',
    );
    await press(file);
    expect(seen).toHaveLength(1);
    expect(root.querySelector(`#review-file-${seen[0]}`)).not.toBeNull();
    expect(file!.classList.contains('on')).toBe(true);
    await press(
      [...root.querySelectorAll('#step-files .fdir')].find((d) => d.textContent === 'auth'),
    );
    expect(rows('#step-files')).toEqual(['src', 'auth', 'mail', 'mail.service.ts']);
  });
});

describe('Review tab, Files view (UI-3)', () => {
  it('is a remembered tab', async () => {
    await press(leftTab('Files'));
    expect(leftTab('Files').getAttribute('aria-selected')).toBe('true');
    show('#g1:service', { keepStorage: true });
    expect(root.querySelector('.fview')).not.toBeNull();
  });

  it('shows the current step, a pill per step, and the whole pull request', async () => {
    await press(leftTab('Files'));
    const head = root.querySelector('.fv-head')!;
    expect(head.querySelector('.fv-of')!.textContent).toBe('Step 2 of 8 Feature');
    expect(head.querySelector('.fv-title')!.textContent).toBe('Services');
    const pills = [...root.querySelectorAll('.spill')];
    expect(pills.map((p) => p.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(pills[1]!.classList.contains('cur')).toBe(true);
    expect(pills[1]!.className).toContain('kd-service');
    expect(pills[1]!.getAttribute('title')).toBe('Step 2 · Services · Feature');

    const tree = root.querySelector('.fview .ftree-list')!;
    const hit = [...tree.querySelectorAll('.frow.hit')].map(
      (r) => r.querySelector('.tname')!.textContent,
    );
    expect(hit).toEqual(['auth.service.ts', 'mail.service.ts']);
    // Folders without a file of this step start folded; files at the top are all listed.
    const names = [...tree.querySelectorAll('.tname')].map((n) => n.textContent);
    expect(names).toContain('migrations');
    expect(names).not.toContain('1730_add_email_verified.ts');
    expect(names).toContain('README.md');
    const lock = [...tree.querySelectorAll('.frow')].find((r) =>
      r.textContent?.includes('package-lock.json'),
    )!;
    expect(lock.querySelector('.ntag')!.textContent).toBe('noise');
    expect(lock.classList.contains('dim')).toBe(true);
    expect(lock.querySelector('.sb')!.textContent).toBe('7');
  });

  it('goes to a step from its pill or from one of its files', async () => {
    await press(leftTab('Files'));
    await press([...root.querySelectorAll('.spill')][4]);
    expect(root.querySelector('.fv-title')!.textContent).toBe('Docs');
    expect(root.querySelector('.step-head, main')!.textContent).toContain('Docs');
    const lock = [...root.querySelectorAll('.fview button.frow')].find((r) =>
      r.textContent?.includes('package-lock.json'),
    );
    await press(lock);
    expect(root.querySelector('.fv-title')!.textContent).toContain('Generated');
  });

  it('marks reviewed steps on their pill and file chips', async () => {
    await press(root.querySelector('.quick-mark'));
    await press(leftTab('Files'));
    expect(root.querySelectorAll('.spill .pck')).toHaveLength(1);
  });
});
