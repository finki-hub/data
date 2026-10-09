import { describe, expect, test } from 'vitest';

import { dataModelCollections } from '../src/data-model/collections.js';
import { enumChoiceMeta } from '../src/data-model/field-payloads.js';
import {
  installDataModel,
  SchemaRefusalError,
} from '../src/data-model/install.js';
import {
  aliasesFor,
  modelRelations,
  relationsOf,
} from '../src/data-model/relations.js';
import {
  fakeDirectus,
  type FakeRelation,
  findCollection,
  findField,
  installedRelation,
  installedState,
  mutations,
} from './data-model-test-helpers.js';

const alignedCourseLink = {
  collection: 'course_curricula',
  field: 'course',
  meta: {
    one_deselect_action: 'delete',
    one_field: 'curricula',
    sort_field: null,
  },
  related_collection: 'courses',
  schema: { on_delete: 'CASCADE' },
};

const courseLink = (): FakeRelation => {
  const relation = relationsOf('course_curricula').find(
    ({ field }) => field === 'course',
  );
  if (relation === undefined) {
    throw new Error('course_curricula.course is not part of the model');
  }
  return installedRelation(relation);
};

// A fully installed project whose course_curricula.course relation is
// replaced by the given variant.
const withCourseLink = (variant: FakeRelation) => {
  const state = installedState();
  state.relations['course_curricula'] = (
    state.relations['course_curricula'] ?? []
  ).map((relation) => (relation.field === 'course' ? variant : relation));
  return fakeDirectus(state);
};

const failureOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

describe('installDataModel over a Studio edit', () => {
  test('restores a unique flag a Studio edit removed and aligns a relation, creating nothing', async () => {
    const state = installedState();
    state.fields['academic_years'] = (state.fields['academic_years'] ?? []).map(
      (field) =>
        field.field === 'label' && field.schema !== null
          ? { ...field, schema: { ...field.schema, is_unique: false } }
          : field,
    );
    state.relations['course_curricula'] = (
      state.relations['course_curricula'] ?? []
    ).map((relation) =>
      relation.field === 'course'
        ? { ...relation, meta: null, schema: { on_delete: 'NO ACTION' } }
        : relation,
    );
    const { request, requests } = fakeDirectus(state);

    const summary = await installDataModel(request);
    const changes = mutations(requests);

    expect(
      changes.map(({ method, pathname }) => `${method} ${pathname}`),
    ).toEqual([
      'PATCH /fields/academic_years/label',
      'PATCH /relations/course_curricula/course',
    ]);
    expect(changes[0]?.body).toEqual({
      schema: {
        default_value: null,
        is_indexed: false,
        is_nullable: false,
        is_unique: true,
        max_length: null,
        numeric_precision: null,
        numeric_scale: null,
      },
    });
    expect(changes[1]?.body).toEqual(alignedCourseLink);
    expect(summary.collections).toMatchObject({ created: 0, refused: 0 });
    expect(summary.fields).toMatchObject({ adopted: 1, created: 0 });
    expect(summary.relations).toMatchObject({ adopted: 1, created: 0 });
  });

  test('refuses, before any mutation, a table or column Directus does not manage', async () => {
    const state = installedState([
      findCollection('academic_years'),
      findCollection('moodle_users'),
    ]);
    state.collections = state.collections.map((collection) =>
      collection.collection === 'moodle_users'
        ? { ...collection, meta: null }
        : collection,
    );
    state.fields['academic_years'] = (state.fields['academic_years'] ?? []).map(
      (field) => (field.field === 'label' ? { ...field, meta: null } : field),
    );
    const { request, requests } = fakeDirectus(state);

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(SchemaRefusalError);
    expect(
      failure instanceof SchemaRefusalError &&
        failure.refusals.map(({ reason }) => reason),
    ).toEqual([
      'Field academic_years.label: column not managed by Directus',
      'Collection moodle_users: table not managed by Directus',
    ]);
    expect(mutations(requests)).toEqual([]);
  });
});

describe('installDataModel relation alignment', () => {
  test.each([
    ['delete rule', { schema: { on_delete: 'NO ACTION' } }],
    ['sort field', { meta: { one_field: 'curricula', sort_field: 'sort' } }],
    [
      'deselect action',
      {
        meta: {
          one_deselect_action: 'nullify',
          one_field: 'curricula',
          sort_field: null,
        },
      },
    ],
    ['reverse alias', { meta: { one_field: null, sort_field: null } }],
    ['foreign key', { schema: null }],
  ])(
    'realigns a relation whose %s diverges with the full relation payload',
    async (_, variant) => {
      const { request, requests } = withCourseLink({
        ...courseLink(),
        ...variant,
      });

      const summary = await installDataModel(request);

      expect(mutations(requests)).toEqual([
        {
          body: alignedCourseLink,
          method: 'PATCH',
          pathname: '/relations/course_curricula/course',
        },
      ]);
      expect(summary.relations).toEqual({
        adopted: 1,
        created: 0,
        refused: 0,
        skipped: modelRelations.length - 1,
      });
    },
  );

  test('refuses a relation whose reverse alias already points elsewhere', async () => {
    const { request, requests } = withCourseLink({
      ...courseLink(),
      meta: {
        one_deselect_action: 'delete',
        one_field: 'other_links',
        sort_field: null,
      },
    });

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(SchemaRefusalError);
    expect(
      failure instanceof SchemaRefusalError &&
        failure.refusals.map(({ reason }) => reason),
    ).toEqual([
      'Relation course_curricula.course: reverse alias other_links, expected curricula',
    ]);
    expect(mutations(requests)).toEqual([]);
  });

  test('leaves a reverse alias the model does not declare in place', async () => {
    const state = installedState();
    const matches = state.relations['data_operation_matches'] ?? [];

    expect(matches.map(({ field }) => field)).toContain('entry');

    state.relations['data_operation_matches'] = matches.map((relation) =>
      relation.field === 'entry'
        ? { ...relation, meta: { ...relation.meta, one_field: 'matches' } }
        : relation,
    );
    const { request, requests } = fakeDirectus(state);

    const summary = await installDataModel(request);

    expect(mutations(requests)).toEqual([]);
    expect(summary.relations).toEqual({
      adopted: 0,
      created: 0,
      refused: 0,
      skipped: modelRelations.length,
    });
  });
});

// The declared choice meta of an installed enum, as setup writes it.
const declaredChoices = (collection: string, field: string) => {
  const declared = findField(collection, field);
  if (declared.kind !== 'enum') {
    throw new Error(`${collection}.${field} is not an enum`);
  }
  return enumChoiceMeta(declared);
};

// A Studio user's edits of an enum field's form: the keys setup never
// writes, and an option of its own.
const studioEdits = {
  conditions: [
    { hidden: true, name: 'Synthetic rule', rule: { id: { _null: true } } },
  ],
  group: 'synthetic_group',
  note: 'Synthetic Studio note',
  sort: 42,
  width: 'full',
};

// An installed project whose teaching_assignments.role still carries an
// earlier vocabulary (professor and a retired lecturer, unlabelled) and a
// Studio user's edits.
const driftedRole = (values: readonly unknown[] = []) => {
  const state = installedState();
  const earlier = [
    { text: 'professor', value: 'professor' },
    { text: 'lecturer', value: 'lecturer' },
  ];
  state.fields['teaching_assignments'] = (
    state.fields['teaching_assignments'] ?? []
  ).map((field) =>
    field.field === 'role'
      ? {
          ...field,
          meta: {
            ...field.meta,
            ...studioEdits,
            display_options: { choices: earlier, showAsDot: true },
            options: {
              allowNone: true,
              allowOther: false,
              choices: earlier,
              placeholder: 'Synthetic placeholder',
            },
            validation: {
              _or: [
                { role: { _null: true } },
                { role: { _in: ['professor', 'lecturer'] } },
              ],
            },
          },
        }
      : field,
  );
  state.values = { 'teaching_assignments.role': values };
  return state;
};

// Every column and alias of the model, as a rerun counts them.
const totalFields = dataModelCollections.reduce(
  (sum, { collection, fields }) =>
    sum + fields.length + aliasesFor(collection).length,
  0,
);

describe('installDataModel enum realignment', () => {
  test('realigns drifted choices and rule by merge, keeping every key Studio owns', async () => {
    const { request, requests } = fakeDirectus(
      driftedRole(['professor', null, 'assistant']),
    );

    const summary = await installDataModel(request);
    const declared = declaredChoices('teaching_assignments', 'role');

    expect(mutations(requests)).toEqual([
      {
        body: {
          meta: {
            display_options: { ...declared.display_options, showAsDot: true },
            options: {
              ...declared.options,
              placeholder: 'Synthetic placeholder',
            },
            validation: declared.validation,
          },
        },
        method: 'PATCH',
        pathname: '/fields/teaching_assignments/role',
      },
    ]);
    expect(declared.options).toMatchObject({
      choices: [
        { text: 'Professor', value: 'professor' },
        { text: 'Assistant', value: 'assistant' },
      ],
    });
    // A required role: the realigned rule no longer admits an empty one.
    expect(declared.validation).toEqual({
      role: { _in: ['professor', 'assistant'] },
    });
    expect(summary.fields).toMatchObject({
      adopted: 0,
      aligned: 1,
      refused: 0,
      skipped: totalFields - 1,
    });
    expect(
      requests
        .map(({ pathname }) => pathname)
        .filter((path) => path.startsWith('/items/')),
    ).toEqual([
      '/items/teaching_assignments?aggregate[count]=*&groupBy[]=role&limit=-1',
    ]);
  });

  test('writes nothing once the field carries the declared choices, whatever Studio edited', async () => {
    const state = installedState();
    state.fields['teaching_assignments'] = (
      state.fields['teaching_assignments'] ?? []
    ).map((field) =>
      field.field === 'role'
        ? { ...field, meta: { ...field.meta, ...studioEdits } }
        : field,
    );
    const { request, requests } = fakeDirectus(state);

    const summary = await installDataModel(request);

    expect(mutations(requests)).toEqual([]);
    expect(
      requests.some(({ pathname }) => pathname.startsWith('/items/')),
    ).toBe(false);
    expect(summary.fields).toMatchObject({ aligned: 0, skipped: totalFields });
  });

  test('refuses, before any write, a field holding a value its declaration no longer accepts', async () => {
    const { request, requests } = fakeDirectus(
      driftedRole(['professor', 'lecturer', 'lecturer']),
    );

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(SchemaRefusalError);

    if (!(failure instanceof SchemaRefusalError)) {
      throw new Error('expected a refusal');
    }

    expect(mutations(requests)).toEqual([]);
    expect(failure.refusals).toEqual([
      {
        collection: 'teaching_assignments',
        field: 'role',
        reason:
          'Field teaching_assignments.role: 1 value outside declared choices: "lecturer"',
      },
    ]);
    expect(failure.summary.fields).toMatchObject({ aligned: 0, refused: 1 });
  });

  test('reads the one value of a singleton field before realigning it', async () => {
    const state = installedState();
    state.fields['data_operations'] = (
      state.fields['data_operations'] ?? []
    ).map((field) =>
      field.field === 'publication_state'
        ? {
            ...field,
            meta: {
              ...field.meta,
              validation: { publication_state: { _in: ['idle', 'running'] } },
            },
          }
        : field,
    );
    state.values = { 'data_operations.publication_state': ['running'] };
    const { request, requests } = fakeDirectus(state);

    const summary = await installDataModel(request);

    expect(
      requests
        .map(({ pathname }) => pathname)
        .filter((path) => path.startsWith('/items/')),
    ).toEqual(['/items/data_operations?fields=publication_state']);
    expect(mutations(requests).map(({ pathname }) => pathname)).toEqual([
      '/fields/data_operations/publication_state',
    ]);
    expect(summary.fields.aligned).toBe(1);
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
        reason: 'Field students.index_number: type integer, expected string',
      },
    ]);
    expect(failure.summary.collections).toEqual({
      created: dataModelCollections.length - 1,
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
      'Field courses.curricula: not an O2M alias, expected O2M alias',
      'Collection students: folder without table',
      'Field curriculum_entries.name: nullable, expected required',
      'Field course_curricula.credits: NOT NULL without default, expected nullable',
      'Relation course_curricula.entry: target rooms, expected curriculum_entries',
    ]);
    expect(failure.summary.fields.refused).toBe(3);
    expect(failure.message).toBe('data model: 5 incompatible definitions');
    expect(mutations(requests)).toEqual([]);
  });
});
