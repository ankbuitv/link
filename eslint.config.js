// ESLint flat config — minimal rules for a Workers TypeScript project.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.wrangler/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['public/assets/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly', window: 'readonly', location: 'readonly', history: 'readonly',
        navigator: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', confirm: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
