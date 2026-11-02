import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The review page's UI tests render Preact components.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    // Integration tests build git repositories and run the whole pipeline; on a busy machine
    // they need more than the 5 s default. Windows starts processes far more slowly (each git
    // call can take hundreds of milliseconds there).
    testTimeout: process.platform === 'win32' ? 180_000 : 30_000,
    hookTimeout: process.platform === 'win32' ? 300_000 : 60_000,
    include: [
      'packages/*/test/**/*.test.{ts,tsx}',
      'fixtures/test/**/*.test.ts',
      'bench/test/**/*.test.ts',
    ],
    // Fixture source trees contain their own *.spec.ts files; they are data, not tests.
    exclude: ['**/node_modules/**', 'fixtures/*/files/**'],
  },
});
