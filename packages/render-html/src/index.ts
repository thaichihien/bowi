/**
 * HTML renderer (requirement.md §7.12): turns a ReviewPlan into one self-contained review.html.
 *
 * The page is a Preact app (ui/) built ahead of time into template/index.html with every script
 * and style inlined. Rendering only fills in the highlighted plan and the title: no network
 * requests, no external files (UI-1).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Review, ReviewPlan } from '@bowi/core';
import { jsonForScript } from './embed.ts';
import { escapeHtml, highlightPlan, type ReadFile } from './highlight.ts';
import { renderMarkdown } from './markdown.ts';

export { highlightPlan, type ReadFile } from './highlight.ts';
export { jsonForScript } from './embed.ts';
export { renderMarkdown } from './markdown.ts';

const PLAN_PLACEHOLDER = '"__BOWI_PLAN__"';
const TITLE_PLACEHOLDER = '__BOWI_TITLE__';
// Resolved from the module's path string, not `new URL()`: test DOMs replace the URL global.
// template/ sits one folder above both src/ and the published dist/ (scripts/build-package.ts).
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'template', 'index.html');

export interface RenderOptions {
  /** Reads file versions for syntax highlighting; without it lines are plain text. */
  readFile?: ReadFile;
}

export async function renderHtml(plan: ReviewPlan, options: RenderOptions = {}): Promise<string> {
  const template = await readFile(TEMPLATE, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') {
      throw new Error(
        `The review page template is missing (${TEMPLATE}). Run \`bun run build:ui\` first.`,
      );
    }
    throw e;
  });
  const highlighted = options.readFile ? await highlightPlan(plan, options.readFile) : { ...plan };
  // Like `DiffLine.html`, the rendered description exists only in the page's copy of the plan.
  if (plan.source.description !== undefined) {
    highlighted.source = {
      ...plan.source,
      descriptionHtml: renderMarkdown(plan.source.description),
    };
  }
  const title = `${plan.source.title ?? plan.source.headRef} · Bowi review`;
  // Function replacers: `$` sequences in repository content must not be treated as patterns.
  return template
    .replace(TITLE_PLACEHOLDER, () => escapeHtml(title))
    .replace(PLAN_PLACEHOLDER, () => jsonForScript(highlighted));
}

const PLAN_SCRIPT = /(<script id="bowi-plan" type="application\/json">)([\s\S]*?)(<\/script>)/;

/** Whether a review.html can show and save comments (written by Bowi 0.2 or later). */
export const supportsComments = (html: string): boolean =>
  html.includes('<meta name="bowi-features" content="comments"');

/**
 * The same page with `review` in its embedded plan replaced, or removed when undefined: how
 * `bowi serve` keeps review.html in step with the comments saved into the plan.
 */
export function withReview(html: string, review: Review | undefined): string {
  const m = PLAN_SCRIPT.exec(html);
  if (!m) throw new Error('This page has no embedded Bowi plan.');
  const plan = JSON.parse(m[2]!) as ReviewPlan;
  if (review) plan.review = review;
  else delete plan.review;
  return html.replace(PLAN_SCRIPT, (_all, open: string, _json, close: string) => {
    return open + jsonForScript(plan) + close;
  });
}
