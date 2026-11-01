import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'build/**', 'fixtures/*/files/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Bowi must run on Node; Bun is only the dev tool (requirement.md §11.3).
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'Use node: APIs; the CLI targets Node.' },
      ],
    },
  },
);
