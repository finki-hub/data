import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  installDataModel,
  SchemaRefusalError,
} from '../src/data-model/install.js';
import { modelRelations, relationsOf } from '../src/data-model/relations.js';
import {
  fakeDirectus,
  type FakeRelation,
  findCollection,
  installedCollection,
  installedField,
  installedRelation,
  installedState,
  mutations,
  primaryKeyField,
} from './data-model-test-helpers.js';

const fieldBody = z.object({ field: z.string(), type: z.string() });

const alignedCourseLink = {
  collection: 'course_curricula',
  field: 'course',
  meta: {
    one_deselect_action: 'delete',
    one_field: 'curricula',
    sort_field: 'sort',
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

describe('installDataModel adoption', () => {
  test('adopts unmanaged collections, columns, flags and foreign keys additively', async () => {
    const state = installedState([
      findCollection('academic_years'),
      findCollection('moodle_users'),
    ]);
    const label = state.fields['academic_years']?.find(
      ({ field }) => field === 'label',
    );
    state.collections = state.collections.map((collection) =>
      collection.collection === 'moodle_users'
        ? { ...collection, meta: null }
        : collection,
    );
    const unmanaged = (state.fields['moodle_users'] ?? [])
      .filter(({ field, schema }) => field !== 'id' && schema !== null)
      .map((field) => ({ ...field, meta: null }));
    state.fields['moodle_users'] = [primaryKeyField, ...unmanaged];
    state.fields['academic_years'] = [
      primaryKeyField,
      ...(label?.schema
        ? [{ ...label, schema: { ...label.schema, is_unique: false } }]
        : []),
    ];
    const curricula = findCollection('course_curricula');
    state.collections.push(installedCollection(curricula).collection);
    state.fields['course_curricula'] = [
      primaryKeyField,
      ...curricula.fields.map((field, index) =>
        installedField(field, index + 1),
      ),
    ];
    state.relations['course_curricula'] = [
      {
        collection: 'course_curricula',
        field: 'course',
        meta: null,
        related_collection: 'courses',
        schema: { on_delete: 'NO ACTION' },
      },
    ];
    const { request, requests } = fakeDirectus(state);

    const summary = await installDataModel(request);

    const changes = mutations(requests);
    const patches = changes.filter(({ method }) => method === 'PATCH');

    expect(patches.map(({ pathname }) => pathname)).toEqual([
      '/collections/moodle_users',
      ...unmanaged.map(
        ({ field }) => `/fields/moodle_users/${encodeURIComponent(field)}`,
      ),
      '/fields/academic_years/label',
      '/relations/course_curricula/course',
    ]);
    expect(unmanaged).toHaveLength(38);
    expect(patches.map(({ pathname }) => pathname)).toContain(
      '/fields/moodle_users/Courses%20Count',
    );

    const metaOnly = patches
      .filter(({ pathname }) => pathname.startsWith('/fields/moodle_users/'))
      .map(({ body }) => Object.keys(z.looseObject({}).parse(body)));

    expect(new Set(metaOnly.map((keys) => keys.join(',')))).toEqual(
      new Set(['meta']),
    );
    expect(
      patches.find(({ pathname }) => pathname === '/collections/moodle_users')
        ?.body,
    ).toEqual({
      meta: {
        display_template: '{{Name}}',
        hidden: false,
        icon: 'person',
        note: 'Private Moodle profile snapshot. Use Studio search and filters instead of the Пребарување sheet.',
        singleton: false,
        sort: 13,
      },
    });
    expect(
      patches.find(
        ({ pathname }) => pathname === '/fields/academic_years/label',
      )?.body,
    ).toEqual({
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
    expect(
      patches.find(
        ({ pathname }) => pathname === '/relations/course_curricula/course',
      )?.body,
    ).toEqual(alignedCourseLink);

    const posts = changes.filter(({ method }) => method === 'POST');
    const postPaths = posts.map(({ pathname }) => pathname);

    expect(postPaths.filter((path) => path === '/collections')).toHaveLength(
      22,
    );
    expect(postPaths.filter((path) => path === '/relations')).toHaveLength(
      modelRelations.length - 1,
    );
    expect(postPaths.filter((path) => path.startsWith('/fields/'))).toEqual([
      '/fields/academic_years',
      '/fields/moodle_users',
      '/fields/academic_years',
      '/fields/academic_years',
      '/fields/academic_years',
    ]);
    expect(
      posts
        .filter(({ pathname }) => pathname.startsWith('/fields/'))
        .map(({ body }) => fieldBody.parse(body)),
    ).toEqual([
      { field: 'sort', type: 'integer' },
      { field: 'history_memberships', type: 'alias' },
      { field: 'mappings', type: 'alias' },
      { field: 'enrollment_rules', type: 'alias' },
      { field: 'enrollments', type: 'alias' },
    ]);
    expect(summary.collections).toEqual({
      adopted: 1,
      created: 22,
      refused: 0,
      skipped: 2,
    });
    expect(summary.relations).toEqual({
      adopted: 1,
      created: modelRelations.length - 1,
      refused: 0,
      skipped: 0,
    });
    expect(summary.fields).toMatchObject({ adopted: 39, refused: 0 });
  });
});

describe('installDataModel relation alignment', () => {
  test.each([
    ['delete rule', { schema: { on_delete: 'NO ACTION' } }],
    ['sort field', { meta: { one_field: 'curricula', sort_field: null } }],
    [
      'deselect action',
      {
        meta: {
          one_deselect_action: 'nullify',
          one_field: 'curricula',
          sort_field: 'sort',
        },
      },
    ],
    ['reverse alias', { meta: { one_field: null, sort_field: 'sort' } }],
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
        sort_field: 'sort',
      },
    });

    const failure = await failureOf(installDataModel(request));

    expect(failure).toBeInstanceOf(SchemaRefusalError);
    expect(
      failure instanceof SchemaRefusalError &&
        failure.refusals.map(({ reason }) => reason),
    ).toEqual([
      'Relation course_curricula.course has reverse alias other_links but the model declares curricula',
    ]);
    expect(mutations(requests)).toEqual([]);
  });

  test('leaves a reverse alias the model does not declare in place', async () => {
    const state = installedState();
    state.relations['data_operation_results'] = (
      state.relations['data_operation_results'] ?? []
    ).map((relation) =>
      relation.field === 'course'
        ? { ...relation, meta: { ...relation.meta, one_field: 'results' } }
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
