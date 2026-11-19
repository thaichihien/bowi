import { beforeAll, describe, expect, it } from 'vitest';
import type { ReviewPlan, Snapshot } from '@bowi/core';
import { jsonForScript, renderHtml, renderMarkdown } from '../src/index.ts';
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

describe('renderMarkdown', () => {
  it('renders GitHub-flavored markdown', () => {
    const html = renderMarkdown(
      '## Title\n\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~old~~ https://x.dev\n\n<details><summary>More</summary>\n\nHidden\n</details>',
    );
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<td align="center">2</td>');
    expect(html).toContain('<input type="checkbox" disabled checked /> done');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('<a href="https://x.dev" target="_blank" rel="noopener noreferrer">');
    expect(html).toContain('<details><summary>More</summary>');
    expect(renderMarkdown('  \n')).toBe('');
  });

  it('removes anything that could run code or load from the network (UI-1, UI-15)', () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script>',
        '',
        '<img src="https://x/a.png" onerror="alert(1)" alt="<b>shot</b>">',
        '',
        '![chart](https://x/c.png)',
        '',
        '<a href="javascript:alert(1)" onclick="alert(1)">js</a> <a id="app" href="#x">x</a>',
        '',
        '<iframe src="https://x"></iframe><style>body{}</style><form><input type="text"></form>',
        '',
        '<!-- template comment -->',
        '',
        '<div style="color:red" class="tab on">styled</div>',
      ].join('\n'),
    );
    expect(html).not.toMatch(
      /<script|<img|<iframe|<style|<form|<input|onerror|onclick|javascript:/i,
    );
    expect(html).not.toContain('template comment');
    expect(html).not.toMatch(/style=|class="tab/);
    expect(html).toContain('<a href="https://x/a.png" class="md-image"');
    expect(html).toContain('>Image: &lt;b&gt;shot&lt;/b&gt;</a>');
    expect(html).toContain('>Image: chart</a>');
    expect(html).toContain('id="user-content-app"');
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
    // The markup outside scripts: the bundled code holds strings such as micromark's "<img",
    // whose output the page turns into links before it reaches the document (ui/markdown.ts).
    const markup = html.replace(/(<script[^>]*>)[\s\S]*?<\/script>/g, '$1</script>');
    expect(markup).not.toMatch(/<link\b|<script[^>]+\bsrc=|<img\b|@import|url\(/i);
    // Repository content (e.g. lockfile `resolved` URLs) is data inside the plan, never fetched;
    // check everything else.
    const outsidePlan = html.replace(/<script id="bowi-plan"[^>]*>[\s\S]*?<\/script>/, '');
    const urls = [...outsidePlan.matchAll(/https?:\/\/[^\s"'`<>)]+/g)].map((m) => m[0]);
    // Only XML namespace identifiers inside the bundled UI code, which are never fetched, and
    // links the reviewer clicks (M11): the report's pull request and GitHub's token pages.
    const allowed = (u: string) =>
      u.startsWith('http://www.w3.org/') ||
      u.startsWith('https://github.com/${') ||
      u === 'https://github.com/settings/personal-access-tokens/new' ||
      u === 'https://github.com/settings/tokens/new?scopes=repo&description=Bowi';
    expect(urls.filter((u) => !allowed(u))).toEqual([]);
    // The theme before the first paint (M18), the plan and the page.
    expect(html.match(/<\/script>/g)).toHaveLength(3);
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
    // Both themes on every token (M18): github-light as the color, github-dark in --d.
    expect(anchor.html).toMatch(/^<span style="color:#[0-9A-F]{6};--d:#[0-9A-F]{6}">/);
    // The generated lockfile is not highlighted.
    const lock = page.files.find((f) => f.path === 'package-lock.json')!;
    expect(
      page.hunks
        .filter((h) => h.fileId === lock.id)
        .flatMap((h) => h.lines)
        .some((l) => l.html),
    ).toBe(false);
  });

  it('picks the theme before the first paint, and prints light (M18)', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain("localStorage.getItem('bowi:theme')");
    expect(head).toContain("matchMedia('(prefers-color-scheme: dark)')");
    // The script runs before the page's styles and code, so dark never flashes light.
    expect(head.indexOf('bowi:theme')).toBeLessThan(head.indexOf('<style'));
    expect(html).toMatch(/@media screen\s*\{\s*:root\.dark\s*\{/);
  });

  it('keeps hostile and special text intact (UI-15)', async () => {
    const hostile: ReviewPlan = structuredClone(plan);
    hostile.source.title = '</title><script>alert(1)</script> $& $1';
    hostile.hunks[0]!.lines[0]!.text = "</script><!-- $& $` $'";
    const page = await renderHtml(hostile);
    expect(page).toContain(
      '<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; $1 · Bowi review</title>',
    );
    expect(page.match(/<\/script>/g)).toHaveLength(3);
    expect(embedded(page).hunks[0]!.lines[0]!.text).toBe("</script><!-- $& $` $'");
  });

  it('renders the description of a pull request into the page only', async () => {
    const pr: ReviewPlan = structuredClone(plan);
    pr.source.kind = 'github';
    pr.source.description = '**Hi** </script><script>alert(1)</script>';
    const page = await renderHtml(pr);
    expect(embedded(page).source.descriptionHtml).toBe(
      '<p><strong>Hi</strong> &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(page.match(/<\/script>/g)).toHaveLength(3);
    expect(pr.source.descriptionHtml).toBeUndefined();
    expect(embedded(await renderHtml(plan)).source.descriptionHtml).toBeUndefined();
  });

  it('renders plain text lines without a snapshot', async () => {
    const page = embedded(await renderHtml(plan));
    expect(page.hunks.flatMap((h) => h.lines).some((l) => l.html !== undefined)).toBe(false);
  });
});
