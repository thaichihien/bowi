import { beforeAll, describe, expect, it } from 'vitest';
import type { ReviewPlan, Snapshot } from '@bowi/core';
import { jsonForScript, renderHtml } from '../src/index.ts';
import { fixturePlan } from './plan.ts';

const embedded = (html: string): ReviewPlan => {
  const start = html.indexOf('<script id="bowi-plan" type="application/json">');
  const body = html.slice(start).replace(/^<script[^>]*>/, '');
  return JSON.parse(body.slice(0, body.indexOf('</script>')));
};

describe('jsonForScript', () => {
  it('cannot be broken out of by repository content', () => {
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const nasty = { text: `</script><script>alert(1)</script><!-- & ${LS} ${PS}` };
    const json = jsonForScript(nasty);
    for (const c of ['<', '>', '&', LS, PS]) expect(json.includes(c)).toBe(false);
    expect(JSON.parse(json)).toEqual(nasty);
  });
});

describe('renderHtml', () => {
  let plan: ReviewPlan;
  let snapshot: Snapshot;
  let html: string;

  beforeAll(async () => {
    ({ plan, snapshot } = await fixturePlan());
    html = await renderHtml(plan, { readFile: (v, p) => snapshot.readFile(v, p) });
  });

  it('is one self-contained page that loads nothing from the network (UI-1)', () => {
    expect(html).not.toMatch(/<link\b|<script[^>]+\bsrc=|<img\b|@import|url\(/i);
    // Repository content (e.g. lockfile `resolved` URLs) is data inside the plan, never fetched;
    // check everything else.
    const outsidePlan = html.replace(/<script id="bowi-plan"[^>]*>[\s\S]*?<\/script>/, '');
    const urls = [...outsidePlan.matchAll(/https?:\/\/[^\s"'`<>)]+/g)].map((m) => m[0]);
    // Only XML namespace identifiers inside the bundled UI code, which are never fetched.
    expect(urls.every((u) => u.startsWith('http://www.w3.org/'))).toBe(true);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it('embeds the plan with build-time highlighting (UI-14)', () => {
    const page = embedded(html);
    expect(page.groups).toEqual(plan.groups);
    const mail = page.files.find((f) => f.path === 'src/mail/mail.service.ts')!;
    const lines = page.hunks.filter((h) => h.fileId === mail.id).flatMap((h) => h.lines);
    const anchor = lines.find((l) => l.text.includes('<a href='))!;
    expect(anchor.html).toContain('&lt;a href=');
    expect(anchor.html).not.toContain('<a ');
    expect(lines.every((l) => typeof l.html === 'string')).toBe(true);
    // The generated lockfile is not highlighted.
    const lock = page.files.find((f) => f.path === 'package-lock.json')!;
    expect(
      page.hunks
        .filter((h) => h.fileId === lock.id)
        .flatMap((h) => h.lines)
        .some((l) => l.html),
    ).toBe(false);
  });

  it('keeps hostile and special text intact (UI-15)', async () => {
    const hostile: ReviewPlan = structuredClone(plan);
    hostile.source.title = '</title><script>alert(1)</script> $& $1';
    hostile.hunks[0]!.lines[0]!.text = "</script><!-- $& $` $'";
    const page = await renderHtml(hostile);
    expect(page).toContain(
      '<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; $1 · Bowi review</title>',
    );
    expect(page.match(/<\/script>/g)).toHaveLength(2);
    expect(embedded(page).hunks[0]!.lines[0]!.text).toBe("</script><!-- $& $` $'");
  });

  it('renders plain text lines without a snapshot', async () => {
    const page = embedded(await renderHtml(plan));
    expect(page.hunks.flatMap((h) => h.lines).some((l) => l.html !== undefined)).toBe(false);
  });
});
