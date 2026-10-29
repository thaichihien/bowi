import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'fixtures/test/**/*.test.ts'],
    // Fixture source trees contain their own *.spec.ts files; they are data, not tests.
    exclude: ['**/node_modules/**', 'fixtures/*/files/**'],
  },
});
