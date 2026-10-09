import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dataModelCollectionKeys,
  dataModelCollections,
} from '../../src/data-model/collections.js';
import { applySchemaConstraints } from '../../src/data-model/constraints.js';
import {
  installDataModel,
  toCollectionPayload,
} from '../../src/data-model/install.js';
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
import {
  collectionTranslations,
  fieldTranslations,
} from '../../src/data-model/translations.js';
import { incompleteDataPresets } from '../../src/import/incomplete-data-bookmarks.js';
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
const collectionsPath = '/collections';

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
  collections: await get(target, collectionsPath),
  fields: await get(target, '/fields'),
  presets: await get(target, '/presets?limit=-1'),
});

const presetIds = async (target) => {
  const presets = await get(target, '/presets?limit=-1&fields=id');
  return presets.map(({ id }) => id);
};

// The sidebar folders: user collections without a table.
const folderKeys = async (target) => {
  const collections = await get(target, collectionsPath);
  return collections
    .filter(
      ({ collection, schema }) =>
        schema === null && !collection.startsWith(systemPrefix),
    )
    .map(({ collection }) => collection)
    .toSorted();
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
  // The English labels: the form section, a field and the collection.
  assert.deepEqual(overview.meta.translations, [
    { language: 'en-US', translation: 'Basics' },
  ]);
  const name = await get(target, '/fields/courses/name');
  assert.equal(name.meta.group, 'overview');
  assert.deepEqual(name.meta.translations, [
    { language: 'en-US', translation: 'Name' },
  ]);
  const status = await get(target, '/fields/courses/status');
  assert.equal(status.meta.group, 'staff');
  assert.equal(status.meta.required, true);
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
  assert.deepEqual(assignments.meta.options.fields, ['role', 'staff']);
  assert.equal(assignments.meta.options.sort, 'sort');
  // The linked student names a council member; the index an unlinked one.
  const councilCollection = await get(target, '/collections/student_council');
  assert.equal(
    councilCollection.meta.display_template,
    '{{year}} - {{student.name}}',
  );
  assert.equal(councilCollection.meta.group, 'folder_students');
  // Every folder: no table, closed, no note, its English label.
  for (const declared of folders) {
    const folder = await get(target, `/collections/${declared.collection}`);
    assert.equal(folder.schema, null, declared.collection);
    assert.equal(folder.meta.collapse, 'closed', declared.collection);
    assert.equal(folder.meta.note, null, declared.collection);
    assert.equal(folder.meta.sort, declared.sort, declared.collection);
    assert.equal(
      folder.meta.translations.find(({ language }) => language === 'en-US')
        ?.translation,
      declared.label,
      declared.collection,
    );
  }
  // Moodle users sits in no folder, between Enrollments and Internals.
  const moodleUsers = await get(target, '/collections/moodle_users');
  assert.equal(moodleUsers.meta.group, null);
  assert.equal(moodleUsers.meta.sort, 6);
  const courses = await get(target, '/collections/courses');
  assert.equal(courses.meta.group, 'folder_courses');
  assert.deepEqual(courses.meta.translations, [
    {
      language: 'en-US',
      plural: 'Courses',
      singular: 'Course',
      translation: 'Courses',
    },
  ]);
  const hidden = await get(target, '/collections/course_curricula');
  assert.equal(hidden.meta.hidden, true);
  assert.equal(hidden.meta.group, 'folder_internals');
  const bookmarks = await get(
    target,
    '/presets?limit=-1&fields=bookmark,collection,filter,user,role&filter[bookmark][_nnull]=true&sort=bookmark',
  );
  // Search and Unmapped history lines only: setup creates no
  // incomplete-data bookmark.
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
    bookmarks.every(({ bookmark }) =>
      incompleteDataPresets().every((preset) => preset.bookmark !== bookmark),
    ),
    'setup installs no incomplete-data bookmark',
  );
  assert.ok(
    bookmarks.every(
      ({ bookmark }) =>
        !['Mapped entries awaiting review', 'Needs mapping'].includes(bookmark),
    ),
    'no history line review bookmark is installed',
  );
};

const isGroup = ({ meta }) => meta?.special?.includes('group') === true;

// The English labels as declared (plan 1.1 to 1.3, pinned against the
// declarations by data-model-labels.test.ts): every form group with its
// note and its members in order, and no other group; every model
// collection with its display template and note; every field and alias.
const labelsAsDeclared = async (target) => {
  const fields = await get(target, '/fields');
  const modelFields = fields.filter(({ collection }) =>
    dataModelCollectionKeys.includes(collection),
  );
  const fieldOf = (collection, field) =>
    modelFields.find(
      (live) => live.collection === collection && live.field === field,
    );
  for (const group of fieldGroups) {
    const key = `${group.collection}.${group.field}`;
    const live = fieldOf(group.collection, group.field);
    assert.ok(live !== undefined && isGroup(live), `${key} missing`);
    assert.deepEqual(
      live.meta.translations,
      fieldTranslations(group.label),
      key,
    );
    assert.equal(live.meta.note, group.note ?? null, key);
    const members = modelFields
      .filter(
        ({ collection, meta }) =>
          collection === group.collection && meta?.group === group.field,
      )
      .toSorted((left, right) => left.meta.sort - right.meta.sort)
      .map(({ field }) => field);
    assert.deepEqual(members, group.members, key);
  }
  assert.deepEqual(
    modelFields
      .filter(isGroup)
      .map(({ collection, field }) => `${collection}.${field}`)
      .toSorted(),
    fieldGroups
      .map(({ collection, field }) => `${collection}.${field}`)
      .toSorted(),
  );
  const collections = await get(target, collectionsPath);
  for (const declared of dataModelCollections) {
    const { collection } = declared;
    const live = collections.find((row) => row.collection === collection);
    assert.notEqual(declared.label, undefined, `${collection} label`);
    assert.deepEqual(
      live?.meta.translations,
      collectionTranslations(declared.label),
      collection,
    );
    assert.equal(
      live.meta.display_template,
      declared.displayTemplate,
      collection,
    );
    assert.equal(live.meta.note, declared.note ?? null, collection);
    for (const { field, meta } of toCollectionPayload(declared).fields) {
      assert.deepEqual(
        fieldOf(collection, field)?.meta.translations,
        meta.translations ?? null,
        `${collection}.${field}`,
      );
    }
  }
};

// Every model collection sits in the folder the sidebar declares, at its
// position there; Moodle users alone at the root. No other folder is added.
const placesAsDeclared = async (target, state) => {
  const collections = await get(target, collectionsPath);
  for (const collection of dataModelCollectionKeys) {
    const expected =
      collection === 'moodle_users'
        ? { group: null, sort: 6 }
        : collectionPlacements.find(
            (declared) => declared.collection === collection,
          )?.meta;
    assert.notEqual(expected, undefined, `${collection} has no placement`);
    const live = collections.find((row) => row.collection === collection);
    assert.deepEqual(
      { group: live?.meta.group, sort: live?.meta.sort },
      expected,
      collection,
    );
  }
  assert.deepEqual(
    await folderKeys(target),
    [
      ...state.foldersBefore,
      ...folders.map(({ collection }) => collection),
    ].toSorted(),
  );
};

// The API-side half of the browser QA: the trigger rejects a link whose
// generation differs from its entry, and a matching link plus a professor
// assignment read back through the course.
const editsCourseThroughRelations = async (target, state) => {
  const generations = {};
  for (const code of ['2018', '2023']) {
    const row = await createItem(target, 'curriculum_generations', {
      code,
      has_curriculum: true,
      label: `Curriculum ${code}`,
    });
    generations[code] = row.data.id;
  }
  const course = await createItem(target, 'courses', {
    name: 'Synthetic Presentation Course',
    pattern_mappings: [],
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
  const collections = await get(target, collectionsPath);
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
  const state = {
    foldersBefore: await folderKeys(target),
    presetsBefore: await presetIds(target),
  };

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
        'labels every form group, collection, field and alias in English as declared',
        () => labelsAsDeclared(target),
      );
      await t.test(
        'places every collection in its declared folder and adds no other folder',
        () => placesAsDeclared(target, state),
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
