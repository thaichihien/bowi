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
import type { ReviewPlan } from '@bowi/core';
import { jsonForScript } from './embed.ts';
import { escapeHtml, highlightPlan, type ReadFile } from './highlight.ts';

export { highlightPlan, type ReadFile } from './highlight.ts';
export { jsonForScript } from './embed.ts';

const PLAN_PLACEHOLDER = '"__BOWI_PLAN__"';
const TITLE_PLACEHOLDER = '__BOWI_TITLE__';
// Resolved from the module's path string, not `new URL()`: test DOMs replace the URL global.
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
  const highlighted = options.readFile ? await highlightPlan(plan, options.readFile) : plan;
  const title = `${plan.source.title ?? plan.source.headRef} · Bowi review`;
  // Function replacers: `$` sequences in repository content must not be treated as patterns.
  return template
    .replace(TITLE_PLACEHOLDER, () => escapeHtml(title))
    .replace(PLAN_PLACEHOLDER, () => jsonForScript(highlighted));
}
