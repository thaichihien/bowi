/**
 * Build-time syntax highlighting (UI-14): fills `DiffLine.html` with shiki output, so the page
 * runs no highlighter. Whole file versions are tokenized (multi-line strings and comments stay
 * correct); each diff line takes the tokens of its line on its own side.
 *
 * Each token carries both themes (M18): `color` is github-light and `--d` github-dark, which the
 * page's dark mode switches to, so changing the theme needs no second highlighting.
 *
 * Every token is HTML-escaped here; `html` is the only field the page renders as markup (UI-15).
 */

import {
  bundledLanguagesInfo,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from 'shiki';
import type { DiffLine, FileChange, ReviewPlan } from '@bowi/core';

export const THEMES = { light: 'github-light', dark: 'github-dark' } as const;
/** Larger file versions are left unhighlighted (plain text). */
const MAX_HIGHLIGHT_BYTES = 300_000;

export type ReadFile = (version: 'old' | 'new', path: string) => Promise<string | null>;

let highlighter: Promise<Highlighter> | undefined;

/** Returns a copy of the plan with `html` on the lines of every highlightable file. */
export async function highlightPlan(plan: ReviewPlan, readFile: ReadFile): Promise<ReviewPlan> {
  const out: ReviewPlan = {
    ...plan,
    hunks: plan.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l })) })),
  };
  const hunksByFile = new Map<string, typeof out.hunks>();
  for (const h of out.hunks) hunksByFile.set(h.fileId, [...(hunksByFile.get(h.fileId) ?? []), h]);

  for (const file of plan.files) {
    const hunks = hunksByFile.get(file.id);
    const lang = languageOf(file);
    if (!hunks || !lang || file.generated) continue;
    const h = await getHighlighter(lang);
    const lineHtml = async (version: 'old' | 'new') => {
      const text = await readFile(
        version,
        version === 'old' ? (file.oldPath ?? file.path) : file.path,
      );
      if (text === null || Buffer.byteLength(text) > MAX_HIGHLIGHT_BYTES) return null;
      return h
        .codeToTokens(text, { lang, themes: THEMES, defaultColor: false })
        .tokens.map((tokens) => tokens.map((t) => tokenHtml(t.htmlStyle, t.content)).join(''));
    };
    const oldLines = file.status === 'added' ? null : await lineHtml('old');
    const newLines = file.status === 'deleted' ? null : await lineHtml('new');
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        const html = pick(line, oldLines, newLines);
        if (html !== undefined) line.html = html;
      }
    }
  }
  return out;
}

/** `defaultColor: false` gives `--shiki-light` and `--shiki-dark`; a missing one inherits. */
function tokenHtml(style: Record<string, string> | undefined, content: string): string {
  const light = style?.['--shiki-light'];
  const dark = style?.['--shiki-dark'];
  const css = [light && `color:${light}`, dark && `--d:${dark}`].filter(Boolean).join(';');
  return `<span${css ? ` style="${css}"` : ''}>${escapeHtml(content)}</span>`;
}

function pick(
  line: DiffLine,
  oldLines: string[] | null,
  newLines: string[] | null,
): string | undefined {
  if (line.kind === 'del') return line.oldNo !== undefined ? oldLines?.[line.oldNo - 1] : undefined;
  return line.newNo !== undefined ? newLines?.[line.newNo - 1] : undefined;
}

async function getHighlighter(lang: BundledLanguage): Promise<Highlighter> {
  highlighter ??= createHighlighter({ themes: Object.values(THEMES), langs: [] });
  const h = await highlighter;
  if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang);
  return h;
}

/** Shiki language for a file by extension or name, if shiki bundles one. */
export function languageOf(file: FileChange): BundledLanguage | undefined {
  const name = file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const info = bundledLanguagesInfo.find((l) => l.id === ext || l.aliases?.includes(ext));
  return info?.id as BundledLanguage | undefined;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
