/**
 * Root ESLint config for every workspace package EXCEPT apps/web, which
 * uses `next lint` (its own Next.js-aware config via eslint-config-next).
 * Each package's `eslint src` picks this up via ESLint's normal
 * directory-tree lookup — no per-package config duplication needed.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'node_modules', '*.config.*', 'coverage'],
  rules: {
    // Prefixing with `_` is the convention already used for intentionally
    // unused destructured params in this codebase.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': 'off', // the worker and CLI scripts log intentionally
  },
  overrides: [
    {
      files: ['**/*.test.ts'],
      env: { node: true },
    },
  ],
};
