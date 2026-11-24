/**
 * Builds the review page (ui/) into one self-contained file, template/index.html, with all JS
 * and CSS inlined (UI-1). The renderer fills the plan into it at report time.
 *
 * `vite` (dev server, `bun run dev:ui`) serves the page with hot reload for working on the UI. It
 * takes the plan from an existing report: BOWI_REPORT=<review.html> (absolute, or relative to the
 * repository root), whose embedded plan already carries the highlighting.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const PLAN_SCRIPT = /<script id="bowi-plan" type="application\/json">([\s\S]*?)<\/script>/;

/** Dev server only: fills the plan of BOWI_REPORT into the page. */
function planFromReport(): Plugin {
  return {
    name: 'bowi-plan-from-report',
    apply: 'serve',
    transformIndexHtml(html) {
      const file = process.env.BOWI_REPORT;
      if (!file) {
        console.warn('BOWI_REPORT is not set: the page has no plan. Point it at a review.html.');
        return html;
      }
      // Relative to the repository root, where `bun run` runs scripts. Read on every page load,
      // so regenerating the report and reloading the page shows the new plan.
      const path = resolve(fileURLToPath(new URL('../..', import.meta.url)), file);
      const report = readFileSync(path, 'utf8');
      const plan = PLAN_SCRIPT.exec(report)?.[1];
      if (!plan) throw new Error(`${path} has no embedded plan; is it a Bowi review.html?`);
      const title = /<title>([^<]*)<\/title>/.exec(report)?.[1] ?? 'Bowi review';
      return html
        .replace('__BOWI_TITLE__', () => title)
        .replace(
          PLAN_SCRIPT,
          () => `<script id="bowi-plan" type="application/json">${plan}</script>`,
        );
    },
  };
}

/**
 * Inlines the favicon as a data URI: Vite keeps an `<link rel="icon">` file separate, and the page
 * makes no requests (UI-1). `favicon.webp` is the Bowi icon, 64 px.
 */
function inlineFavicon(): Plugin {
  return {
    name: 'bowi-inline-favicon',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const icon = readFileSync(fileURLToPath(new URL('./ui/favicon.webp', import.meta.url)));
        const uri = `data:image/webp;base64,${icon.toString('base64')}`;
        return html.replace('href="./favicon.webp"', () => `href="${uri}"`);
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [inlineFavicon(), viteSingleFile(), planFromReport()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: fileURLToPath(new URL('./template', import.meta.url)),
    emptyOutDir: true,
    modulePreload: false,
    reportCompressedSize: false,
  },
  logLevel: 'warn',
});
