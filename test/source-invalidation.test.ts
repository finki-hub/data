import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  type CollectionDeclaration,
  collectionDeclarations,
  type ColumnRefinement,
  type SourceDeclaration,
  sourceDeclarations,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/collection-roles.js';
import {
  coordinationDomains,
  coordinatorActionNames,
  type Domain,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  DirectusError,
  isCoordinationError,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/errors.js';
import {
  canonicalJson,
  fingerprintsOfGraph,
  type GraphRow,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/fingerprint.js';
import { sqlArray } from '../directus/extensions/directus-extension-data-operations/src/coordination/invalidation-function.js';
import {
  coordinatorActions,
  parseCoordinatorInput,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import { pageSize } from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
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
  invalidationSql,
  sourceInvalidationSql,
  splitSqlStatements,
} from '../directus/extensions/directus-extension-data-operations/src/source-invalidation-sql.js';
import {
  dataModelCollectionKeys,
  dataModelCollections,
} from '../src/data-model/collections.js';
import { claimChoices } from '../src/data-model/operations-vocabularies.js';

const uuid = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const triggerPattern =
  /CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "(?<table>[a-z0-9_]+)" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"\(\)/gu;
const statementStartPattern = /^(?:CREATE|DO)\b/u;
const dropPattern = /\bDROP\b/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const armPattern = /^ {4}WHEN '/gmu;
const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// The declarations the generator was last proven on: the generator first
// reproduced, byte for byte, the hand-written migration Task 23 left; the
// cleanup that removed the checkpoint sources and the migration ledger
// froze these collections again with the migration they generate then
// (the SQL snapshot at that commit, sha256 below).
// Frozen on purpose: a later collection only adds to the registry, so these
// declarations keep generating that file, and a change to one of them or
// to the generator shows here as a changed migration.
const provenCollections: ReadonlySet<string> = new Set([
  'academic_years',
  'course_curricula',
  'course_enrollment_rules',
  'course_enrollments',
  'course_equivalencies',
  'course_equivalency_members',
  'courses',
  'curriculum_entries',
  'curriculum_entry_program_states',
  'curriculum_generations',
  'data_operation_results',
  'data_operations',
  'deans_office',
  'discord_channels',
  'moodle_course_entries',
  'moodle_course_mappings',
  'moodle_history_memberships',
  'moodle_import_rows',
  'moodle_users',
  'rooms',
  'staff',
  'student_council',
  'students',
  'study_programs',
  'teaching_assignments',
]);
const provenSha256 =
  '3e4a956aa89fe3db38148d8e60d91b266494b2dab6064eca68b3bcfa8d621584';

// The statements the migration of a registry holds: the singleton row, its
// index and the trigger function, then the triggers of every source (its
// own and one per refined column).
const statementCount = (sources: readonly SourceDeclaration[]): number =>
  sources.reduce(
    (total, { columns = {} }) => total + 1 + Object.keys(columns).length,
    3,
  );

// Compile-time: whether a declared domain list may be empty.
type AcceptsEmpty<List> = [readonly []] extends [List] ? true : false;

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
  {
    action: 'complete',
    files: { courses: { outcome: 'uploaded' } },
    token: uuid,
  },
  {
    action: 'complete',
    files: { '../x.json': { outcome: 'uploaded' } },
    token: uuid,
  },
  {
    action: 'fail',
    code: 'X',
    files: { 'a.json': { code: 'X'.repeat(65), outcome: 'failed' } },
    token: uuid,
  },
  { action: 'complete', files: { 'a.json': 'uploaded' }, token: uuid },
  {
    action: 'complete',
    files: Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `f${index}.json`,
        { outcome: 'uploaded' },
      ]),
    ),
    token: uuid,
  },
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
  graph: 'calculation',
  key,
  operation: 'op-1',
  options,
  reject: null,
  resolve: null,
  trigger: 'manual',
  type: 'finki-hub-data-coordinate',
});

// Views of the collection-role registry the migration is generated from.
// Which domains a statement on each editable source table marks pending.
const sourceTableDomains: Readonly<Record<string, readonly Domain[]>> =
  Object.fromEntries(
    sourceDeclarations.map(({ collection, invalidates }) => [
      collection,
      invalidates,
    ]),
  );
// Domains a DELETE or TRUNCATE on a source table marks on top of its usual
// ones (deleting a history entry cascades its memberships away).
const sourceTableDeletionDomains: Readonly<Record<string, readonly Domain[]>> =
  Object.fromEntries(
    sourceDeclarations.flatMap(({ collection, onDelete }) =>
      onDelete === undefined ? [] : [[collection, onDelete]],
    ),
  );
// Domains an UPDATE naming one of these columns marks on top of the
// table's usual ones (a hand-edited entry label).
const sourceColumnDomains: Readonly<
  Record<string, Readonly<Record<string, readonly Domain[]>>>
> = Object.fromEntries(
  sourceDeclarations.flatMap(({ collection, columns }) =>
    columns === undefined
      ? []
      : [
          [
            collection,
            Object.fromEntries(
              Object.entries(columns).map(([column, { domains }]) => [
                column,
                domains,
              ]),
            ),
          ],
        ],
  ),
);
// Every model collection that is no source and so carries no trigger.
const excludedTables: readonly string[] = collectionDeclarations
  .filter(({ role }) => role !== 'source')
  .map(({ collection }) => collection);

const statements = sourceInvalidation.statements;
const triggerTablesOf = (sql: readonly string[]): string[] =>
  sql.flatMap((statement) =>
    statement
      .matchAll(triggerPattern)
      .map((match) => match.groups?.['table'] ?? '')
      .toArray(),
  );
const triggerTables = triggerTablesOf(statements);
const tableDomains = Object.entries(sourceTableDomains);
const functionOf = (sql: readonly string[]): string =>
  sql.find((statement) => statement.startsWith('CREATE OR REPLACE FUNCTION')) ??
  '';

describe('option contract', () => {
  test('enumerates the actions and accepts each shape with unused options blank', () => {
    expect(coordinatorActions).toEqual([
      'mark',
      'claim',
      'plan_pages',
      'stage_page',
      'index_page',
      'complete',
      'fail',
      'heartbeat',
      'record',
      'status',
    ]);
    // The Studio form lists the zod-free declaration; both are one list.
    expect(coordinatorActions).toEqual([...coordinatorActionNames]);

    const blanks = {
      bytes: '',
      code: null,
      domain: null,
      domains: null,
      filename: null,
      files: '',
      outcome: null,
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
        files: {
          'courses.json': { bytes: 2, outcome: 'uploaded' },
          'rooms.json': { code: 'PUBLISH_UPLOAD_FAILED', outcome: 'failed' },
        },
        token: uuid,
      }),
    ).toEqual({
      action: 'complete',
      files: {
        'courses.json': { bytes: 2, outcome: 'uploaded' },
        'rooms.json': { code: 'PUBLISH_UPLOAD_FAILED', outcome: 'failed' },
      },
      token: uuid,
    });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'fail',
        code: 'synthetic_failure',
        token: uuid,
      }),
    ).toEqual({
      action: 'fail',
      code: 'SYNTHETIC_FAILURE',
      message: null,
      token: uuid,
    });
    expect(
      parseCoordinatorInput({ ...blanks, action: 'heartbeat', token: uuid }),
    ).toEqual({ action: 'heartbeat', token: uuid });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'record',
        bytes: 5_439,
        filename: 'courses.json',
        outcome: 'uploaded',
        token: uuid,
      }),
    ).toEqual({
      action: 'record',
      bytes: 5_439,
      filename: 'courses.json',
      outcome: 'uploaded',
      token: uuid,
    });
    expect(
      parseCoordinatorInput({
        ...blanks,
        action: 'record',
        code: 'PUBLISH_UPLOAD_FAILED',
        filename: 'rooms.json',
        outcome: 'failed',
        token: uuid,
      }),
    ).toEqual({
      action: 'record',
      code: 'PUBLISH_UPLOAD_FAILED',
      filename: 'rooms.json',
      outcome: 'failed',
      token: uuid,
    });
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
  test('generates the proven migration byte for byte from the declarations it was proven on', () => {
    const proven = collectionDeclarations.filter(({ collection }) =>
      provenCollections.has(collection),
    );
    const golden = invalidationSql(proven);
    const goldenStatements = splitSqlStatements(golden);

    expect(proven).toHaveLength(provenCollections.size);
    expect(sha256(golden)).toBe(provenSha256);
    expect(goldenStatements).toHaveLength(24);

    for (const statement of goldenStatements) {
      expect(statement).not.toMatch(dropPattern);
    }
  });

  test('keeps the SQL snapshot fresh and is the second bundled migration', () => {
    // npm run generate:invalidation rewrites the snapshot.
    expect(sourceInvalidationSql).toBe(
      readFileSync(
        'directus/extensions/directus-extension-data-operations/src/source-invalidation.sql',
        'utf8',
      ),
    );
    expect(migrations.map(({ name }) => name)).toEqual([
      'schema-constraints',
      'source-invalidation',
    ]);
    expect(statements).toEqual(splitSqlStatements(sourceInvalidationSql));
    expect(statements).toHaveLength(statementCount(sourceDeclarations));

    for (const statement of statements) {
      expect(statement).toMatch(statementStartPattern);
      expect(statement).not.toMatch(dropPattern);
    }
  });

  test('installs one statement-level trigger per registered source and none on any other role', () => {
    const sources = sourceDeclarations.map(({ collection }) => collection);

    expect(sorted(triggerTables)).toEqual(sorted(sources));
    expect(new Set(triggerTables).size).toBe(triggerTables.length);
    expect(sorted(Object.keys(sourceTableDomains))).toEqual(sorted(sources));
    expect(sorted([...sources, ...excludedTables])).toEqual(
      sorted(dataModelCollectionKeys),
    );

    for (const table of excludedTables) {
      expect(sourceInvalidationSql).not.toContain(`TRUNCATE ON "${table}"`);
      expect(sourceInvalidationSql).not.toContain(`WHEN '${table}'`);
    }

    // Every source trigger is a plain statement: the one DO block creates
    // the singleton row.
    expect(
      statements.filter((statement) => statement.startsWith('DO $$')),
    ).toHaveLength(1);
  });

  test('marks the history index when a history entry is deleted or its label edited, never when it is reviewed', () => {
    const functionStatement = functionOf(statements);

    expect(sourceTableDeletionDomains).toEqual({
      moodle_course_entries: ['history_index'],
    });
    expect(sourceColumnDomains).toEqual({
      moodle_course_entries: { label: ['history_index'] },
    });

    for (const [table, domains] of Object.entries(sourceTableDeletionDomains)) {
      for (const domain of domains) {
        expect(sourceTableDomains[table]).not.toContain(domain);
      }
    }

    expect(functionStatement).toContain(
      "  IF TG_TABLE_NAME = 'moodle_course_entries' AND (TG_OP IN ('DELETE', 'TRUNCATE') OR TG_NAME = 'finki_hub_entry_label_invalidation') THEN\n    affected := affected || ARRAY['history_index'];\n  END IF;",
    );
    // The label trigger fires only for an UPDATE that names the column (a
    // review edit names review_state or review_reason) and runs the same
    // function, which adds the history index by the trigger's name.
    expect(
      statements.filter((statement) =>
        statement.includes('"finki_hub_entry_label_invalidation"'),
      ),
    ).toEqual([
      'CREATE OR REPLACE TRIGGER "finki_hub_entry_label_invalidation" AFTER UPDATE OF "label" ON "moodle_course_entries" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()',
    ]);
  });

  test('maps every source to its domains inside the trigger function, publication being the default', () => {
    const functionStatement = functionOf(statements);
    const listed = tableDomains.filter(
      ([, domains]) => domains.join(',') !== 'publication',
    );

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
    // One arm per source whose domains differ from the default, no other.
    expect(functionStatement.match(armPattern) ?? []).toHaveLength(
      listed.length,
    );

    const defaults = tableDomains.filter(
      ([, domains]) => domains.join(',') === 'publication',
    );

    for (const [table, domains] of listed) {
      const list = domains.map((domain) => `'${domain}'`).join(', ');

      expect(functionStatement).toContain(
        `WHEN '${table}' THEN ARRAY[${list}]`,
      );
    }
    for (const [table] of defaults) {
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
    // One declaration: the model's claim domains are the extension's
    // declared domains (and the snapshot claim), with their labels.
    expect(claimChoices.map(({ value }) => value)).toEqual([
      ...coordinationDomains,
      'snapshot',
    ]);

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

// The statements of the migration generated for the registry and one more
// test-only declaration.
const withExtra = (declaration: CollectionDeclaration): readonly string[] =>
  splitSqlStatements(invalidationSql([...collectionDeclarations, declaration]));

describe('a registry that declares one more collection', () => {
  test('gives a test-only extra source exactly one more trigger and nothing else', () => {
    const plain = withExtra({
      collection: 'synthetic_extra_source',
      invalidates: ['publication'],
      role: 'source',
    });

    expect(plain).toHaveLength(statements.length + 1);
    expect(triggerTablesOf(plain)).toEqual([
      ...triggerTables,
      'synthetic_extra_source',
    ]);
    expect(functionOf(plain)).toBe(functionOf(statements));
    expect(
      plain.filter((statement) => !statements.includes(statement)),
    ).toEqual([
      'CREATE OR REPLACE TRIGGER "finki_hub_source_invalidation" AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "synthetic_extra_source" FOR EACH STATEMENT EXECUTE FUNCTION "finki_hub_source_invalidation"()',
    ]);

    // A source that feeds a calculation gets its arm in the function too.
    const counted = withExtra({
      collection: 'synthetic_extra_input',
      invalidates: ['enrollments', 'publication'],
      role: 'source',
    });

    expect(counted).toHaveLength(statements.length + 1);
    expect(functionOf(counted)).toContain(
      "WHEN 'synthetic_extra_input' THEN ARRAY['enrollments', 'publication']",
    );
    expect(triggerTablesOf(counted).at(-1)).toBe('synthetic_extra_input');

    // A collection of any other role adds no trigger.
    expect(
      withExtra({
        collection: 'synthetic_extra_status',
        description: 'a synthetic status table',
        role: 'status',
      }),
    ).toHaveLength(statements.length);
  });
});

describe('a declaration with an empty domain list', () => {
  test('is refused by the types and by the generator, never installed as an untyped ARRAY[]', () => {
    // An empty list would generate ARRAY[], which PostgreSQL cannot type;
    // the lazily planned trigger function would then fail the first
    // statement on the source, not the migration. The declaration types
    // hold at least one domain (npm run check fails otherwise) ...
    const emptyAccepted: readonly [
      AcceptsEmpty<SourceDeclaration['invalidates']>,
      AcceptsEmpty<NonNullable<SourceDeclaration['onDelete']>>,
      AcceptsEmpty<ColumnRefinement['domains']>,
    ] = [false, false, false];

    expect(emptyAccepted).toEqual([false, false, false]);

    // ... and the generator refuses one that reaches it untyped.
    expect(() => sqlArray([])).toThrow('untyped ARRAY[]');
    expect(sqlArray(['enrollments', 'publication'])).toBe(
      "ARRAY['enrollments', 'publication']",
    );
    expect(sourceInvalidationSql).not.toContain('ARRAY[]');
  });
});

describe('graph fingerprint', () => {
  test('ignores key order and undefined members but not option values or wiring', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: null }] })).toBe(
      '{"a":[{"c":null}],"b":1}',
    );

    const base = fingerprintsOfGraph([
      graphRow({ action: 'claim', domain: 'enrollments' }),
    ]).calculation;

    expect(base).toMatch(sha256Pattern);
    expect(
      fingerprintsOfGraph([
        graphRow({ domain: 'enrollments', action: 'claim' }),
      ]).calculation,
    ).toBe(base);
    expect(
      fingerprintsOfGraph([
        graphRow({ action: 'claim', domain: 'publication' }),
      ]).calculation,
    ).not.toBe(base);
    expect(
      fingerprintsOfGraph([
        {
          ...graphRow({ action: 'claim', domain: 'enrollments' }),
          resolve: 'op-2',
        },
      ]).calculation,
    ).not.toBe(base);
    expect(fingerprintsOfGraph([]).calculation).not.toBe(base);
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
