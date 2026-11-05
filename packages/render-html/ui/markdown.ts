/**
 * Comment text as GitHub-flavored Markdown, rendered in the page (UI-26; the description is
 * rendered at report time instead, src/markdown.ts).
 *
 * Comments are written in the page, so they cannot wait for a report run. micromark runs with
 * raw HTML off: tags in a comment show as text, and links with `javascript:` and other unsafe
 * schemes lose their address. Images become links to the image, so the page never loads anything
 * (UI-1); a single line break is a line break, as in GitHub comments.
 */

import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

const BLOCKS_WITH_TEXT = 'p, li, blockquote, td, th';

export function commentHtml(markdown: string): string {
  const html = micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  // A template's content is inert: nothing in it loads while it is rewritten.
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const img of [...t.content.querySelectorAll('img')]) {
    const a = document.createElement('a');
    a.setAttribute('href', img.getAttribute('src') ?? '');
    a.className = 'md-image';
    a.textContent = `Image: ${img.getAttribute('alt') || 'image'}`;
    img.replaceWith(a);
  }
  for (const a of t.content.querySelectorAll('a[href]')) {
    if (/^https?:/i.test(a.getAttribute('href') ?? '')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  for (const block of t.content.querySelectorAll(BLOCKS_WITH_TEXT)) breakLines(block);
  return t.innerHTML;
}

/** Turns newlines inside a paragraph's text into `<br>`, leaving code alone. */
function breakLines(el: Element): void {
  for (const node of [...el.childNodes]) {
    if (node.nodeType === 1) {
      const tag = (node as Element).tagName;
      if (tag !== 'CODE' && tag !== 'PRE' && !(node as Element).matches(BLOCKS_WITH_TEXT))
        breakLines(node as Element);
      continue;
    }
    if (node.nodeType !== 3 || !node.textContent?.includes('\n')) continue;
    // Newlines next to a block (a loose list item's paragraphs) only separate the HTML.
    if (isBlock(node.previousSibling) || isBlock(node.nextSibling)) continue;
    const parts = node.textContent.split('\n');
    const frag = document.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i > 0) frag.append(document.createElement('br'));
      if (part) frag.append(part);
    });
    // A newline at the very end of a block is not a break.
    if (!parts.at(-1) && !node.nextSibling) frag.lastChild?.remove();
    node.replaceWith(frag);
  }
}

const isBlock = (n: Node | null) =>
  n?.nodeType === 1 &&
  /^(P|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|DIV|HR|H[1-6])$/.test((n as Element).tagName);
