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
    ignores: ['coverage/', '**/dist/'],
  },
  ...base,
  node,
  typescript,
  prettier,
  perfectionist,
  vitest,
  {
    rules: {
      // `cond ? [value] : []` filters and maps in one pass while narrowing
      // the type, which filter().map() cannot.
      'unicorn/no-unnecessary-array-flat-map': 'off',
      // Small helpers keep their inputs explicit even with one caller.
      'unicorn/no-unnecessary-parameters': 'off',
      // Conditions are ordered to narrow types for the ones after them.
      'unicorn/prefer-simple-condition-first': 'off',
      // Type aliases are declared at module level, beside the code they
      // describe.
      'unicorn/prefer-smaller-scope': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      camelcase: 'off',
      'perfectionist/sort-classes': 'off',
      'perfectionist/sort-modules': 'off',
      'sonarjs/function-return-type': 'off',
    },
  },
  {
    // Flow scripts answer Directus field names such as academic_year.
    files: ['directus/extensions/**/*.js', 'directus/flows/**/*.cjs'],
    rules: {
      camelcase: 'off',
    },
  },
  {
    files: [
      'directus/extensions/directus-extension-course-search/src/**/*.ts',
      'directus/extensions/directus-extension-data-operations/src/**/*.ts',
    ],
    rules: {
      camelcase: 'off',
    },
  },
  {
    files: [
      'directus/extensions/directus-extension-course-search/src/index.ts',
    ],
    rules: {
      'perfectionist/sort-object-types': 'off',
      'perfectionist/sort-objects': 'off',
      'perfectionist/sort-union-types': 'off',
    },
  },
  {
    files: [
      'directus/extensions/directus-extension-course-search/src/endpoint.ts',
    ],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      'n/callback-return': 'off',
    },
  },
  {
    files: [
      'directus/extensions/directus-extension-data-operations/src/enrollment-lines.ts',
      'directus/flows/match-history-lines.cjs',
      'test/curriculum-code.test.ts',
    ],
    rules: {
      'no-new': 'off',
      'security/detect-non-literal-regexp': 'off',
    },
  },
  {
    // Branding uploads its two repository-owned assets, named by a closed
    // union of file names.
    files: ['src/branding.ts'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    // The committed expected exports are read by case and file name from
    // their fixture directory.
    files: ['test/expected-exports.ts'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    // The Run Script bodies of the history index Flows are string
    // constants; the suite executes them in node:vm against the shared
    // history vector to prove they split exactly like the bundle; the
    // enrollment scripts run there against the data chain shapes.
    files: ['test/flow-script-helpers.ts', 'test/history-index.test.ts'],
    rules: {
      'sonarjs/code-eval': 'off',
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
