import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { curriculumGuards } from '../directus/extensions/directus-extension-data-operations/src/curriculum-guards.js';
import {
  migrations,
  schemaConstraints,
} from '../directus/extensions/directus-extension-data-operations/src/migrations.js';
import {
  requiredFields,
  snapshotFields,
  snapshotFieldTable,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import {
  dataModelCollectionKeys,
  dataModelCollections,
} from '../src/data-model/collections.js';
import {
  enumMaxLength,
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { choiceValues, scalar } from '../src/data-model/fields.js';
import {
  CollectionLimitError,
  installDataModel,
} from '../src/data-model/install.js';
import {
  aliasesFor,
  compositeKeys,
  modelRelations,
  relationsOf,
  toRelationPayload,
} from '../src/data-model/relations.js';
import { DirectusRequestError } from '../src/directus-request.js';
import { type CompositeKey } from '../src/schema-relations.js';
import {
  type ModelCollection,
  type ModelField,
  type ModelRelationField,
} from '../src/schema.js';
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

const declaresField = (collection: string, name: string): boolean =>
  findCollection(collection).fields.some(({ field }) => field === name);

const enumOf = (collection: string, field: string) => {
  const found = findField(collection, field);
  if (found.kind !== 'enum') {
    throw new Error(`${collection}.${field} is not an enum`);
  }
  return found;
};

// Every enum field of a collection, with the collection's name.
const enumsOf = ({ collection, fields }: ModelCollection) =>
  fields.flatMap((field) =>
    field.kind === 'enum' ? [{ collection, field }] : [],
  );

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

const limitError = new DirectusRequestError(
  'POST /collections: HTTP 403 LIMIT_EXCEEDED',
  {
    code: 'LIMIT_EXCEEDED',
    reason: null,
    status: 403,
  },
);

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
  schema: z.object({ on_delete: z.enum(['CASCADE', 'NO ACTION', 'SET NULL']) }),
});

describe('target collections', () => {
  test('declares every collection exactly once, the imported content first', () => {
    expect(dataModelCollectionKeys).toHaveLength(26);
    expect(new Set(dataModelCollectionKeys).size).toBe(26);
    expect(dataModelCollectionKeys.slice(0, 9)).toEqual([
      'courses',
      'staff',
      'rooms',
      'students',
      'course_equivalencies',
      'teaching_assignments',
      'discord_channels',
      'student_council',
      'deans_office',
    ]);
  });

  test('keeps the published columns on a course plus the one channel link, and the course links its curriculum', () => {
    expect(
      findCollection('courses').fields.map(({ field, kind, nullable }) => [
        field,
        kind,
        nullable,
      ]),
    ).toEqual([
      ['name', 'string', false],
      ['status', 'enum', false],
      ['tags', 'string', true],
      ['discord_channel', 'm2o', true],
    ]);
    expect(
      findCollection('teaching_assignments').fields.map(({ field }) => field),
    ).toEqual(['course', 'staff', 'role', 'sort']);
    expect(
      findCollection('student_council').fields.map(({ field }) => field),
    ).toEqual(['year', 'index_number', 'position', 'student']);
  });

  test('declares the snapshot and the staging rows from the snapshot field table', () => {
    const staging = findCollection('moodle_import_rows');

    expect(staging.hidden).toBeTruthy();

    for (const { fields } of [findCollection('moodle_users'), staging]) {
      expect(fields.map(({ field }) => field)).toEqual(snapshotFields);
      expect(fields.map(({ kind }) => kind)).toEqual(
        snapshotFieldTable.map(({ kind }) => kind),
      );
      expect(
        fields.filter(({ nullable }) => !nullable).map(({ field }) => field),
      ).toEqual(requiredFields);
    }
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
      'last_run_retries',
      'last_error_code',
      'import_state',
      'publication_state',
      'publication_outcomes',
      'source_revision',
      'claim_domain',
      'claim_revision',
      'claim_fingerprint',
      'claim_started_at',
      'claim_heartbeat_at',
      'claim_pages',
      'claim_staged',
      'claim_retries',
      'last_error_at',
      'last_failed_revision',
      'last_failed_domain',
      'last_failed_fingerprint',
      'last_error_retries',
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
    expect(findCollection('data_operation_matches').hidden).toBeTruthy();
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
    const count = findField('course_enrollments', 'count');

    expect(count.kind === 'integer' && count.minimum).toBe(0);
    expect(toFieldPayload(count, 5).meta.validation).toEqual({
      count: { _gte: 0 },
    });

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

  test('keeps a new academic year out of the public files until it is published', () => {
    const published = findField('academic_years', 'published');

    expect(published).toMatchObject({
      defaultValue: false,
      kind: 'boolean',
      nullable: false,
    });
    expect(toFieldPayload(published, 3)).toMatchObject({
      schema: { default_value: false, is_nullable: false },
      type: 'boolean',
    });
  });

  test('declares composite keys only where the domain table says unique', () => {
    expect(
      compositeKeys.map(
        ({ collection, columns, kind }) =>
          `${kind} ${collection} (${columns.join(', ')})`,
      ),
    ).toEqual([
      'unique teaching_assignments (course, staff, role)',
      'unique course_curricula (course, generation)',
      'unique study_programs (generation, code)',
      'unique curriculum_entry_program_states (entry, program)',
      'unique course_equivalency_members (equivalency, generation)',
      'unique moodle_history_memberships (moodle_user, entry)',
      'index moodle_history_memberships (entry)',
      'unique moodle_course_mappings (entry, course, academic_year)',
      'index moodle_course_mappings (course, academic_year)',
      'unique moodle_pattern_mappings (course, pattern, year_pattern, only_in_year)',
      'index moodle_pattern_mappings (course, only_in_year)',
      'unique moodle_counted_lines (entry, course, academic_year, pattern_mapping)',
      'unique data_operation_matches (claim_token, page_token, entry, pattern_mapping)',
      'unique course_enrollments (course, academic_year)',
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
      const nulls = key.nullsNotDistinct === true ? ' NULLS NOT DISTINCT' : '';

      expect(schemaConstraints.statements).toContain(
        `CREATE ${key.kind === 'unique' ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${key.name}" ON "${key.collection}" (${columns})${nulls}`,
      );
    }
    for (const statement of schemaConstraints.statements) {
      expect(statement).toMatch(statementStartPattern);
      expect(statement).not.toMatch(dropPattern);
    }
  });

  test('guards every generation reference and nonnegative counts in SQL', () => {
    const sql = schemaConstraints.statements.join('\n');

    expect(sql).toContain('CHECK ("count" >= 0)');

    for (const trigger of [
      '"course_curricula_generation_guard" BEFORE INSERT OR UPDATE OF "entry", "generation" ON "course_curricula"',
      '"curriculum_entries_generation_guard" BEFORE INSERT OR UPDATE OF "generation" ON "curriculum_entries"',
      '"curriculum_entries_code_guard" BEFORE INSERT OR UPDATE OF "code" ON "curriculum_entries"',
      '"curriculum_entry_program_states_generation_guard" BEFORE INSERT OR UPDATE OF "entry", "program" ON "curriculum_entry_program_states"',
      '"course_equivalency_members_generation_guard" BEFORE INSERT OR UPDATE OF "entry", "generation" ON "course_equivalency_members"',
      '"study_programs_generation_guard" BEFORE UPDATE OF "generation" ON "study_programs"',
      '"curriculum_generations_curriculum_guard" BEFORE UPDATE OF "has_curriculum" ON "curriculum_generations"',
    ]) {
      expect(sql).toContain(`CREATE OR REPLACE TRIGGER ${trigger}`);
    }

    expect(curriculumGuards.map(({ table }) => table)).toEqual([
      'course_curricula',
      'curriculum_entries',
      'curriculum_entries',
      'curriculum_entry_program_states',
      'course_equivalency_members',
      'study_programs',
      'curriculum_generations',
    ]);
    // A generation id compares as an integer; a label-only generation
    // takes no entry, and an entry keeps its generation while dependants
    // carry it.
    expect(sql).toContain('entry_generation integer;');
    expect(sql).toContain('IF curriculum IS DISTINCT FROM true THEN');
    expect(sql).toContain(
      '"course_equivalency_members" WHERE "entry" = NEW."id"',
    );
    // Nine curriculum refusals and one per key guard (key-guards.ts).
    expect(sql.match(/ERRCODE = 'foreign_key_violation'/gu)).toHaveLength(12);
  });
});

describe('curriculum generations and study programs as rows', () => {
  test('relate entries, links, programs and members to generation rows, never an enum', () => {
    for (const collection of [
      'curriculum_entries',
      'course_curricula',
      'study_programs',
      'course_equivalency_members',
    ]) {
      expect(findField(collection, 'generation')).toMatchObject({
        kind: 'm2o',
        nullable: false,
        onDelete: 'NO ACTION',
        related: 'curriculum_generations',
      });
    }

    expect(
      dataModelCollections
        .flatMap(enumsOf)
        .filter(({ field }) => field.field === 'generation'),
    ).toEqual([]);
  });

  test('declare generations and programs unpublished until published', () => {
    expect(findField('curriculum_generations', 'code')).toMatchObject({
      kind: 'string',
      nullable: false,
      unique: true,
    });

    for (const [collection, field] of [
      ['curriculum_generations', 'published'],
      ['curriculum_generations', 'has_curriculum'],
      ['study_programs', 'published'],
    ] as const) {
      expect(findField(collection, field)).toMatchObject({
        defaultValue: false,
        kind: 'boolean',
        nullable: false,
      });
    }

    expect(
      findCollection('study_programs').fields.map(({ field }) => field),
    ).toEqual(['generation', 'code', 'name', 'description', 'published']);
  });

  test('replace the flat state columns with state rows edited as a many-to-many from the entry', () => {
    const entryFields = findCollection('curriculum_entries').fields.map(
      ({ field }) => field,
    );

    expect(entryFields.filter((field) => field.startsWith('state_'))).toEqual(
      [],
    );
    expect(relationsOf('curriculum_entry_program_states')).toMatchObject([
      {
        alias: { field: 'program_states', junction: 'program' },
        field: 'entry',
        junction: 'program',
        onDelete: 'CASCADE',
        related: 'curriculum_entries',
      },
      {
        field: 'program',
        junction: 'entry',
        onDelete: 'NO ACTION',
        related: 'study_programs',
      },
    ]);
    expect(
      toAliasPayload(
        aliasesFor('curriculum_entries').find(
          ({ alias }) => alias.field === 'program_states',
        )?.alias ?? { field: '', fields: [], template: '' },
        20,
      ).meta,
    ).toMatchObject({
      interface: 'list-m2m',
      options: {
        enableCreate: false,
        enableSelect: true,
        junctionFieldLocation: 'top',
      },
      special: ['m2m'],
    });
  });

  test('keep equivalency members per generation, with a literal read-only label and a nullable entry', () => {
    expect(
      findCollection('course_equivalencies').fields.map(({ field }) => field),
    ).toEqual(['course']);

    const label = findField('course_equivalency_members', 'label');

    expect(label.readOnly).toBeTruthy();
    expect(findField('course_equivalency_members', 'entry')).toMatchObject({
      nullable: true,
      onDelete: 'SET NULL',
      related: 'curriculum_entries',
    });
    expect(
      findField('course_equivalency_members', 'equivalency'),
    ).toMatchObject({
      alias: { field: 'members' },
      onDelete: 'CASCADE',
    });
  });
});

describe('enumerations', () => {
  test('declares the role and operation states with their labels', () => {
    expect(enumOf('teaching_assignments', 'role').choices).toEqual([
      { label: 'Professor', value: 'professor' },
      { label: 'Assistant', value: 'assistant' },
    ]);
    expect(enumOf('teaching_assignments', 'role').nullable).toBe(false);
    expect(enumOf('data_operations', 'import_state').defaultValue).toBe('idle');
    expect(enumOf('data_operations', 'publication_state').defaultValue).toBe(
      'idle',
    );
  });

  test('records publication outcomes in one map and knows the partial state', () => {
    const operations = findCollection('data_operations');
    const fields = operations.fields.map(({ field }) => field);

    expect(enumOf('data_operations', 'publication_state').choices).toEqual([
      { label: 'Idle', value: 'idle' },
      { label: 'Running', value: 'running' },
      { label: 'Completed', value: 'completed' },
      { label: 'Partial', value: 'partial' },
      { label: 'Failed', value: 'failed' },
    ]);
    // One JSON map keyed by filename; no column per published file, so a
    // new export definition changes no schema.
    expect(fields.filter((field) => field.startsWith('publish_'))).toEqual([]);
    expect(
      operations.fields.find(({ field }) => field === 'publication_outcomes'),
    ).toMatchObject({ kind: 'json', readOnly: true });
  });

  test('gives every enum one distinct value and a label per choice', () => {
    const enums = dataModelCollections.flatMap(enumsOf);

    expect(enums.length).toBeGreaterThanOrEqual(7);

    for (const { collection, field } of enums) {
      const values = choiceValues(field);

      expect(new Set(values).size, `${collection}.${field.field}`).toBe(
        values.length,
      );
      expect(
        field.choices.filter(({ label }) => label.trim() === ''),
        `${collection}.${field.field}`,
      ).toEqual([]);
    }
  });

  test('builds server-enforced dropdowns for enums', () => {
    const payload = toFieldPayload(enumOf('courses', 'status'), 3);

    expect(payload).toMatchObject({
      field: 'status',
      meta: {
        interface: 'select-dropdown',
        options: {
          allowNone: false,
          allowOther: false,
          choices: [
            { text: 'Active', value: 'active' },
            { text: 'All professors', value: 'all_professors' },
            { text: 'Inactive', value: 'inactive' },
          ],
        },
        required: true,
        sort: 3,
        validation: {
          status: { _in: ['active', 'all_professors', 'inactive'] },
        },
      },
      schema: {
        default_value: 'active',
        is_nullable: false,
        max_length: enumMaxLength,
      },
      type: 'string',
    });

    const domain = enumOf('data_operations', 'claim_domain');
    const optional = toFieldPayload(domain, 1);

    expect(optional.meta.validation).toEqual({
      _or: [
        { claim_domain: { _null: true } },
        { claim_domain: { _in: choiceValues(domain) } },
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

      const m2m = relation.alias.junction !== undefined;

      expect(toAliasPayload(relation.alias, 9)).toMatchObject({
        field: relation.alias.field,
        meta: {
          interface: m2m ? 'list-m2m' : 'list-o2m',
          options: {
            enableCreate: !readOnly && !m2m,
            enableSelect: !readOnly,
            fields: relation.alias.fields,
            template: relation.alias.template,
          },
          readonly: readOnly,
          sort: 9,
          special: [m2m ? 'm2m' : 'o2m'],
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
      'moodle_course_entries.counted_for',
      'courses.counted_lines',
      'moodle_pattern_mappings.counted_lines',
      'courses.enrollments',
      'academic_years.enrollments',
    ]);
    expect(
      aliases.filter(({ derived, readOnly }) => derived !== readOnly),
    ).toEqual([]);
  });

  test('exposes the course side of curricula, assignments, mappings and counts', () => {
    expect(aliasesFor('courses').map(({ alias }) => alias.field)).toEqual([
      'equivalencies',
      'assignments',
      'curricula',
      'history_mappings',
      'pattern_mappings',
      'counted_lines',
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
    ).toEqual(['memberships', 'mappings', 'counted_for']);
  });

  test('keeps a drag order only on teaching links and history memberships, each on an integer field of its collection', () => {
    const sorted = modelRelations.flatMap(({ collection, field, sortField }) =>
      sortField === null ? [] : [{ collection, field, sortField }],
    );

    expect(
      sorted.map(
        ({ collection, field, sortField }) =>
          `${collection}.${field}: ${sortField}`,
      ),
    ).toEqual([
      'teaching_assignments.course: sort',
      'moodle_history_memberships.moodle_user: sort',
    ]);
    expect(
      sorted.map(
        ({ collection, sortField }) => findField(collection, sortField).kind,
      ),
    ).toEqual(['integer', 'integer']);
    expect(
      [
        'academic_years',
        'curriculum_generations',
        'study_programs',
        'course_curricula',
        'course_equivalency_members',
      ].filter((collection) => declaresField(collection, 'sort')),
    ).toEqual([]);
  });

  test('keeps the links of imported equivalencies and council members nullable', () => {
    const mandatory = [
      ...relationFields('course_equivalencies'),
      ...relationFields('student_council'),
    ].filter(({ nullable }) => !nullable);

    expect(mandatory).toEqual([]);
    expect(findField('student_council', 'index_number').nullable).toBe(false);
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
        sort_field: null,
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
      relationsOf('data_operation_matches').map(({ alias }) => alias),
    ).toEqual([null, null]);
  });
});

describe('installDataModel on fresh and installed projects', () => {
  test('creates every collection schema-only and then every relation on a fresh project', async () => {
    const { request, requests } = fakeDirectus(emptyState());

    const summary = await installDataModel(request);

    expect(summary).toEqual({
      collections: {
        created: dataModelCollectionKeys.length,
        refused: 0,
        skipped: 0,
      },
      fields: {
        adopted: 0,
        aligned: 0,
        created: totalFields,
        refused: 0,
        skipped: 0,
      },
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

    const collections = changes.slice(0, dataModelCollectionKeys.length);

    expect(collections.map(({ pathname }) => pathname)).toEqual(
      dataModelCollectionKeys.map(() => '/collections'),
    );
    expect(
      collections.map(({ body }) => collectionBody.parse(body).collection),
    ).toEqual(dataModelCollectionKeys);

    const relations = changes.slice(dataModelCollectionKeys.length);

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
      collections: {
        created: 0,
        refused: 0,
        skipped: dataModelCollectionKeys.length,
      },
      fields: {
        adopted: 0,
        aligned: 0,
        created: 0,
        refused: 0,
        skipped: totalFields,
      },
      relations: {
        adopted: 0,
        created: 0,
        refused: 0,
        skipped: modelRelations.length,
      },
    });
    expect(requests.filter(({ method }) => method === 'GET')).toHaveLength(
      1 + dataModelCollectionKeys.length * 2,
    );
  });

  test('turns the licence cap into a refusal naming the collection', async () => {
    const { request, requests } = fakeDirectus(
      emptyState(),
      new Map([['POST /collections', limitError]]),
    );

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(CollectionLimitError);
    expect(failure instanceof Error && failure.message).toBe(
      `collection courses not created: licence collection limit (LIMIT_EXCEEDED); model collections: ${String(dataModelCollectionKeys.length)}`,
    );
    expect(failure instanceof CollectionLimitError && failure.collection).toBe(
      'courses',
    );
    expect(mutations(requests)).toHaveLength(1);
  });

  test('rethrows other request failures untouched', async () => {
    const outage = new DirectusRequestError(
      'POST /collections: HTTP 500 INTERNAL_SERVER_ERROR',
      {
        code: 'INTERNAL_SERVER_ERROR',
        reason: null,
        status: 500,
      },
    );
    const { request } = fakeDirectus(
      emptyState(),
      new Map([['POST /collections', outage]]),
    );

    await expect(installDataModel(request)).rejects.toBe(outage);
  });
});
