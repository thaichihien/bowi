/**
 * Pull request descriptions (Description tab): GitHub-flavored markdown rendered at report time,
 * independent of the host, then sanitized with an allowlist (UI-15).
 *
 * Raw HTML is allowed through the markdown step because PR templates use it (`<details>`,
 * `<!-- comments -->`, `<br>`); the sanitizer then keeps only harmless tags and attributes:
 * no scripts, styles, frames, forms, event handlers or `javascript:` links. Images become links
 * to the image ("Image: <alt>") so the page never loads anything (UI-1). Element ids get
 * GitHub's `user-content-` prefix so they cannot clash with the page's own.
 *
 * Not done (yet): `#123` / `@user` auto-links (host-specific) and `> [!NOTE]` alert boxes.
 */

import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import sanitizeHtml from 'sanitize-html';

const ID_PREFIX = 'user-content-';

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'input', 'details', 'summary',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'a', 'em', 'strong', 'b', 'i', 'del', 's', 'ins', 'mark', 'sub', 'sup', 'kbd', 'samp',
    'small', 'abbr', 'q', 'cite', 'span', 'div', 'section',
  ], // prettier-ignore
  allowedAttributes: {
    '*': ['id', 'align', 'title', 'dir', 'lang'],
    a: ['href', 'name', 'target', 'rel', 'class'],
    input: ['type', 'checked', 'disabled'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    ol: ['start', 'type'],
    details: ['open'],
    h2: ['class'],
    section: ['class'],
  },
  allowedClasses: { a: ['md-image'], h2: ['sr-only'], section: ['footnotes'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  // Only task-list checkboxes.
  exclusiveFilter: (frame) => frame.tag === 'input' && frame.attribs.type !== 'checkbox',
  transformTags: {
    '*': (tagName, attribs) => {
      const out = { ...attribs };
      if (out.id && !out.id.startsWith(ID_PREFIX)) out.id = ID_PREFIX + out.id;
      if (tagName === 'a' && /^https?:/i.test(out.href ?? '')) {
        out.target = '_blank';
        out.rel = 'noopener noreferrer';
      }
      return { tagName, attribs: out };
    },
    img: (_tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        href: attribs.src ?? '',
        class: 'md-image',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      text: `Image: ${attribs.alt || attribs.title || 'image'}`,
    }),
    input: (_tagName, attribs) => ({
      tagName: 'input',
      attribs: {
        type: attribs.type ?? '',
        disabled: '',
        ...('checked' in attribs ? { checked: '' } : {}),
      },
    }),
  },
};

/** Safe HTML for a markdown description; empty for an empty description. */
export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) return '';
  const html = micromark(markdown, {
    allowDangerousHtml: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
  return sanitizeHtml(html, OPTIONS);
}
