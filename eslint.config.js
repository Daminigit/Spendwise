// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
    ignores: ['dist/', 'node_modules/'],
  },
  {
    // Client-side scripts served to the browser
    files: ['src/web/public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  }
);

