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
      'directus/flows/count-history-page.cjs',
      'src/migrations/labels.ts',
      'src/workbook-enrollment-reader.ts',
      'test/fixtures/stress-oracle.ts',
      'test/relational-export-helpers.ts',
    ],
    rules: {
      'no-new': 'off',
      'security/detect-non-literal-regexp': 'off',
    },
  },
  {
    // The restart-recovery scenarios restart the isolated fixture container
    // and the automatic processing suite reads PostgreSQL statistics with
    // read-only psql SELECTs, through Docker, when the operator names the
    // containers in the environment; the scenario runner starts
    // `node --test` on the selected suites.
    files: [
      'test/operations-browser-helpers.mjs',
      'test/relational/automatic-processing-helpers.mjs',
      'test/relational/data-coordination.integration.mjs',
      'test/relational/run-scenarios.mjs',
    ],
    rules: {
      'security/detect-child-process': 'off',
    },
  },
  {
    // The suites write and read workbooks, snapshots and screenshots at
    // temporary or operator-named paths.
    files: [
      'test/fixtures/stress-snapshot.ts',
      'test/import-cli.test.ts',
      'test/operations-browser-helpers.mjs',
      'test/operations-browser-steps.mjs',
      'test/operations.browser.mjs',
      'test/relational/export-projection.integration.mjs',
      'test/relational/lifecycle.integration.mjs',
      'test/relational/run-scenarios.mjs',
      'test/relational/snapshot-import-helpers.mjs',
      'test/relational/snapshot-import.integration.mjs',
    ],
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
    // The restore rehearsal runs Docker (the source project's own Compose
    // recreate, the disposable restore database and one-off containers
    // that fill and read the restore volumes), streams the dump and the
    // uploads archive through it, and writes, verifies and removes the
    // backup set and the override under the operator-named private backup
    // directory; its manifest records when the backup was taken (Node 24
    // ships no Temporal). The private root asks Git whether the
    // operator-named backup directory lies in a repository.
    files: ['test/restore-docker.mjs', 'test/restore-private-root.ts'],
    rules: {
      'security/detect-child-process': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
  {
    files: [
      'test/restore-backup.mjs',
      'test/restore-private-root.test.ts',
      'test/restore-switch.mjs',
      'test/restore-verify.mjs',
    ],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['test/restore-backup.mjs'],
    rules: {
      'unicorn/prefer-temporal': 'off',
    },
  },
  {
    // The stress scenario reads the memory files of the fixture containers'
    // cgroups, whose directory is named by the container id.
    files: ['test/relational/stress-helpers.mjs'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    // Node 24 ships no Temporal; the automatic processing and stress suites
    // read the coordinator's timestamps to measure how long the schedule
    // took.
    files: [
      'test/relational/automatic-processing-helpers.mjs',
      'test/relational/stress-helpers.mjs',
    ],
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
