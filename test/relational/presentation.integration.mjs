import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dataModelCollectionKeys } from '../../src/data-model/collections.js';
import { applySchemaConstraints } from '../../src/data-model/constraints.js';
import { installDataModel } from '../../src/data-model/install.js';
import { installPresentation } from '../../src/data-model/presentation.js';
import {
  generationFilter,
  lockedWithoutGeneration,
} from '../../src/data-model/presentation/curriculum-fields.js';
import { presentationFieldPatches } from '../../src/data-model/presentation/fields.js';
import { fieldGroups } from '../../src/data-model/presentation/groups.js';
import {
  collectionPlacements,
  folders,
} from '../../src/data-model/presentation/navigation.js';
import { presetDefinitions } from '../../src/data-model/presentation/presets.js';
import { assertMarkerPresent, targetFrom } from '../isolated-target.mjs';
import {
  adminRequest,
  createItem,
  read,
  recording,
  rejectedItem,
  request,
  userCollections,
  withDataModel,
} from './data-model-helpers.mjs';

const systemPrefix = 'directus_';

const get = async (target, path) => {
  const body = await read(
    await request(target, path, { token: target.token }),
    200,
  );
  return body.data;
};

const remove = async (target, path) =>
  read(
    await request(target, path, { method: 'DELETE', token: target.token }),
    204,
  );

// The three listings the presentation writes to, byte-comparable between runs.
const snapshot = async (target) => ({
  collections: await get(target, '/collections'),
  fields: await get(target, '/fields'),
  presets: await get(target, '/presets?limit=-1'),
});

const presetIds = async (target) => {
  const presets = await get(target, '/presets?limit=-1&fields=id');
  return presets.map(({ id }) => id);
};

const expectedFirstRun = {
  collections: {
    adopted: collectionPlacements.length,
    created: folders.length,
    skipped: 0,
  },
  fields: { adopted: presentationFieldPatches.length, created: 0, skipped: 0 },
  groups: { adopted: 0, created: fieldGroups.length, skipped: 0 },
  presets: { adopted: 0, created: presetDefinitions.length, skipped: 0 },
};

const expectedSecondRun = {
  collections: {
    adopted: 0,
    created: 0,
    skipped: collectionPlacements.length + folders.length,
  },
  fields: { adopted: 0, created: 0, skipped: presentationFieldPatches.length },
  groups: { adopted: 0, created: 0, skipped: fieldGroups.length },
  presets: { adopted: 0, created: 0, skipped: presetDefinitions.length },
};

const appliesOnce = async (target, directus, state) => {
  const first = recording(directus);
  const summary = await installPresentation(first.request);
  assert.deepEqual(summary, expectedFirstRun);
  assert.equal(
    first.mutations().length,
    folders.length +
      collectionPlacements.length +
      fieldGroups.length +
      presentationFieldPatches.length +
      presetDefinitions.length,
  );
  state.applied = await snapshot(target);
  const second = recording(directus);
  const again = await installPresentation(second.request);
  assert.deepEqual(second.mutations(), []);
  assert.deepEqual(again, expectedSecondRun);
  assert.deepEqual(await snapshot(target), state.applied);
};

// Bookmarks ordered by name, whatever the database collation.
const byName = (left, right) => left.bookmark.localeCompare(right.bookmark);

const installsStudioMetadata = async (target) => {
  const overview = await get(target, '/fields/courses/overview');
  assert.equal(overview.type, 'alias');
  assert.deepEqual(overview.meta.special, ['alias', 'no-data', 'group']);
  assert.equal(overview.meta.interface, 'group-detail');
  const name = await get(target, '/fields/courses/name');
  assert.equal(name.meta.group, 'overview');
  const override = await get(target, '/fields/courses/professors_override');
  assert.equal(override.meta.group, 'staff');
  assert.equal(override.meta.readonly, false);
  const entry = await get(target, '/fields/course_curricula/entry');
  assert.deepEqual(entry.meta.options.filter, generationFilter);
  assert.equal(entry.meta.readonly, false);
  assert.deepEqual(entry.meta.conditions, [lockedWithoutGeneration]);
  // The states of an entry: a many-to-many to the programs of its
  // generation, locked until one is chosen; the member entry picker alike.
  const states = await get(target, '/fields/curriculum_entries/program_states');
  assert.equal(states.meta.interface, 'list-m2m');
  assert.deepEqual(states.meta.special, ['m2m']);
  assert.deepEqual(states.meta.options.filter, generationFilter);
  assert.equal(states.meta.options.enableCreate, false);
  assert.deepEqual(states.meta.conditions, [lockedWithoutGeneration]);
  const member = await get(target, '/fields/course_equivalency_members/entry');
  assert.deepEqual(member.meta.options.filter, generationFilter);
  assert.deepEqual(member.meta.conditions, [lockedWithoutGeneration]);
  const junction = await get(
    target,
    '/relations/curriculum_entry_program_states/entry',
  );
  assert.equal(junction.meta.junction_field, 'program');
  assert.equal(junction.meta.one_field, 'program_states');
  const assignments = await get(target, '/fields/courses/assignments');
  assert.deepEqual(assignments.meta.options.fields, [
    'role',
    'staff',
    'display_override',
  ]);
  assert.equal(assignments.meta.options.sort, 'sort');
  // The linked student names a council member; the index an unlinked one.
  const councilCollection = await get(target, '/collections/student_council');
  assert.equal(
    councilCollection.meta.display_template,
    '{{year}} - {{student.name}}',
  );
  assert.equal(councilCollection.meta.group, 'student_records');
  const folder = await get(target, '/collections/courses_and_curriculum');
  assert.equal(folder.schema, null);
  assert.equal(folder.meta.collapse, 'open');
  const courses = await get(target, '/collections/courses');
  assert.equal(courses.meta.group, 'courses_and_curriculum');
  const hidden = await get(target, '/collections/course_curricula');
  assert.equal(hidden.meta.hidden, true);
  assert.equal(hidden.meta.group, 'courses_and_curriculum');
  const bookmarks = await get(
    target,
    '/presets?limit=-1&fields=bookmark,collection,filter,user,role&filter[bookmark][_nnull]=true&sort=bookmark',
  );
  // The curriculum bookmark and one Needs review bookmark per registry
  // entry that declares a view, each on its page collection.
  assert.deepEqual(
    bookmarks.toSorted(byName),
    presetDefinitions
      .filter(({ bookmark }) => bookmark !== null)
      .map(({ bookmark, collection, filter }) => ({
        bookmark,
        collection,
        filter,
        role: null,
        user: null,
      }))
      .toSorted(byName),
  );
  assert.ok(
    bookmarks.some(({ bookmark }) => bookmark === 'Needs mapping'),
    'the Needs mapping bookmark is installed',
  );
};

// The API-side half of the browser QA: the trigger rejects a link whose
// generation differs from its entry, and a matching link plus a professor
// assignment read back through the course.
const editsCourseThroughRelations = async (target, state) => {
  const generations = {};
  for (const [code, sort] of [
    ['2018', 1],
    ['2023', 2],
  ]) {
    const row = await createItem(target, 'curriculum_generations', {
      code,
      has_curriculum: true,
      label: `Curriculum ${code}`,
      sort,
    });
    generations[code] = row.data.id;
  }
  const course = await createItem(target, 'courses', {
    name: 'Synthetic Presentation Course',
  });
  const entry2018 = await createItem(target, 'curriculum_entries', {
    code: 'F18L1W001',
    generation: generations['2018'],
    name: 'Synthetic Presentation Entry 2018',
  });
  const entry2023 = await createItem(target, 'curriculum_entries', {
    code: 'F23L1W001',
    generation: generations['2023'],
    name: 'Synthetic Presentation Entry 2023',
  });
  const professor = await createItem(target, 'staff', {
    active: true,
    email: 'presentation.professor@staff.example',
    name: 'Synthetic Presentation Professor',
    position: 'Professor',
    title: 'Prof.',
  });
  state.items = [
    ['staff', professor.data.id],
    ['curriculum_entries', entry2023.data.id],
    ['curriculum_entries', entry2018.data.id],
    ['courses', course.data.id],
    ['curriculum_generations', generations['2023']],
    ['curriculum_generations', generations['2018']],
  ];
  assert.equal(
    await rejectedItem(target, 'course_curricula', {
      course: course.data.id,
      entry: entry2023.data.id,
      generation: generations['2018'],
    }),
    'INVALID_FOREIGN_KEY',
  );
  const link = await createItem(target, 'course_curricula', {
    available: true,
    course: course.data.id,
    credits: 6,
    entry: entry2018.data.id,
    generation: generations['2018'],
    sort: 1,
  });
  // An assignment needs its course, role and staff member only.
  const assignment = await createItem(target, 'teaching_assignments', {
    course: course.data.id,
    role: 'professor',
    sort: 1,
    staff: professor.data.id,
  });
  state.items.unshift(
    ['teaching_assignments', assignment.data.id],
    ['course_curricula', link.data.id],
  );
  const withRelations = await get(
    target,
    `/items/courses/${course.data.id}?fields=curricula.generation.code,curricula.entry.name,curricula.credits,assignments.role,assignments.staff.name`,
  );
  assert.deepEqual(withRelations, {
    assignments: [
      {
        role: 'professor',
        staff: { name: 'Synthetic Presentation Professor' },
      },
    ],
    curricula: [
      {
        credits: 6,
        entry: { name: 'Synthetic Presentation Entry 2018' },
        generation: { code: '2018' },
      },
    ],
  });
};

const removesWhatItCreated = async (target, state) => {
  const items = state.items ?? [];
  for (const [collection, id] of items) {
    await remove(target, `/items/${collection}/${id}`);
  }
  for (const collection of dataModelCollectionKeys) {
    if (collection === 'data_operations') continue;
    const rows = await get(target, `/items/${collection}?fields=id&limit=1`);
    assert.deepEqual(rows, [], `${collection} must be empty again`);
  }
};

const removesPresentation = async (target, state) => {
  const ids = await presetIds(target);
  const created = ids.filter((id) => !state.presetsBefore.includes(id));
  for (const id of created) {
    await remove(target, `/presets/${id}`);
  }
  for (const folder of folders) {
    await remove(target, `/collections/${folder.collection}`);
  }
  assert.deepEqual(await presetIds(target), state.presetsBefore);
  const collections = await get(target, '/collections');
  const remaining = new Set(
    collections
      .map(({ collection }) => collection)
      .filter((collection) => !collection.startsWith(systemPrefix)),
  );
  for (const folder of folders) {
    assert.ok(!remaining.has(folder.collection), folder.collection);
  }
};

test('installs the Studio presentation once and lets the course be edited through its relations', async (t) => {
  const target = targetFrom(process.env);
  const directus = adminRequest(target);
  const state = { presetsBefore: await presetIds(target) };

  await withDataModel(target, async () => {
    try {
      await installDataModel(directus);
      await applySchemaConstraints(directus);
      await t.test(
        'applies everything on the first run and nothing on the second',
        () => appliesOnce(target, directus, state),
      );
      await t.test(
        'installs groups, filters, hidden columns, folders and bookmarks',
        () => installsStudioMetadata(target),
      );
      await t.test(
        'rejects a mismatched generation and reads relations back through the course',
        () => editsCourseThroughRelations(target, state),
      );
    } finally {
      await t.test('removes exactly the items it created', () =>
        removesWhatItCreated(target, state),
      );
      await t.test('removes the presets and folders it created', () =>
        removesPresentation(target, state),
      );
    }
  });

  await assertMarkerPresent(target);
  assert.deepEqual(await userCollections(target), [target.markerCollection]);
});
