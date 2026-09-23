import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  migrations,
  schemaConstraints,
} from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import {
  dataModelCollectionKeys,
  dataModelCollections,
} from '../src/data-model/collections.js';
import {
  enumMaxLength,
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { scalar } from '../src/data-model/fields.js';
import {
  CollectionLimitError,
  installDataModel,
  SchemaRefusalError,
} from '../src/data-model/install.js';
import {
  aliasesFor,
  compositeKeys,
  modelRelations,
  relationsOf,
  toRelationPayload,
} from '../src/data-model/relations.js';
import { DirectusRequestError } from '../src/directus-request.js';
import { collectionSpecs } from '../src/model.js';
import {
  collectionKeys,
  type CompositeKey,
  type ModelCollection,
  type ModelField,
  type ModelRelationField,
  relationalCollectionKeys,
} from '../src/schema.js';
import { privateCollectionSpecs } from '../src/specs/private.js';
import {
  emptyState,
  fakeDirectus,
  findCollection,
  findField,
  installedState,
  mutations,
} from './data-model-test-helpers.js';

const statementStartPattern = /^\s*(?:CREATE|DO)\b/u;
const dropPattern = /\bDROP\b/u;

const relationFields = (collection: string): readonly ModelRelationField[] =>
  findCollection(collection).fields.flatMap((field) =>
    field.kind === 'm2o' ? [field] : [],
  );

const enumOf = (collection: string, field: string) => {
  const found = findField(collection, field);
  if (found.kind !== 'enum') {
    throw new Error(`${collection}.${field} is not an enum`);
  }
  return found;
};

const isUnique = (field: ModelField): boolean =>
  field.kind !== 'm2o' && field.kind !== 'enum' && field.unique === true;

const hasNameClash = (collection: ModelCollection): boolean => {
  const names = [
    ...collection.fields.map(({ field }) => field),
    ...aliasesFor(collection.collection).map(({ alias }) => alias.field),
  ];
  return new Set(names).size !== names.length || names.includes('id');
};

const unknownColumns = (key: CompositeKey): readonly string[] => {
  const fields = new Set(
    findCollection(key.collection).fields.map(({ field }) => field),
  );
  return key.columns
    .filter((column) => !fields.has(column))
    .map((column) => `${key.collection}.${column}`);
};

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

// True when every column of the collection is owned by the Flows.
const derivedCollection = (collection: string): boolean =>
  findCollection(collection).fields.every(({ readOnly }) => readOnly === true);

const totalFields = dataModelCollections.reduce(
  (sum, collection) =>
    sum + collection.fields.length + aliasesFor(collection.collection).length,
  0,
);

const limitError = new DirectusRequestError('POST /collections returned 403', {
  code: 'LIMIT_EXCEEDED',
  reason: null,
  status: 403,
});

const collectionBody = z.object({
  collection: z.string(),
  fields: z.array(
    z.object({
      field: z.string(),
      meta: z.looseObject({ special: z.array(z.string()).optional() }),
      type: z.string(),
    }),
  ),
  meta: z.looseObject({ hidden: z.boolean(), singleton: z.boolean() }),
  schema: z.object({}),
});

const relationBody = z.object({
  collection: z.string(),
  field: z.string(),
  meta: z.object({ one_field: z.string().nullable() }),
  related_collection: z.string(),
  schema: z.object({ on_delete: z.enum(['CASCADE', 'SET NULL']) }),
});

describe('target collections', () => {
  test('declares every checkpoint and relational collection exactly once', () => {
    expect(new Set(dataModelCollectionKeys)).toEqual(
      new Set([...collectionKeys, ...relationalCollectionKeys]),
    );
    expect(dataModelCollectionKeys).toHaveLength(25);
    expect(new Set(dataModelCollectionKeys).size).toBe(25);
  });

  test('adopts the checkpoint collections with their current fields first', () => {
    for (const spec of collectionSpecs) {
      const collection = findCollection(spec.key);

      expect(collection.origin).toBe('checkpoint');
      expect(collection.hidden).toBe(false);
      expect(collection.singleton).toBe(false);
      expect(
        collection.fields
          .slice(0, spec.fields.length)
          .map(({ field, kind, nullable }) => ({ field, kind, nullable })),
      ).toEqual(
        spec.fields.map(({ kind, required, target }) => ({
          field: target,
          kind,
          nullable: required !== true,
        })),
      );
    }
  });

  test('keeps the old calculated course columns in place', () => {
    const courses = findCollection('courses');

    expect(courses.fields.map(({ field }) => field)).toContain(
      'enrollment_2025_2026',
    );
    expect(findField('courses', 'professors').readOnly).toBeTruthy();
    expect(courses.fields.filter(({ kind }) => kind === 'm2o')).toHaveLength(0);
  });

  test('preserves the 38 Moodle scraper fields on the snapshot and the staging rows', () => {
    const [spec] = privateCollectionSpecs;
    const keys = spec.fields.map(({ target }) => target);

    expect(keys).toHaveLength(38);
    expect(
      findCollection('moodle_users').fields.map(({ field }) => field),
    ).toEqual(keys);

    const staging = findCollection('moodle_import_rows');

    expect(staging.fields.map(({ field }) => field)).toEqual(keys);
    expect(staging.hidden).toBeTruthy();
  });

  test('uses distinct names for columns and aliases inside every collection', () => {
    expect(dataModelCollections.filter(hasNameClash)).toEqual([]);
  });

  test('keeps the coordination singleton and the staging collections private', () => {
    const operations = findCollection('data_operations');

    expect(operations.singleton).toBeTruthy();
    expect(operations.hidden).toBeTruthy();
    expect(operations.fields.map(({ field }) => field)).toEqual([
      'requested_revision',
      'completed_revision',
      'dirty_domains',
      'claim_token',
      'claim_owner',
      'started_at',
      'finished_at',
      'last_error_code',
      'import_state',
      'publication_state',
      'publish_courses_outcome',
      'publish_rooms_outcome',
      'publish_staff_outcome',
      'publish_students_outcome',
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
      'import_file',
      'import_token',
      'import_rows',
      'import_fingerprint',
      'import_warnings',
      'import_error',
      'import_started_at',
      'import_finished_at',
      'import_backup_file',
      'import_backup_rows',
      'import_backup_fingerprint',
      'import_promoted_rows',
      'import_promoted_fingerprint',
      'import_promoted_at',
      'last_error_message',
      'history_index_input_revision',
      'enrollments_input_revision',
    ]);
    expect(findCollection('data_operation_results').hidden).toBeTruthy();
    expect(findCollection('moodle_history_memberships').hidden).toBeTruthy();
  });

  test('declares derived rows read-only', () => {
    const editable = ['course_enrollments', 'moodle_history_memberships']
      .flatMap((collection) => findCollection(collection).fields)
      .filter(({ readOnly }) => readOnly !== true);

    expect(editable).toEqual([]);
    expect(findField('course_enrollments', 'count').nullable).toBe(false);
    expect(findField('course_enrollments', 'computed_revision').nullable).toBe(
      false,
    );
    expect(findField('course_enrollments', 'computed_at').kind).toBe(
      'timestamp',
    );
  });

  test('bounds enrollment counts at zero on the server', () => {
    for (const collection of ['course_enrollments', 'data_operation_results']) {
      const count = findField(collection, 'count');

      expect(count.kind === 'integer' && count.minimum).toBe(0);
      expect(toFieldPayload(count, 5).meta.validation).toEqual({
        count: { _gte: 0 },
      });
    }

    const optional = toFieldPayload(scalar('n', 'integer', { minimum: 1 }), 1);

    expect(optional.meta.validation).toEqual({
      _or: [{ n: { _null: true } }, { n: { _gte: 1 } }],
    });
    expect(
      toFieldPayload(scalar('free', 'integer'), 1).meta.validation,
    ).toBeUndefined();
  });
});

describe('domain keys', () => {
  test('does not impose a unique student index or curriculum name', () => {
    expect(isUnique(findField('students', 'index_number'))).toBe(false);
    expect(isUnique(findField('curriculum_entries', 'name'))).toBe(false);
    expect(isUnique(findField('curriculum_entries', 'code'))).toBe(false);
    expect(findField('curriculum_entries', 'code').nullable).toBeTruthy();
    expect(
      compositeKeys.filter(({ collection }) =>
        ['courses', 'curriculum_entries', 'students'].includes(collection),
      ),
    ).toEqual([]);
  });

  test('requires unique academic year labels and exact, unbounded history entry labels', () => {
    for (const [collection, kind] of [
      ['academic_years', 'string'],
      ['moodle_course_entries', 'text'],
    ] as const) {
      const found = findField(collection, 'label');

      expect(isUnique(found)).toBeTruthy();
      expect(found.nullable).toBe(false);
      expect(found.kind).toBe(kind);
      expect(toFieldPayload(found, 1)).toMatchObject({
        schema: { is_nullable: false, is_unique: true },
        type: kind,
      });
      expect(toFieldPayload(found, 1).schema?.max_length).toBeUndefined();
    }
  });

  test('declares composite keys only where the domain table says unique', () => {
    expect(
      compositeKeys.map(({ collection, columns, kind }) => ({
        collection,
        columns,
        kind,
      })),
    ).toEqual([
      {
        collection: 'course_curricula',
        columns: ['course', 'generation'],
        kind: 'unique',
      },
      {
        collection: 'moodle_history_memberships',
        columns: ['moodle_user', 'entry'],
        kind: 'unique',
      },
      {
        collection: 'moodle_course_mappings',
        columns: ['entry', 'course', 'academic_year'],
        kind: 'unique',
      },
      {
        collection: 'moodle_course_mappings',
        columns: ['course', 'academic_year'],
        kind: 'index',
      },
      {
        collection: 'course_enrollment_rules',
        columns: ['course', 'academic_year'],
        kind: 'unique',
      },
      {
        collection: 'course_enrollments',
        columns: ['course', 'academic_year'],
        kind: 'unique',
      },
      {
        collection: 'data_operation_results',
        columns: ['claim_token', 'page_token', 'course', 'academic_year'],
        kind: 'unique',
      },
    ]);

    expect(compositeKeys.flatMap(unknownColumns)).toEqual([]);

    for (const key of compositeKeys) {
      expect(key.name.length).toBeLessThanOrEqual(63);
    }
  });

  test('ships one idempotent SQL statement for every composite key', () => {
    expect(migrations.map(({ name }) => name)).toEqual([
      'schema-constraints',
      'source-invalidation',
    ]);

    for (const key of compositeKeys) {
      const columns = key.columns.map((column) => `"${column}"`).join(', ');

      expect(schemaConstraints.statements).toContain(
        `CREATE ${key.kind === 'unique' ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${key.name}" ON "${key.collection}" (${columns})`,
      );
    }
    for (const statement of schemaConstraints.statements) {
      expect(statement).toMatch(statementStartPattern);
      expect(statement).not.toMatch(dropPattern);
    }
  });

  test('guards the link generation and nonnegative counts in SQL', () => {
    const sql = schemaConstraints.statements.join('\n');

    expect(sql).toContain('CHECK ("count" >= 0)');
    expect(sql).toContain(
      'CREATE OR REPLACE TRIGGER "course_curricula_generation_guard" BEFORE INSERT OR UPDATE OF "entry", "generation" ON "course_curricula"',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE TRIGGER "curriculum_entries_generation_guard" BEFORE UPDATE OF "generation" ON "curriculum_entries"',
    );
    expect(sql).toContain("ERRCODE = 'foreign_key_violation'");
  });
});

describe('enumerations', () => {
  test('restricts generations to 2018 and 2023 on entries and links', () => {
    for (const collection of ['curriculum_entries', 'course_curricula']) {
      const generation = enumOf(collection, 'generation');

      expect(generation.choices).toEqual(['2018', '2023']);
      expect(generation.nullable).toBe(false);
    }
  });

  test('declares the role, mode, review and operation states', () => {
    expect(enumOf('teaching_assignments', 'role').choices).toEqual([
      'professor',
      'assistant',
    ]);
    expect(enumOf('teaching_assignments', 'role').nullable).toBeTruthy();
    expect(enumOf('course_enrollment_rules', 'mode').choices).toEqual([
      'mapped_entries',
      'legacy_regex',
    ]);
    expect(enumOf('moodle_course_entries', 'review_state')).toMatchObject({
      choices: ['needs_mapping', 'mapped', 'ignored'],
      defaultValue: 'needs_mapping',
      nullable: false,
    });
    expect(enumOf('data_operations', 'import_state').defaultValue).toBe('idle');
    expect(enumOf('data_operations', 'publication_state').defaultValue).toBe(
      'idle',
    );
  });

  test('builds server-enforced dropdowns for enums', () => {
    const payload = toFieldPayload(enumOf('course_curricula', 'generation'), 3);

    expect(payload).toMatchObject({
      field: 'generation',
      meta: {
        interface: 'select-dropdown',
        options: {
          allowNone: false,
          allowOther: false,
          choices: [
            { text: '2018', value: '2018' },
            { text: '2023', value: '2023' },
          ],
        },
        required: true,
        sort: 3,
        validation: { generation: { _in: ['2018', '2023'] } },
      },
      schema: { is_nullable: false, max_length: enumMaxLength },
      type: 'string',
    });

    const optional = toFieldPayload(enumOf('teaching_assignments', 'role'), 1);

    expect(optional.meta.validation).toEqual({
      _or: [
        { role: { _null: true } },
        { role: { _in: ['professor', 'assistant'] } },
      ],
    });
    expect(optional.schema).toMatchObject({ is_nullable: true });
  });
});

describe('relations and aliases', () => {
  test('relates every collection through integer ids to a modelled collection', () => {
    expect(modelRelations.length).toBeGreaterThan(0);

    for (const relation of modelRelations) {
      expect(dataModelCollectionKeys).toContain(relation.related);

      const payload = toFieldPayload(
        findField(relation.collection, relation.field),
        1,
      );

      expect(payload).toMatchObject({
        meta: {
          display: 'related-values',
          interface: 'select-dropdown-m2o',
          special: ['m2o'],
        },
        schema: { is_indexed: true, is_nullable: relation.nullable },
        type: 'integer',
      });
      expect(payload.meta.options?.['template']).toBeTypeOf('string');
    }
  });

  test('pairs every declared alias with its reverse relation on the one side', () => {
    for (const relation of modelRelations) {
      if (relation.alias === null) {
        continue;
      }

      expect(
        aliasesFor(relation.related).map(({ alias }) => alias.field),
      ).toContain(relation.alias.field);
      expect(relation.alias.fields.length).toBeGreaterThan(0);

      const readOnly = relation.alias.readOnly === true;

      expect(toAliasPayload(relation.alias, 9)).toMatchObject({
        field: relation.alias.field,
        meta: {
          interface: 'list-o2m',
          options: {
            enableCreate: !readOnly,
            enableSelect: !readOnly,
            fields: relation.alias.fields,
            template: relation.alias.template,
          },
          readonly: readOnly,
          sort: 9,
          special: ['o2m'],
        },
        type: 'alias',
      });
    }
  });

  test('locks exactly the reverse aliases onto derived collections read-only', () => {
    const aliases = modelRelations.flatMap((relation) =>
      relation.alias === null
        ? []
        : [
            {
              alias: `${relation.related}.${relation.alias.field}`,
              derived: derivedCollection(relation.collection),
              readOnly: relation.alias.readOnly === true,
            },
          ],
    );

    expect(
      aliases.filter(({ readOnly }) => readOnly).map(({ alias }) => alias),
    ).toEqual([
      'moodle_users.history_memberships',
      'moodle_course_entries.memberships',
      'courses.enrollments',
      'academic_years.enrollments',
    ]);
    expect(
      aliases.filter(({ derived, readOnly }) => derived !== readOnly),
    ).toEqual([]);
  });

  test('exposes the course side of curricula, assignments, mappings, rules and counts', () => {
    expect(aliasesFor('courses').map(({ alias }) => alias.field)).toEqual([
      'equivalencies',
      'assignments',
      'curricula',
      'history_mappings',
      'enrollment_rules',
      'enrollments',
    ]);
    expect(aliasesFor('moodle_users').map(({ alias }) => alias.field)).toEqual([
      'history_memberships',
    ]);
    expect(aliasesFor('students').map(({ alias }) => alias.field)).toEqual([
      'council_memberships',
    ]);
    expect(
      aliasesFor('moodle_course_entries').map(({ alias }) => alias.field),
    ).toEqual(['memberships', 'mappings']);
  });

  test('keeps resolved checkpoint links nullable and transition rows reviewable', () => {
    const mandatory = [
      ...relationFields('course_equivalencies'),
      ...relationFields('teaching_assignments'),
      ...relationFields('student_council'),
    ].filter(({ nullable }) => !nullable);

    expect(mandatory).toEqual([]);
    expect(findField('student_council', 'index_number').nullable).toBe(false);
    expect(
      findField('teaching_assignments', 'display_override').nullable,
    ).toBeTruthy();
    expect(findField('teaching_assignments', 'display_override').kind).toBe(
      'text',
    );
    expect(
      findField('teaching_assignments', 'source_collection').readOnly,
    ).toBeTruthy();
  });

  test('cascades mandatory links and nullifies optional ones', () => {
    const mandatory = relationsOf('course_curricula').find(
      ({ field }) => field === 'course',
    );

    expect(mandatory && toRelationPayload(mandatory)).toEqual({
      collection: 'course_curricula',
      field: 'course',
      meta: {
        junction_field: null,
        one_deselect_action: 'delete',
        one_field: 'curricula',
        sort_field: 'sort',
      },
      related_collection: 'courses',
      schema: { on_delete: 'CASCADE' },
    });

    const optional = relationsOf('student_council').find(
      ({ field }) => field === 'student',
    );

    expect(optional && toRelationPayload(optional)).toMatchObject({
      meta: {
        one_deselect_action: 'nullify',
        one_field: 'council_memberships',
      },
      related_collection: 'students',
      schema: { on_delete: 'SET NULL' },
    });
    expect(
      relationsOf('data_operation_results').map(({ alias }) => alias),
    ).toEqual([null, null]);
  });
});

describe('installDataModel on fresh and installed projects', () => {
  test('creates every collection schema-only and then every relation on a fresh project', async () => {
    const { request, requests } = fakeDirectus(emptyState());

    const summary = await installDataModel(request);

    expect(summary).toEqual({
      collections: { adopted: 0, created: 25, refused: 0, skipped: 0 },
      fields: { adopted: 0, created: totalFields, refused: 0, skipped: 0 },
      relations: {
        adopted: 0,
        created: modelRelations.length,
        refused: 0,
        skipped: 0,
      },
    });

    const changes = mutations(requests);

    expect(changes.every(({ method }) => method === 'POST')).toBeTruthy();
    expect(changes.some(({ pathname }) => pathname.startsWith('/items'))).toBe(
      false,
    );

    const collections = changes.slice(0, 25);

    expect(collections.map(({ pathname }) => pathname)).toEqual(
      dataModelCollectionKeys.map(() => '/collections'),
    );
    expect(
      collections.map(({ body }) => collectionBody.parse(body).collection),
    ).toEqual(dataModelCollectionKeys);

    const relations = changes.slice(25);

    expect(relations.map(({ pathname }) => pathname)).toEqual(
      modelRelations.map(() => '/relations'),
    );

    const created = new Set(
      collections.map(({ body }) => collectionBody.parse(body).collection),
    );
    const dangling = relations
      .map(({ body }) => relationBody.parse(body))
      .filter(
        ({ collection, related_collection }) =>
          !created.has(collection) || !created.has(related_collection),
      );

    expect(dangling).toEqual([]);
  });

  test('declares aliases, singleton and hidden metadata inline in the collection payload', async () => {
    const { request, requests } = fakeDirectus(emptyState());

    await installDataModel(request);

    const bodies = mutations(requests).flatMap(({ body, pathname }) =>
      pathname === '/collections' ? [collectionBody.parse(body)] : [],
    );
    const courses = bodies.find(({ collection }) => collection === 'courses');

    expect(
      courses?.fields
        .filter(({ type }) => type === 'alias')
        .map(({ field, meta }) => ({ field, special: meta.special })),
    ).toEqual(
      aliasesFor('courses').map(({ alias }) => ({
        field: alias.field,
        special: ['o2m'],
      })),
    );
    expect(courses?.fields.some(({ field }) => field === 'id')).toBe(false);

    const operations = bodies.find(
      ({ collection }) => collection === 'data_operations',
    );

    expect(operations?.meta).toMatchObject({ hidden: true, singleton: true });
    expect(operations?.schema).toEqual({});
  });

  test('issues no mutating call on an already installed project', async () => {
    const { request, requests } = fakeDirectus(installedState());

    const summary = await installDataModel(request);

    expect(mutations(requests)).toEqual([]);
    expect(summary).toEqual({
      collections: { adopted: 0, created: 0, refused: 0, skipped: 25 },
      fields: { adopted: 0, created: 0, refused: 0, skipped: totalFields },
      relations: {
        adopted: 0,
        created: 0,
        refused: 0,
        skipped: modelRelations.length,
      },
    });
    expect(requests.filter(({ method }) => method === 'GET')).toHaveLength(
      1 + 25 * 2,
    );
  });

  test('turns the licence cap into an actionable failure', async () => {
    const { request, requests } = fakeDirectus(
      emptyState(),
      new Map([['POST /collections', limitError]]),
    );

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(CollectionLimitError);
    expect(failure instanceof Error && failure.message).toContain(
      'LIMIT_EXCEEDED',
    );
    expect(failure instanceof Error && failure.message).toContain(
      '25 collections',
    );
    expect(failure instanceof CollectionLimitError && failure.collection).toBe(
      'courses',
    );
    expect(mutations(requests)).toHaveLength(1);
  });

  test('rethrows other request failures untouched', async () => {
    const outage = new DirectusRequestError('POST /collections returned 500', {
      code: 'INTERNAL_SERVER_ERROR',
      reason: null,
      status: 500,
    });
    const { request } = fakeDirectus(
      emptyState(),
      new Map([['POST /collections', outage]]),
    );

    await expect(installDataModel(request)).rejects.toBe(outage);
  });
});

describe('installDataModel over existing definitions', () => {
  test('refuses an incompatible existing column before any mutation', async () => {
    const state = installedState([findCollection('students')]);
    const students = state.fields['students'] ?? [];
    state.fields['students'] = students.map((field) =>
      field.field === 'index_number' ? { ...field, type: 'integer' } : field,
    );
    const { request, requests } = fakeDirectus(state);

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(SchemaRefusalError);

    if (!(failure instanceof SchemaRefusalError)) {
      return;
    }

    expect(failure.refusals).toEqual([
      {
        collection: 'students',
        field: 'index_number',
        reason:
          'Field students.index_number has type integer but the model declares string',
      },
    ]);
    expect(failure.summary.collections).toEqual({
      adopted: 0,
      created: 24,
      refused: 0,
      skipped: 1,
    });
    expect(failure.summary.fields.refused).toBe(1);
    expect(mutations(requests)).toEqual([]);
  });

  test('refuses folders, alias clashes, foreign relations and diverging nullability', async () => {
    const state = installedState([
      findCollection('courses'),
      findCollection('curriculum_entries'),
      findCollection('course_curricula'),
    ]);
    state.collections.push({ collection: 'students', meta: {}, schema: null });
    state.fields['courses'] = (state.fields['courses'] ?? []).map((field) =>
      field.field === 'curricula'
        ? { ...field, meta: { special: null } }
        : field,
    );
    state.relations['course_curricula'] = (
      state.relations['course_curricula'] ?? []
    ).map((relation) =>
      relation.field === 'entry'
        ? { ...relation, related_collection: 'rooms' }
        : relation,
    );
    state.fields['course_curricula'] = (
      state.fields['course_curricula'] ?? []
    ).map((field) =>
      field.field === 'credits' && field.schema !== null
        ? { ...field, schema: { ...field.schema, is_nullable: false } }
        : field,
    );
    state.fields['curriculum_entries'] = (
      state.fields['curriculum_entries'] ?? []
    ).map((field) =>
      field.field === 'name' && field.schema !== null
        ? { ...field, schema: { ...field.schema, is_nullable: true } }
        : field,
    );
    const { request, requests } = fakeDirectus(state);

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(SchemaRefusalError);

    if (!(failure instanceof SchemaRefusalError)) {
      return;
    }

    expect(failure.refusals.map(({ reason }) => reason)).toEqual([
      'Field courses.curricula is not an O2M alias but the model declares one',
      'Collection students exists as a folder without a table',
      'Field curriculum_entries.name is nullable but the model declares it required',
      'Field course_curricula.credits is NOT NULL without a default but the model declares it nullable',
      'Relation course_curricula.entry targets rooms but the model targets curriculum_entries',
    ]);
    expect(failure.summary.fields.refused).toBe(3);
    expect(failure.message).toContain('Collection students exists as a folder');
    expect(mutations(requests)).toEqual([]);
  });
});
