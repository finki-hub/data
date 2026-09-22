import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  DirectusError,
  isCoordinationError,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/errors.js';
import {
  canonicalJson,
  fingerprintOfGraph,
  type GraphRow,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/fingerprint.js';
import {
  coordinatorActions,
  parseCoordinatorInput,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import {
  coordinationDomains,
  excludedTables,
  optionalSourceTables,
  pageSize,
  sourceTableDomains,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import {
  migrations,
  sourceInvalidation,
} from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import {
  duplicatePairs,
  missingPages,
  pageToken,
  pageTokenPattern,
  planPages,
  stagedWith,
} from '../directus/extensions/directus-extension-data-operations/src/page-state.js';
import {
  sourceInvalidationSql,
  splitSqlStatements,
} from '../directus/extensions/directus-extension-data-operations/src/source-invalidation-sql.js';
import { dataModelCollections } from '../src/data-model/collections.js';
import { migrationCollectionKeys } from '../src/data-model/migration-collections.js';
import { coordinationDomains as modelDomains } from '../src/data-model/operations-collections.js';

const uuid = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const triggerPattern =
  /CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "(?<table>[a-z0-9_]+)" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"\(\)/gu;
const statementStartPattern = /^(?:CREATE|DO)\b/u;
const dropPattern = /\bDROP\b/u;
const doBlockPattern = /^DO \$\$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const collator = new Intl.Collator('en');
const sorted = (values: readonly string[]): string[] =>
  values.toSorted((left, right) => collator.compare(left, right));

const invalidOptions: readonly unknown[] = [
  { action: 'drop_table' },
  { action: 'claim', domain: 'courses' },
  { action: 'claim', domain: 'enrollments; DROP TABLE courses' },
  { action: 'mark', domains: [] },
  { action: 'mark', domains: ['directus_users'] },
  { action: 'plan_pages', source: 'moodle_users', token: uuid },
  { action: 'plan_pages', source: 'rules', token: 'not-a-uuid' },
  { action: 'stage_page', page: 'page-1', rows: [], token: uuid },
  {
    action: 'stage_page',
    page: 'p0001',
    rows: [{ academic_year: 1, count: -1, course: 1 }],
    token: uuid,
  },
  {
    action: 'stage_page',
    page: 'p0001',
    rows: [{ academic_year: 0, count: 1, course: 1 }],
    token: uuid,
  },
  { action: 'complete' },
  { action: 'fail', code: 'has space', token: uuid },
  { action: 'fail', code: 'x'.repeat(65), token: uuid },
];

const failureOf = (options: unknown): unknown => {
  try {
    parseCoordinatorInput(options);
    return null;
  } catch (error) {
    return error;
  }
};

const graphRow = (options: unknown, key = 'coordinate'): GraphRow => ({
  entry: 'op-1',
  flow: 'flow-1',
  flow_options: { collections: ['data_operations'] },
  key,
  operation: 'op-1',
  options,
  reject: null,
  resolve: null,
  trigger: 'manual',
  type: 'finki-hub-data-coordinate',
});

const statements = sourceInvalidation.statements;
const triggerTables = statements.flatMap((statement) =>
  statement
    .matchAll(triggerPattern)
    .map((match) => match.groups?.['table'] ?? '')
    .toArray(),
);
// The migration ledger is private CLI bookkeeping, never a source table.
const modelTables = dataModelCollections
  .map(({ collection }) => collection)
  .filter((collection) => !migrationCollectionKeys.includes(collection));
const tableDomains = Object.entries(sourceTableDomains);

describe('option contract', () => {
  test('enumerates the actions and accepts each shape with unused options blank', () => {
    expect(coordinatorActions).toEqual([
      'mark',
      'claim',
      'plan_pages',
      'stage_page',
      'complete',
      'fail',
      'heartbeat',
      'status',
    ]);

    const blanks = {
      code: null,
      domain: null,
      domains: null,
      files: '',
      page: null,
      retry: null,
      rows: null,
      source: null,
      token: null,
    };

    expect(parseCoordinatorInput({ ...blanks, action: 'status' })).toEqual({
      action: 'status',
    });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'claim',
        domain: 'enrollments',
      }),
    ).toEqual({ action: 'claim', domain: 'enrollments', retry: false });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'claim',
        domain: 'publication',
        retry: 'true',
      }),
    ).toEqual({ action: 'claim', domain: 'publication', retry: true });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'mark',
        domains: '["publication","enrollments"]',
      }),
    ).toEqual({ action: 'mark', domains: ['publication', 'enrollments'] });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'plan_pages',
        source: 'rules',
        token: uuid,
      }),
    ).toEqual({ action: 'plan_pages', source: 'rules', token: uuid });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'stage_page',
        page: 'p0001',
        rows: '[{"course":1,"academic_year":2,"count":3,"extra":true}]',
        token: uuid,
      }),
    ).toEqual({
      action: 'stage_page',
      page: 'p0001',
      rows: [{ academic_year: 2, count: 3, course: 1 }],
      token: uuid,
    });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'complete',
        files: { courses: 'published', rooms: null },
        token: uuid,
      }),
    ).toEqual({
      action: 'complete',
      files: { courses: 'published', rooms: null },
      token: uuid,
    });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'fail',
        code: 'synthetic_failure',
        token: uuid,
      }),
    ).toEqual({ action: 'fail', code: 'SYNTHETIC_FAILURE', token: uuid });
    expect(
      parseCoordinatorInput({ ...blanks, action: 'heartbeat', token: uuid }),
    ).toEqual({ action: 'heartbeat', token: uuid });
  });

  test('rejects unknown actions, arbitrary names, malformed tokens and bad rows as a 400', () => {
    for (const options of invalidOptions) {
      const error = failureOf(options);

      expect(isCoordinationError(error)).toBeTruthy();
      expect(error).toMatchObject({
        code: 'COORDINATION_INVALID_OPTIONS',
        name: 'DirectusError',
        status: 400,
      });
    }
  });

  test('shapes refusals like Directus errors with a coordination code', () => {
    const error = new DirectusError('late', {
      details: { missing: ['p0002'] },
      reason: 'PAGES_MISSING',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DirectusError');
    expect(error.code).toBe('COORDINATION_PAGES_MISSING');
    expect(error.status).toBe(409);
    expect(error.extensions).toEqual({
      missing: ['p0002'],
      reason: 'PAGES_MISSING',
    });
  });
});

describe('source-invalidation migration', () => {
  test('embeds the SQL file verbatim and is the second bundled migration', () => {
    expect(sourceInvalidationSql).toBe(
      readFileSync('src/migrations/source-invalidation.sql', 'utf8'),
    );
    expect(migrations.map(({ name }) => name)).toEqual([
      'schema-constraints',
      'source-invalidation',
    ]);
    expect(statements).toEqual(splitSqlStatements(sourceInvalidationSql));
    expect(statements).toHaveLength(22);

    for (const statement of statements) {
      expect(statement).toMatch(statementStartPattern);
      expect(statement).not.toMatch(dropPattern);
    }
  });

  test('installs one statement-level trigger per editable source table and none on derived, staging or status tables', () => {
    expect(sorted(triggerTables)).toEqual(
      sorted(Object.keys(sourceTableDomains)),
    );
    expect(new Set(triggerTables).size).toBe(triggerTables.length);
    expect(sorted(triggerTables)).toEqual(
      sorted(modelTables.filter((table) => !excludedTables.includes(table))),
    );

    for (const table of excludedTables) {
      expect(modelTables).toContain(table);
      expect(triggerTables).not.toContain(table);
      expect(sourceInvalidationSql).not.toContain(`TRUNCATE ON "${table}"`);
    }

    // The exemption of the migration collections is explicit and bounded:
    // each is a model collection that no trigger and no domain mapping names.
    expect(migrationCollectionKeys).toEqual(['migration_ledger']);

    for (const table of migrationCollectionKeys) {
      expect(
        dataModelCollections.map(({ collection }) => collection),
      ).toContain(table);
      expect(triggerTables).not.toContain(table);
      expect(Object.keys(sourceTableDomains)).not.toContain(table);
      expect(sourceInvalidationSql).not.toContain(`ON "${table}"`);
    }
    for (const table of optionalSourceTables) {
      const guarded = statements.find((statement) =>
        statement.includes(`ON "${table}"`),
      );

      expect(guarded).toMatch(doBlockPattern);
      expect(guarded).toContain(`to_regclass('"${table}"') IS NOT NULL`);
    }
  });

  test('maps every table to its domains inside the trigger function, publication being the default', () => {
    const functionStatement = statements[2];
    const multi = tableDomains.filter(([, domains]) => domains.length > 1);
    const single = tableDomains.filter(([, domains]) => domains.length === 1);

    expect(functionStatement).toContain(
      'CREATE OR REPLACE FUNCTION "finki_hub_source_invalidation"() RETURNS trigger',
    );
    expect(functionStatement).toContain(
      '"source_revision" = "source_revision" + 1',
    );
    expect(functionStatement).toContain(
      '"requested_revision" = "source_revision" + 1',
    );
    expect(functionStatement).toContain("ELSE ARRAY['publication']");
    expect(functionStatement).toContain('RAISE EXCEPTION');
    expect(multi.map(([table]) => table)).toEqual([
      'academic_years',
      'course_enrollment_rules',
      'moodle_course_entries',
      'moodle_course_mappings',
      'moodle_users',
    ]);

    for (const [table, domains] of multi) {
      const list = domains.map((domain) => `'${domain}'`).join(', ');

      expect(functionStatement).toContain(
        `WHEN '${table}' THEN ARRAY[${list}]`,
      );
    }
    for (const [table, domains] of single) {
      expect(domains).toEqual(['publication']);
      expect(functionStatement).not.toContain(`WHEN '${table}'`);
    }

    expect(statements[0]).toContain(
      'INSERT INTO "data_operations" DEFAULT VALUES',
    );
    expect(statements[1]).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "data_operations_singleton_unique" ON "data_operations" ((true))',
    );
  });

  test('shares the domain enumeration and the status columns with the data model', () => {
    expect([...coordinationDomains]).toEqual([...modelDomains]);

    const operations = dataModelCollections.find(
      ({ collection }) => collection === 'data_operations',
    );
    const fields = operations?.fields.map(({ field }) => field) ?? [];
    for (const column of [
      'source_revision',
      'claim_domain',
      'claim_revision',
      'claim_fingerprint',
      'claim_started_at',
      'claim_heartbeat_at',
      'claim_pages',
      'claim_staged',
      'last_error_at',
      'last_failed_revision',
      'last_failed_domain',
      'last_failed_fingerprint',
      'calculation_fingerprint',
      'publication_fingerprint',
    ]) {
      expect(fields).toContain(column);
    }
  });
});

describe('graph fingerprint', () => {
  test('ignores key order and undefined members but not option values or wiring', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: null }] })).toBe(
      '{"a":[{"c":null}],"b":1}',
    );

    const base = fingerprintOfGraph([
      graphRow({ action: 'claim', domain: 'enrollments' }),
    ]);

    expect(base).toMatch(sha256Pattern);
    expect(
      fingerprintOfGraph([
        graphRow({ domain: 'enrollments', action: 'claim' }),
      ]),
    ).toBe(base);
    expect(
      fingerprintOfGraph([
        graphRow({ action: 'claim', domain: 'publication' }),
      ]),
    ).not.toBe(base);
    expect(
      fingerprintOfGraph([
        {
          ...graphRow({ action: 'claim', domain: 'enrollments' }),
          resolve: 'op-2',
        },
      ]),
    ).not.toBe(base);
    expect(fingerprintOfGraph([])).not.toBe(base);
  });
});

describe('page planning', () => {
  test('splits sorted distinct ids into ranges of at most 250 rows', () => {
    expect(pageSize).toBe(250);
    expect(planPages([])).toEqual([]);
    expect(planPages([7, 3, 3, 5])).toEqual([
      { from: 3, rows: 3, to: 7, token: 'p0001' },
    ]);

    const ids = Array.from({ length: 501 }, (_, index) => 1_000 - index);
    const pages = planPages(ids);

    expect(pages.map(({ rows }) => rows)).toEqual([250, 250, 1]);
    expect(pages.map(({ token }) => token)).toEqual([
      'p0001',
      'p0002',
      'p0003',
    ]);
    expect(pages[0]).toEqual({ from: 500, rows: 250, to: 749, token: 'p0001' });
    expect(pages[2]).toEqual({
      from: 1_000,
      rows: 1,
      to: 1_000,
      token: 'p0003',
    });
    expect(pages.reduce((sum, { rows }) => sum + rows, 0)).toBe(501);

    for (const page of pages) {
      expect(page.token).toMatch(pageTokenPattern);
    }

    expect(pageToken(9_999)).toBe('p10000');
    expect(planPages([1, 2, 3], 2)).toEqual([
      { from: 1, rows: 2, to: 2, token: 'p0001' },
      { from: 3, rows: 1, to: 3, token: 'p0002' },
    ]);
  });

  test('finds duplicated pairs, missing pages and records a staged page once', () => {
    expect(
      duplicatePairs([
        { academic_year: 1, count: 1, course: 1 },
        { academic_year: 2, count: 1, course: 1 },
      ]),
    ).toEqual([]);
    expect(
      duplicatePairs([
        { academic_year: 1, count: 1, course: 1 },
        { academic_year: 1, count: 4, course: 1 },
      ]),
    ).toEqual(['1/1']);
    expect(missingPages(['p0001', 'p0002'], ['p0002'])).toEqual(['p0001']);
    expect(stagedWith(['p0002'], 'p0001')).toEqual(['p0001', 'p0002']);
    expect(stagedWith(['p0001'], 'p0001')).toEqual(['p0001']);
  });
});
