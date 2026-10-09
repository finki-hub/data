import assert from 'node:assert/strict';
import { test } from 'node:test';

import { schemaConstraints } from '../../directus/extensions/directus-extension-data-operations/src/migrations.js';
import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import { applySchemaConstraints } from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { modelRelations } from '../../src/data-model/relations.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import { databaseContainer, psql } from './automatic-processing-helpers.mjs';
import {
  adminRequest,
  assertNoAccessResidue,
  createItem,
  errorCode,
  json,
  read,
  recording,
  rejectedItem,
  request,
  schemaCounts,
  teardownOrder,
  userCollections,
  withDataModel,
  withRestrictedUser,
} from './data-model-helpers.mjs';

const missingUrlPattern = /DIRECTUS_SEARCH_TEST_URL/u;
const loopbackPattern = /loopback-only/u;
const migrationsPath = '/finki-hub-data-operations/migrations';
const courseLinkPath = '/relations/course_curricula/course';
// Keys and indexes, the curriculum guards (generation and code) and the
// key guards (a function and a trigger each), then the shared write guard
// function and one statement trigger per guarded table of the
// collection-role registry.
const expectedStatements = schemaConstraints.statements.length;
const longLabel = `Synthetic history entry ${'x'.repeat(300)}`;
const stillHoldsTerms =
  /violates foreign key constraint \\"deans_office_staff_foreign\\"/u;
const needsDatabase =
  databaseContainer === undefined
    ? 'DIRECTUS_AUTOMATIC_DATABASE_CONTAINER is not set'
    : false;
// Read-only catalog reads of the constraints behind the derived counts.
const enrollmentKeySql =
  "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'course_enrollments_course_academic_year_unique'";
const enrollmentCheckSql =
  "SELECT pg_get_constraintdef(oid), convalidated FROM pg_constraint WHERE conrelid = 'course_enrollments'::regclass AND conname = 'course_enrollments_count_nonnegative'";

const relationState = (body) => ({
  on_delete: body.data.schema?.on_delete ?? null,
  one_deselect_action: body.data.meta?.one_deselect_action ?? null,
  one_field: body.data.meta?.one_field ?? null,
  sort_field: body.data.meta?.sort_field ?? null,
});

const installsSchemaOnly = async (target, directus, state) => {
  const before = await schemaCounts(target);
  const summary = await installDataModel(directus);
  assert.equal(summary.collections.created, dataModelCollectionKeys.length);
  assert.equal(summary.relations.created, modelRelations.length);
  assert.deepEqual(
    [
      summary.collections.refused,
      summary.fields.refused,
      summary.relations.refused,
    ],
    [0, 0, 0],
  );
  const collections = await userCollections(target);
  for (const collection of dataModelCollectionKeys) {
    assert.ok(collections.includes(collection), `${collection} missing`);
    const items = await read(
      await request(target, `/items/${collection}?limit=1`, {
        token: target.token,
      }),
      200,
    );
    if (collection === 'data_operations') {
      assert.equal(items.data.id, null, 'the singleton must have no row');
    } else {
      assert.deepEqual(items.data, [], `${collection} must stay empty`);
    }
  }
  const after = await schemaCounts(target);
  assert.equal(after.presets, before.presets, 'setup must not write presets');
  assert.equal(
    after.collections,
    before.collections + dataModelCollectionKeys.length,
  );
  state.installed = after;
};

const reinstallsWithoutMutation = async (target, directus, state) => {
  const recorder = recording(directus);
  const summary = await installDataModel(recorder.request);
  assert.deepEqual(recorder.mutations(), []);
  assert.equal(recorder.calls.length, 1 + dataModelCollectionKeys.length * 2);
  assert.deepEqual(summary.collections, {
    created: 0,
    refused: 0,
    skipped: dataModelCollectionKeys.length,
  });
  assert.deepEqual(summary.relations, {
    adopted: 0,
    created: 0,
    refused: 0,
    skipped: modelRelations.length,
  });
  assert.deepEqual(
    [
      summary.fields.adopted,
      summary.fields.aligned,
      summary.fields.created,
      summary.fields.refused,
    ],
    [0, 0, 0, 0],
  );
  assert.deepEqual(await schemaCounts(target), state.installed);
};

// Directus recreates the foreign key on every relation update, so a
// re-attached alias must come back with its CASCADE rule intact.
const realignsDetachedRelation = async (target, directus, state) => {
  const detached = await read(
    await request(
      target,
      courseLinkPath,
      json(
        'PATCH',
        {
          collection: 'course_curricula',
          field: 'course',
          meta: { one_field: null },
          related_collection: 'courses',
          schema: { on_delete: 'NO ACTION' },
        },
        target.token,
      ),
    ),
    200,
  );
  assert.deepEqual(relationState(detached), {
    on_delete: 'NO ACTION',
    one_deselect_action: 'delete',
    one_field: null,
    sort_field: null,
  });
  const recorder = recording(directus);
  const summary = await installDataModel(recorder.request);
  assert.deepEqual(recorder.mutations(), [
    { method: 'PATCH', pathname: courseLinkPath },
  ]);
  assert.deepEqual(summary.relations, {
    adopted: 1,
    created: 0,
    refused: 0,
    skipped: modelRelations.length - 1,
  });
  const realigned = await read(
    await request(target, courseLinkPath, { token: target.token }),
    200,
  );
  assert.deepEqual(relationState(realigned), {
    on_delete: 'CASCADE',
    one_deselect_action: 'delete',
    one_field: 'curricula',
    sort_field: null,
  });
  const again = recording(directus);
  await installDataModel(again.request);
  assert.deepEqual(again.mutations(), []);
  assert.deepEqual(await schemaCounts(target), state.installed);
};

const appliesConstraintsTwice = async (target, directus, state) => {
  const first = await applySchemaConstraints(directus);
  const second = await applySchemaConstraints(directus);
  assert.deepEqual(first, {
    applied: 'schema-constraints',
    statements: expectedStatements,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(await schemaCounts(target), state.installed);
};

const keepsDuplicateStudentIndexes = async (target) => {
  const first = await createItem(target, 'students', {
    index_number: '000001',
    name: 'Synthetic Student One',
    source_group: 'synthetic-year',
  });
  const second = await createItem(target, 'students', {
    index_number: '000001',
    name: 'Synthetic Student One Again',
    source_group: 'synthetic-other',
  });
  assert.notEqual(first.data.id, second.data.id);
  assert.equal(first.data.index_number, second.data.index_number);
};

// The names of the courses a Discord channel lists.
const channelCourses = async (target, channel) => {
  const body = await read(
    await request(
      target,
      `/items/discord_channels/${channel}?fields=courses.name`,
      { token: target.token },
    ),
    200,
  );
  return body.data.courses.map(({ name }) => name).toSorted();
};

const courseChannel = async (target, course) => {
  const body = await read(
    await request(target, `/items/courses/${course}?fields=discord_channel`, {
      token: target.token,
    }),
    200,
  );
  return body.data.discord_channel;
};

// The live rule of a relation, as relationState reads it.
const liveRelation = async (target, path) =>
  relationState(
    await read(await request(target, path, { token: target.token }), 200),
  );

// A course picks its Discord channel, and the channel lists its courses
// and picks existing ones. Taking a course out of that list, or deleting
// the channel, clears the link (nullify, SET NULL) and keeps the course. A
// semester below 1 is refused.
const linksDiscordChannels = async (target) => {
  assert.deepEqual(
    await liveRelation(target, '/relations/courses/discord_channel'),
    {
      on_delete: 'SET NULL',
      one_deselect_action: 'nullify',
      one_field: 'courses',
      sort_field: null,
    },
  );
  assert.equal(
    await rejectedItem(target, 'discord_channels', {
      channel: 'synthetic-zero',
      semester: 0,
    }),
    'FAILED_VALIDATION',
  );
  const channel = await createItem(target, 'discord_channels', {
    channel: 'synthetic-channel',
    semester: 1,
  });
  const other = await createItem(target, 'discord_channels', {
    channel: 'synthetic-other',
    semester: 2,
  });
  const course = (name) =>
    createItem(target, 'courses', {
      discord_channel: channel.data.id,
      name,
      pattern_mappings: [],
    });
  const first = await course('Synthetic Channel Course One');
  const second = await course('Synthetic Channel Course Two');
  assert.deepEqual(await channelCourses(target, channel.data.id), [
    'Synthetic Channel Course One',
    'Synthetic Channel Course Two',
  ]);
  const pick = async (id, courses) =>
    read(
      await request(
        target,
        `/items/discord_channels/${id}`,
        json('PATCH', { courses }, target.token),
      ),
      200,
    );
  await pick(channel.data.id, [first.data.id]);
  assert.equal(await courseChannel(target, second.data.id), null);
  await pick(other.data.id, [second.data.id]);
  assert.equal(await courseChannel(target, second.data.id), other.data.id);
  assert.deepEqual(await channelCourses(target, other.data.id), [
    'Synthetic Channel Course Two',
  ]);
  await read(
    await request(target, `/items/discord_channels/${channel.data.id}`, {
      method: 'DELETE',
      token: target.token,
    }),
    204,
  );
  assert.equal(await courseChannel(target, first.data.id), null);
  assert.deepEqual(await channelCourses(target, other.data.id), [
    'Synthetic Channel Course Two',
  ]);
};

// The terms a staff member holds, as the staff form lists them.
const deanTerms = async (target, staff) => {
  const body = await read(
    await request(
      target,
      `/items/staff/${staff}?fields=dean_terms.year,dean_terms.position`,
      { token: target.token },
    ),
    200,
  );
  return body.data.dean_terms
    .map(({ position, year }) => `${year} ${position}`)
    .toSorted();
};

const deanTerm = (staff, year, position) => ({ position, staff, year });

// A staff member who can hold a dean's office term; answers its id.
const createDeanStaff = async (target, name) => {
  const staff = await createItem(target, 'staff', {
    active: true,
    email: `${name.toLowerCase().replaceAll(' ', '.')}@staff.example`,
    name,
    position: 'Synthetic Position',
    title: 'Prof.',
  });
  return staff.data.id;
};

// Takes every term out of the staff form's list, which deletes the
// terms, then deletes the staff member.
const removeDeanStaff = async (target, staff) => {
  await read(
    await request(
      target,
      `/items/staff/${staff}`,
      json('PATCH', { dean_terms: [] }, target.token),
    ),
    200,
  );
  assert.deepEqual(await deanTerms(target, staff), []);
  await read(
    await request(target, `/items/staff/${staff}`, {
      method: 'DELETE',
      token: target.token,
    }),
    204,
  );
};

// A dean's office term needs one of the four positions and has one holder
// per year and position. A staff member who holds a term cannot be
// deleted (NO ACTION; Directus 12.3.1 answers the database error as a
// 500); taking the terms out of the staff form's list deletes them, and
// the staff member can then be deleted.
const keepsDeanTerms = async (target) => {
  assert.deepEqual(
    await liveRelation(target, '/relations/deans_office/staff'),
    {
      on_delete: 'NO ACTION',
      one_deselect_action: 'delete',
      one_field: 'dean_terms',
      sort_field: null,
    },
  );
  const holder = await createDeanStaff(target, 'Synthetic Dean Staff');
  const term = (year, position) => ({ position, staff: holder, year });
  assert.equal(
    await rejectedItem(target, 'deans_office', term(2_091, 'Dean')),
    'FAILED_VALIDATION',
  );
  await createItem(target, 'deans_office', term(2_091, 'Декан'));
  await createItem(target, 'deans_office', term(2_092, 'Продекан за настава'));
  assert.equal(
    await rejectedItem(target, 'deans_office', term(2_091, 'Декан')),
    'RECORD_NOT_UNIQUE',
  );
  assert.deepEqual(await deanTerms(target, holder), [
    '2091 Декан',
    '2092 Продекан за настава',
  ]);
  const refused = await request(target, `/items/staff/${holder}`, {
    method: 'DELETE',
    token: target.token,
  });
  assert.equal(refused.status, 500);
  assert.match(await refused.text(), stillHoldsTerms);
  assert.deepEqual(await deanTerms(target, holder), [
    '2091 Декан',
    '2092 Продекан за настава',
  ]);
  await removeDeanStaff(target, holder);
};

// The key is the year and position, whoever holds the term: another staff
// member cannot take a held year and position, while the same year in
// another position and the same position in another year are free. A term
// without its staff member is refused.
const keepsOneHolderPerTerm = async (target) => {
  const holder = await createDeanStaff(target, 'Synthetic Dean Holder');
  const other = await createDeanStaff(target, 'Synthetic Dean Other');
  assert.equal(
    await rejectedItem(target, 'deans_office', {
      position: 'Декан',
      year: 2_093,
    }),
    'FAILED_VALIDATION',
  );
  await createItem(target, 'deans_office', deanTerm(holder, 2_093, 'Декан'));
  assert.equal(
    await rejectedItem(target, 'deans_office', deanTerm(other, 2_093, 'Декан')),
    'RECORD_NOT_UNIQUE',
  );
  await createItem(
    target,
    'deans_office',
    deanTerm(other, 2_093, 'Продекан за финансии'),
  );
  await createItem(target, 'deans_office', deanTerm(other, 2_094, 'Декан'));
  assert.deepEqual(await deanTerms(target, holder), ['2093 Декан']);
  assert.deepEqual(await deanTerms(target, other), [
    '2093 Продекан за финансии',
    '2094 Декан',
  ]);
  for (const staff of [holder, other]) {
    await removeDeanStaff(target, staff);
  }
  const terms = await read(
    await request(target, '/items/deans_office?fields=id', {
      token: target.token,
    }),
    200,
  );
  assert.deepEqual(terms.data, []);
};

// The generation rows a curriculum test needs: 2013 label-only, 2018 and
// 2023 with a curriculum.
const createGenerations = async (target) => {
  const ids = {};
  for (const code of ['2013', '2018', '2023']) {
    const row = await createItem(target, 'curriculum_generations', {
      code,
      has_curriculum: code !== '2013',
      label: `Curriculum ${code}`,
    });
    ids[code] = row.data.id;
  }
  return ids;
};

const guardsCurriculumLinks = async (target, state) => {
  const generations = await createGenerations(target);
  const course = await createItem(target, 'courses', {
    name: 'Synthetic Course',
    pattern_mappings: [],
  });
  const entry2018 = await createItem(target, 'curriculum_entries', {
    generation: generations['2018'],
    name: 'Synthetic Entry 2018',
  });
  const entry2023 = await createItem(target, 'curriculum_entries', {
    generation: generations['2023'],
    name: 'Synthetic Entry 2023',
  });
  const link = { course: course.data.id, generation: generations['2018'] };
  assert.equal(
    await rejectedItem(target, 'course_curricula', {
      ...link,
      entry: entry2023.data.id,
    }),
    'INVALID_FOREIGN_KEY',
  );
  const linked = await createItem(target, 'course_curricula', {
    ...link,
    entry: entry2018.data.id,
  });
  assert.equal(linked.data.generation, generations['2018']);
  assert.equal(
    await rejectedItem(target, 'course_curricula', {
      ...link,
      entry: entry2018.data.id,
    }),
    'RECORD_NOT_UNIQUE',
  );
  // The label-only generation takes no entry, hence no link either.
  assert.equal(
    await rejectedItem(target, 'curriculum_entries', {
      generation: generations['2013'],
      name: 'Synthetic Entry 2013',
    }),
    'INVALID_FOREIGN_KEY',
  );
  const regenerated = await read(
    await request(
      target,
      `/items/curriculum_entries/${entry2018.data.id}`,
      json('PATCH', { generation: generations['2023'] }, target.token),
    ),
    400,
  );
  assert.equal(errorCode(regenerated), 'INVALID_FOREIGN_KEY');
  const withCourse = await read(
    await request(
      target,
      `/items/courses/${course.data.id}?fields=id,curricula.entry.name,curricula.generation.code`,
      { token: target.token },
    ),
    200,
  );
  assert.deepEqual(withCourse.data.curricula, [
    { entry: { name: 'Synthetic Entry 2018' }, generation: { code: '2018' } },
  ]);
  state.course = course.data.id;
};

// Enrollment counts are derived rows: the collection-role registry guards
// them, so a REST write is refused before the unique key or the count
// check could answer, and the table stays empty.
const guardsEnrollmentCounts = async (target, state) => {
  const year = await createItem(target, 'academic_years', {
    label: '2025/2026',
  });
  assert.equal(
    await rejectedItem(target, 'academic_years', {
      label: '2025/2026',
    }),
    'RECORD_NOT_UNIQUE',
  );
  const count = {
    academic_year: year.data.id,
    computed_at: '2026-09-22T00:00:00Z',
    computed_revision: 1,
    count: 3,
    course: state.course,
  };
  for (const item of [count, { ...count, count: -1 }]) {
    const refused = await read(
      await request(
        target,
        '/items/course_enrollments',
        json('POST', item, target.token),
      ),
      403,
    );
    assert.equal(errorCode(refused), 'COORDINATION_WRITE_GUARDED');
  }
  const rows = await read(
    await request(target, '/items/course_enrollments?fields=count', {
      token: target.token,
    }),
    200,
  );
  assert.deepEqual(rows.data, []);
};

// The guard answers every REST write before the unique course-year key or
// the count check could, so their presence is read instead: the field's
// validation over REST, the index and the check from the catalog. The
// completion's install writes through both.
const keepsEnrollmentValidation = async (target) => {
  const field = await read(
    await request(target, '/fields/course_enrollments/count', {
      token: target.token,
    }),
    200,
  );
  assert.deepEqual(field.data.meta.validation, { count: { _gte: 0 } });
};

const keepsEnrollmentConstraints = async () => {
  assert.deepEqual(await psql(enrollmentKeySql), [
    [
      'CREATE UNIQUE INDEX course_enrollments_course_academic_year_unique ON public.course_enrollments USING btree (course, academic_year)',
    ],
  ]);
  assert.deepEqual(await psql(enrollmentCheckSql), [
    ['CHECK ((count >= 0))', 't'],
  ]);
};

const keepsExactHistoryLabels = async (target) => {
  const long = await createItem(target, 'moodle_course_entries', {
    label: longLabel,
  });
  assert.equal(long.data.label, longLabel);
  // Created over the API, not by the history index: no First seen.
  assert.equal(long.data.first_seen, null);
  assert.equal(
    await rejectedItem(target, 'moodle_course_entries', { label: longLabel }),
    'RECORD_NOT_UNIQUE',
  );
  for (const variant of [longLabel.toUpperCase(), `${longLabel} `]) {
    const distinct = await createItem(target, 'moodle_course_entries', {
      label: variant,
    });
    assert.equal(distinct.data.label, variant);
  }
  const rows = await read(
    await request(target, '/items/moodle_course_entries?fields=label', {
      token: target.token,
    }),
    200,
  );
  assert.equal(rows.data.length, 3);
};

const guardsTheEndpoint = async (target) => {
  const anonymous = await request(
    target,
    `${migrationsPath}/schema-constraints`,
    { method: 'POST' },
  );
  assert.equal(anonymous.status, 401);
  assert.equal(errorCode(await anonymous.json()), 'UNAUTHENTICATED');
  await withRestrictedUser(target, async (token) => {
    const restricted = await request(
      target,
      `${migrationsPath}/schema-constraints`,
      { method: 'POST', token },
    );
    assert.equal(restricted.status, 403);
    assert.equal(errorCode(await restricted.json()), 'FORBIDDEN');
  });
  const unknown = await request(target, `${migrationsPath}/not-a-migration`, {
    method: 'POST',
    token: target.token,
  });
  assert.equal(unknown.status, 400);
  assert.equal(errorCode(await unknown.json()), 'INVALID_PAYLOAD');
  const traversal = await request(
    target,
    `${migrationsPath}/${encodeURIComponent('../schema-constraints')}`,
    { method: 'POST', token: target.token },
  );
  assert.equal(traversal.status, 400);
};

test('requires an explicit loopback target and a synthetic marker', () => {
  assert.throws(() => targetFrom({}), missingUrlPattern);
  assert.throws(
    () =>
      targetFrom({
        DIRECTUS_SEARCH_TEST_MARKER_COLLECTION: 'synthetic_search_marker_test',
        DIRECTUS_SEARCH_TEST_MARKER_VALUE: 'synthetic-test',
        DIRECTUS_SEARCH_TEST_TOKEN: 'token',
        DIRECTUS_SEARCH_TEST_URL: 'http://localhost:18055',
      }),
    loopbackPattern,
  );
});

test('orders teardown so referencing collections go first', () => {
  const order = teardownOrder();
  assert.deepEqual(order.toSorted(), dataModelCollectionKeys.toSorted());
  for (const relation of modelRelations) {
    assert.ok(
      order.indexOf(relation.collection) < order.indexOf(relation.related),
      `${relation.collection} must be torn down before ${relation.related}`,
    );
  }
});

test('installs the relational model idempotently and enforces its domain keys', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = {};

  await withDataModel(target, async () => {
    await t.test('creates every collection schema-only on the first run', () =>
      installsSchemaOnly(target, directus, state),
    );
    await t.test('issues no mutating call on the second run', () =>
      reinstallsWithoutMutation(target, directus, state),
    );
    await t.test(
      'realigns a relation that lost its alias and delete rule',
      () => realignsDetachedRelation(target, directus, state),
    );
    await t.test(
      'applies the bundled constraints twice through the endpoint',
      () => appliesConstraintsTwice(target, directus, state),
    );
    await t.test(
      'keeps two students with the same index in different groups',
      () => keepsDuplicateStudentIndexes(target),
    );
    await t.test(
      'links courses to a Discord channel from either side and clears the link',
      () => linksDiscordChannels(target),
    );
    await t.test(
      "keeps one holder per dean's office term and refuses deleting a holder",
      () => keepsDeanTerms(target),
    );
    await t.test(
      "keys a dean's office term by year and position, whoever holds it",
      () => keepsOneHolderPerTerm(target),
    );
    await t.test(
      'rejects mismatched generations and duplicate curriculum links',
      () => guardsCurriculumLinks(target, state),
    );
    await t.test('refuses direct writes to the derived enrollment counts', () =>
      guardsEnrollmentCounts(target, state),
    );
    await t.test('validates the derived counts as non-negative', () =>
      keepsEnrollmentValidation(target),
    );
    await t.test(
      'keeps the course-year key and the count check of the derived counts',
      { skip: needsDatabase },
      () => keepsEnrollmentConstraints(),
    );
    await t.test('keeps history entry labels exact, unbounded and unique', () =>
      keepsExactHistoryLabels(target),
    );
    await t.test('rejects refused callers and unknown migrations', () =>
      guardsTheEndpoint(target),
    );
  });

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
  await assertNoAccessResidue(target);
});
