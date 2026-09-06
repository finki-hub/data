import {
  base,
  node,
  perfectionist,
  prettier,
  typescript,
  vitest,
} from 'eslint-config-imperium';

const config = [
  {
    ignores: ['coverage/', 'dist/'],
  },
  ...base,
  node,
  typescript,
  prettier,
  perfectionist,
  vitest,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'test/**/*.mjs'],
    rules: {
      camelcase: 'off',
      'perfectionist/sort-classes': 'off',
      'perfectionist/sort-modules': 'off',
      'sonarjs/function-return-type': 'off',
    },
  },
  {
    files: ['directus/extensions/**/*.js'],
    rules: {
      camelcase: 'off',
    },
  },
  {
    files: [
      'directus/extensions/directus-extension-rebuild-derived-data/derive.js',
      'src/workbook-enrollment-reader.ts',
    ],
    rules: {
      'no-new': 'off',
      'security/detect-non-literal-regexp': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      'perfectionist/sort-objects': 'off',
      'vitest/consistent-test-it': 'off',
      'vitest/padding-around-all': 'off',
      'vitest/prefer-strict-boolean-matchers': 'off',
      'vitest/prefer-strict-equal': 'off',
      'vitest/prefer-to-be-falsy': 'off',
      'vitest/require-to-throw-message': 'off',
    },
  },
];

export default config;
