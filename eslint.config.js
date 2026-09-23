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
    files: ['src/**/*.ts', 'test/**/*.ts', 'test/**/*.mjs'],
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
      'directus/extensions/directus-extension-rebuild-derived-data/derive.js',
      'directus/flows/count-history-page.cjs',
      'src/migrations/enrollment-rules.ts',
      'src/migrations/labels.ts',
      'src/workbook-enrollment-reader.ts',
    ],
    rules: {
      'no-new': 'off',
      'security/detect-non-literal-regexp': 'off',
    },
  },
  {
    // The restart-recovery scenario restarts the isolated fixture container
    // through Docker when the operator names it in the environment; the
    // scenario runner starts `node --test` on the selected suites.
    files: [
      'test/relational/data-coordination.integration.mjs',
      'test/relational/run-scenarios.mjs',
    ],
    rules: {
      'security/detect-child-process': 'off',
    },
  },
  {
    // The migration report and backup receipt live at operator-named private
    // paths; the CLI tests write and read them in a temporary directory.
    files: [
      'src/migrations/private-files.ts',
      'test/enrollment-proposal.test.ts',
      'test/import-cli.test.ts',
      'test/migration-cli.test.ts',
      'test/relational/lifecycle.integration.mjs',
      'test/relational/migration-preflight.integration.mjs',
      'test/relational/relational-migration.integration.mjs',
      'test/relational/run-scenarios.mjs',
      'test/relational/snapshot-import-helpers.mjs',
      'test/relational/snapshot-import.integration.mjs',
    ],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    // Node 24 ships no Temporal; the CLI entry points stamp the ledger.
    files: ['src/cli.ts', 'src/migrations/cli.ts'],
    rules: {
      'unicorn/prefer-temporal': 'off',
    },
  },
  {
    // The Run Script bodies of the history index Flows are string
    // constants; the suite executes them in node:vm against the shared
    // history vector to prove they split exactly like the bundle; the
    // mapped and legacy enrollment scripts run there against the data
    // chain shapes.
    files: [
      'test/history-index.test.ts',
      'test/legacy-enrollment-helpers.ts',
      'test/legacy-enrollment-templates.test.ts',
      'test/mapped-enrollment-flow.test.ts',
    ],
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
