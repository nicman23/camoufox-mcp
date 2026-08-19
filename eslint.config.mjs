// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  // Optionally, restrict to TypeScript files only
  {
    files: ['**/*.ts'],
    rules: {
      // Honor the leading-underscore convention for intentionally-unused
      // params/vars (e.g. stub signatures kept for API compatibility).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  }
);