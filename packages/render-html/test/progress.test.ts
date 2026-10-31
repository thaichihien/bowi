// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewPlan } from '@bowi/core';
import {
  diffDigest,
  emptyProgress,
  loadProgress,
  markStep,
  PROGRESS_TTL_MS,
  progressKey,
  saveProgress,
  toggleViewed,
  viewedKey,
} from '../ui/progress.ts';
import { fixturePlan } from './plan.ts';

let plan: ReviewPlan;
const NOW = Date.parse('2026-01-07T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  ({ plan } = await fixturePlan());
});
beforeEach(() => localStorage.clear());

describe('progress key', () => {
  it('names the repository and branch, and changes with the diff', () => {
    expect(progressKey(plan)).toMatch(/^bowi:progress:ev@feature\/email-verification:[0-9a-f]{8}$/);
    const edited = structuredClone(plan);
    edited.hunks[0]!.lines[0]!.text += ' // edited';
    expect(diffDigest(edited)).not.toBe(diffDigest(plan));
    expect(diffDigest(structuredClone(plan))).toBe(diffDigest(plan));
  });
});

describe('viewed and reviewed', () => {
  const files = ['f1', 'f2'];

  it('reviews a step when its last file is viewed, and takes that back', () => {
    let p = toggleViewed(emptyProgress(), 's', 'f1', files);
    expect(p.reviewed.has('s')).toBe(false);
    p = toggleViewed(p, 's', 'f2', files);
    expect(p.reviewed.has('s')).toBe(true);
    p = toggleViewed(p, 's', 'f2', files);
    expect(p.reviewed.has('s')).toBe(false);
    expect([...p.viewed]).toEqual([viewedKey('s', 'f1')]);
  });

  it('never undoes a mark made by hand', () => {
    let p = markStep(emptyProgress(), 's', true);
    p = toggleViewed(p, 's', 'f1', files);
    p = toggleViewed(p, 's', 'f2', files);
    p = toggleViewed(p, 's', 'f2', files);
    expect(p.reviewed.has('s')).toBe(true);
  });

  it('keeps viewed files per step', () => {
    const p = toggleViewed(emptyProgress(), 's1', 'f1', ['f1']);
    expect(p.viewed.has(viewedKey('s1', 'f1'))).toBe(true);
    expect(p.viewed.has(viewedKey('s2', 'f1'))).toBe(false);
  });
});

describe('storage', () => {
  const progress = () =>
    markStep(toggleViewed(emptyProgress(), 's', 'f1', ['f1', 'f2']), 't', true);

  it('saves and loads progress', () => {
    saveProgress('bowi:progress:a', progress(), NOW);
    const loaded = loadProgress('bowi:progress:a', NOW + DAY);
    expect([...loaded.reviewed]).toEqual(['t']);
    expect([...loaded.viewed]).toEqual([viewedKey('s', 'f1')]);
  });

  it('deletes entries not saved for a week, and unreadable ones', () => {
    saveProgress('bowi:progress:old', progress(), NOW - PROGRESS_TTL_MS - 1);
    saveProgress('bowi:progress:recent', progress(), NOW - 6 * DAY);
    localStorage.setItem('bowi:progress:broken', '{');
    localStorage.setItem('other-app', 'kept');
    expect(loadProgress('bowi:progress:old', NOW).reviewed.size).toBe(0);
    expect(localStorage.getItem('bowi:progress:old')).toBeNull();
    expect(localStorage.getItem('bowi:progress:broken')).toBeNull();
    expect(localStorage.getItem('bowi:progress:recent')).not.toBeNull();
    expect(localStorage.getItem('other-app')).toBe('kept');
  });

  it('removes the entry when nothing is left', () => {
    saveProgress('bowi:progress:a', progress(), NOW);
    saveProgress('bowi:progress:a', emptyProgress(), NOW);
    expect(localStorage.getItem('bowi:progress:a')).toBeNull();
  });

  it('works when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadProgress('bowi:progress:a', NOW).reviewed.size).toBe(0);
    expect(() => saveProgress('bowi:progress:a', progress(), NOW)).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
});
