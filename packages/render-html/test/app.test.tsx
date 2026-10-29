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

beforeEach(() => {
  window.location.hash = '';
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  render(<App plan={plan} />, root);
});

const text = () => root.textContent ?? '';
const buttons = () => [...root.querySelectorAll('button')];
const click = (label: string | RegExp) =>
  act(() => {
    const b = buttons().find((x) =>
      typeof label === 'string' ? x.textContent?.trim() === label : label.test(x.textContent ?? ''),
    );
    if (!b)
      throw new Error(
        `No button ${label}: ${buttons()
          .map((x) => x.textContent)
          .join(' | ')}`,
      );
    b.click();
  });

describe('review page', () => {
  it('shows the header, the groups in order and the first step (UI-2, UI-3)', () => {
    expect(root.querySelector('h1')!.textContent).toBe('feature/email-verification');
    expect(text()).toContain('94 lines need careful reading');
    const groups = [...root.querySelectorAll('.grp .grp-title')].map((e) => e.textContent);
    expect(groups).toEqual([
      'New AuthService.verifyEmail() and 9 related changes',
      'Move slugify() from helpers.ts to string.ts',
      'Generated files and formatting',
    ]);
    expect(root.querySelector('.step h3')!.textContent).toBe('Step 1 of 5 · Data shape');
    expect(text()).toContain('Why these changes are grouped');
    expect(text()).toContain('0 / 8 steps');
  });

  it('marks steps reviewed and moves to the next step (UI-11)', async () => {
    await click(/^Next: Services/);
    expect(root.querySelector('.step h3')!.textContent).toBe('Step 2 of 5 · Services');
    expect(text()).toContain('1 / 8 steps');
    await click('Mark as reviewed');
    expect(text()).toContain('2 / 8 steps');
    expect(window.location.hash).toBe('#g1:service');
  });

  it('switches to tests-first order (UI-10)', async () => {
    await click('Tests first');
    await click(/New AuthService.verifyEmail/);
    expect(root.querySelector('.step h3')!.textContent).toBe('Step 1 of 5 · Tests');
  });

  it('shows the moved code with the changed line and its original (UI-6)', async () => {
    await click(/slugify\(\) moved/);
    expect(root.querySelectorAll('.ln.l-x')).toHaveLength(1);
    expect(root.querySelector('.ln.l-x')!.textContent).toContain('[^\\w]+');
    expect(root.querySelector('.ln.l-w')!.textContent).toContain('[^a-z0-9]+');
    expect(root.querySelectorAll('.ln.l-m').length).toBeGreaterThan(4);
  });

  it('collapses noise behind a summary with a raw diff toggle (UI-7)', async () => {
    await click(/Generated filespackage-lock.json/);
    expect(text()).toContain('1 new direct dependency: nodemailer');
    expect(root.querySelectorAll('.ln')).toHaveLength(0);
    await click('Show raw diff');
    expect(root.querySelectorAll('.ln').length).toBeGreaterThan(0);
  });

  it('lists files alphabetically with their place in the reading order (UI-9)', async () => {
    await click('Alphabetical (GitHub)');
    const rows = [...root.querySelectorAll('.row:not(.head)')];
    expect(rows).toHaveLength(11);
    expect(rows[0]!.textContent).toContain('README.md');
    expect(rows[0]!.textContent).toContain('Step 5 of 8');
    await act(() => (rows[5] as HTMLButtonElement).click());
    expect(root.querySelector('.step h3')!.textContent).toBe('Step 1 of 5 · Data shape');
  });
});
