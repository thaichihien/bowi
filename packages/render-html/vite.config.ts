/**
 * Builds the review page (ui/) into one self-contained file, template/index.html, with all JS
 * and CSS inlined (UI-1). The renderer fills the plan into it at report time.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [viteSingleFile()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: fileURLToPath(new URL('./template', import.meta.url)),
    emptyOutDir: true,
    modulePreload: false,
    reportCompressedSize: false,
  },
  logLevel: 'warn',
});
