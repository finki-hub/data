import { isDeepStrictEqual } from 'node:util';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { readinessRegistry } from '../directus/extensions/directus-extension-data-operations/src/exports/readiness-registry.js';
import { dataModelCollections } from '../src/data-model/collections.js';
import { installPresentation } from '../src/data-model/presentation.js';
import { baselineFieldMeta } from '../src/data-model/presentation/baseline.js';
import {
  curriculumBookmark,
  searchBookmark,
  unmappedLinesBookmark,
} from '../src/data-model/presentation/bookmarks.js';
import {
  generationFilter,
  lockedWithoutGeneration,
} from '../src/data-model/presentation/curriculum-fields.js';
import {
  fieldPresentations,
  findFieldPatch,
  presentationFieldPatches,
} from '../src/data-model/presentation/fields.js';
import {
  fieldGroups,
  findFieldGroup,
} from '../src/data-model/presentation/groups.js';
import {
  collectionPlacements,
  folders,
} from '../src/data-model/presentation/navigation.js';
import {
  presetDefinitions,
  presetDefinitionsFor,
  reviewPresets,
} from '../src/data-model/presentation/presets.js';
import { aliasesFor } from '../src/data-model/relations.js';
import { fieldTranslations } from '../src/data-model/translations.js';
import {
  fakeDirectus,
  type FakeMeta,
  type FakeState,
  findCollection,
  mutations,
  type RecordedRequest,
} from './data-model-test-helpers.js';
import {
  appliedState,
  bookmarkNames,
  effectiveFieldMeta,
  freshState,
  reviewBody,
  reviewedBy,
  withExtraCheck,
} from './presentation-test-helpers.js';

const collator = new Intl.Collator('en');
const collectionsPath = /^\/collections$/u;
const collectionPath = /^\/collections\/[^/]+$/u;
const fieldsPath = /^\/fields\/[^/]+$/u;
const fieldPath = /^\/fields\/[^/]+\/[^/]+$/u;
const presetsPath = /^\/presets$/u;
// A filter that names a generation row by its id.
const generationRowPattern = /"generation":\{"_(?:eq|in)"/u;

const sorted = (values: readonly string[]): readonly string[] =>
  values.toSorted((a, b) => collator.compare(a, b));

const fieldNames = (collection: string): readonly string[] => {
  const model = findCollection(collection);
  return [
    ...model.fields.map(({ field }) => field),
    ...aliasesFor(model.collection).map(({ alias }) => alias.field),
  ];
};

// Simulates a Studio edit of a field's meta inside the fake listings.
const editLiveMeta = (
  state: FakeState,
  target: { readonly collection: string; readonly field: string },
  meta: FakeMeta,
): void => {
  const found = state.fields[target.collection]?.find(
    (candidate) => candidate.field === target.field,
  );
  if (found?.meta === undefined || found.meta === null) {
    throw new Error(
      `${target.collection}.${target.field} is missing from the fixture`,
    );
  }
  found.meta = { ...found.meta, ...meta };
};

// `collection.field` of every enum field of a collection.
const enumNames = ({
  collection,
  fields,
}: (typeof dataModelCollections)[number]): string[] =>
  fields.flatMap(({ field, kind }) =>
    kind === 'enum' ? [`${collection}.${field}`] : [],
  );

// Whether a patch writes the meta keys an enum's declaration owns.
const ownsChoices = (meta: Readonly<Record<string, unknown>>): boolean =>
  ['display_options', 'options', 'validation'].some((key) =>
    Object.hasOwn(meta, key),
  );

const choicesOf = (collection: string, field: string) =>
  z
    .looseObject({
      choices: z.array(z.object({ text: z.string(), value: z.string() })),
    })
    .parse(effectiveFieldMeta(collection, field)['options']).choices;

const listOptions = z.looseObject({
  enableSearchFilter: z.boolean(),
  fields: z.array(z.string()),
  sort: z.string().optional(),
});

const conditions = z.array(
  z.object({
    name: z.string(),
    readonly: z.boolean(),
    rule: z.record(z.string(), z.unknown()),
  }),
);

const groupBody = z.object({
  field: z.string(),
  meta: z.looseObject({
    interface: z.string(),
    options: z.object({ headerIcon: z.string(), start: z.string() }),
    readonly: z.boolean(),
    special: z.array(z.string()),
  }),
  schema: z.null(),
  type: z.literal('alias'),
});

const metaBody = z.object({ meta: z.record(z.string(), z.unknown()) });

const collectionBody = z.object({
  collection: z.string(),
  meta: z.looseObject({
    collapse: z.string(),
    translations: z.array(
      z.object({ language: z.string(), translation: z.string() }),
    ),
  }),
});

const presetBody = z.object({
  bookmark: z.string().nullable(),
  collection: z.string(),
});

const options = z.record(z.string(), z.unknown());

const helperCollections = [
  'course_curricula',
  'curriculum_entry_program_states',
  'data_operation_matches',
  'data_operations',
  'moodle_counted_lines',
  'moodle_history_memberships',
  'moodle_import_rows',
];

const courseGroups = fieldGroups.filter(
  ({ collection }) => collection === 'courses',
);

const groupClashes = fieldGroups.filter((group) =>
  fieldNames(group.collection).includes(group.field),
);

const unknownMembers = fieldGroups.flatMap((group) =>
  group.members.filter(
    (member) => !fieldNames(group.collection).includes(member),
  ),
);

const memberships = fieldGroups.flatMap(({ collection, members }) =>
  members.map((member) => `${collection}.${member}`),
);

const relationLists = dataModelCollections.flatMap(({ collection }) =>
  aliasesFor(collection).map(({ alias, relation }) => ({
    ...listOptions.parse(
      effectiveFieldMeta(collection, alias.field)['options'],
    ),
    declared: alias.fields,
    field: `${collection}.${alias.field}`,
    readOnly: alias.readOnly === true,
    sortField: relation.sortField ?? undefined,
  })),
);

// Every condition any patch declares, with the field it belongs to.
const declaredConditions = presentationFieldPatches.flatMap((patch) =>
  (patch.meta.conditions ?? []).map((condition) => ({
    condition,
    field: `${patch.collection}.${patch.field}`,
  })),
);

// Whether the patch differs from the installer baseline on some key.
const changesBaseline = (patch: (typeof presentationFieldPatches)[number]) => {
  const baseline = baselineFieldMeta(patch.collection, patch.field);
  return Object.entries(patch.meta).some(
    ([key, value]) =>
      JSON.stringify(baseline[key] ?? null) !== JSON.stringify(value),
  );
};

// The installer baseline translations of every field and alias of a
// collection, beside the ones its declared label gives.
const baselineLabels = ({
  collection,
  fields,
}: (typeof dataModelCollections)[number]) =>
  [
    ...fields.map(({ field, label }) => ({ field, label })),
    ...aliasesFor(collection).map(({ alias }) => ({
      field: alias.field,
      label: alias.label,
    })),
  ].map(({ field, label }) => ({
    actual: baselineFieldMeta(collection, field)['translations'],
    expected: label === undefined ? null : fieldTranslations(label),
    field: `${collection}.${field}`,
  }));

const byShape = (
  writes: readonly RecordedRequest[],
  method: string,
  pattern: RegExp,
): readonly RecordedRequest[] =>
  writes.filter(
    (call) => call.method === method && pattern.test(call.pathname),
  );

const isGroupPost = (call: RecordedRequest, field: string): boolean =>
  groupBody.safeParse(call.body).data?.field === field;

const totalWrites =
  folders.length +
  collectionPlacements.length +
  fieldGroups.length +
  presentationFieldPatches.length +
  presetDefinitions.length;

// The name of every shared bookmark a presentation run created, in order.
const bookmarkBody = z.object({ bookmark: z.string().nullable() });
const createdBookmarks = (writes: readonly RecordedRequest[]) =>
  byShape(writes, 'POST', presetsPath).flatMap(({ body }) => {
    const bookmark = bookmarkBody.safeParse(body).data?.bookmark;
    return bookmark === undefined || bookmark === null ? [] : [bookmark];
  });

// The Needs review bookmarks a presentation run created, as their page,
// name, columns and filter.
const installedReviews = (writes: readonly RecordedRequest[]) =>
  byShape(writes, 'POST', presetsPath)
    .map(({ body }) => reviewBody.safeParse(body).data)
    .filter(
      (body): body is z.infer<typeof reviewBody> =>
        body?.bookmark !== undefined &&
        body.bookmark !== null &&
        bookmarkNames.has(body.bookmark),
    )
    .map(({ bookmark, collection, filter, layout_query }) => ({
      bookmark,
      collection,
      fields: layout_query.tabular.fields,
      filter,
    }));

describe('field groups', () => {
  test('groups every course field once, every section open', () => {
    expect(courseGroups.map(({ field }) => field)).toEqual([
      'overview',
      'curriculum',
      'staff',
      'moodle',
      'enrollment',
    ]);
    expect(sorted(courseGroups.flatMap(({ members }) => members))).toEqual(
      sorted(fieldNames('courses')),
    );
    expect(courseGroups.every(({ start }) => start === 'open')).toBeTruthy();
  });

  test('never names a group after a model field and lists only model fields', () => {
    expect(groupClashes).toEqual([]);
    expect(unknownMembers).toEqual([]);
    expect(fieldGroups.filter(({ members }) => members.length === 0)).toEqual(
      [],
    );
    expect(new Set(memberships).size).toBe(memberships.length);
  });
});

describe('curriculum generations in the forms', () => {
  test('keeps the curriculum of a course in its links only', () => {
    expect(fieldNames('courses')).toEqual(
      expect.not.arrayContaining(['name_2023', 'credits_2018']),
    );
    expect(findFieldGroup('courses', 'curriculum')?.members).toEqual([
      'curricula',
      'equivalencies',
    ]);
  });

  test('shows an entry code with the note that its L-digit is the level, and no level field', () => {
    expect(fieldNames('curriculum_entries')).not.toContain('level');
    expect(effectiveFieldMeta('curriculum_entries', 'code')['note']).toBe(
      'The digit after L is the level: F18L3W055 is level 3.',
    );
  });

  test('offers only the programs of the entry generation, locked until one is chosen', () => {
    const states = effectiveFieldMeta('curriculum_entries', 'program_states');

    expect(states).toMatchObject({
      conditions: [lockedWithoutGeneration],
      interface: 'list-m2m',
      special: ['m2m'],
    });
    expect(states['options']).toMatchObject({
      enableCreate: false,
      enableSelect: true,
      filter: generationFilter,
      junctionFieldLocation: 'top',
    });

    for (const field of ['entry', 'program']) {
      expect(
        effectiveFieldMeta('curriculum_entry_program_states', field)['hidden'],
      ).toBeTruthy();
    }
  });

  test('offers only generations with a curriculum to entries and course links', () => {
    for (const collection of ['curriculum_entries', 'course_curricula']) {
      expect(
        effectiveFieldMeta(collection, 'generation')['options'],
      ).toMatchObject({
        filter: { has_curriculum: { _eq: true } },
        template: '{{code}}',
      });
    }
  });

  test('filters the entry of an equivalency member by its generation and lists the members on the course', () => {
    expect(
      effectiveFieldMeta('course_equivalency_members', 'entry'),
    ).toMatchObject({
      conditions: [lockedWithoutGeneration],
      options: { filter: generationFilter },
    });
    expect(
      effectiveFieldMeta('courses', 'equivalencies')['options'],
    ).toMatchObject({
      fields: ['members.generation.code', 'members.label'],
    });
    expect(
      effectiveFieldMeta('course_equivalencies', 'members')['options'],
    ).toMatchObject({
      fields: ['generation', 'label', 'entry.code', 'entry.name'],
    });
  });
});

describe('field presentation', () => {
  test('filters the curriculum entry picker by the link generation', () => {
    const entry = effectiveFieldMeta('course_curricula', 'entry');

    expect(entry['interface']).toBe('select-dropdown-m2o');
    expect(entry['options']).toMatchObject({
      enableSelect: true,
      filter: generationFilter,
      template: '{{code}} - {{name}} ({{generation.code}})',
    });
    expect(generationFilter).toEqual({
      generation: { _eq: '{{ generation }}' },
    });
  });

  test('locks the entry selector until a generation is chosen', () => {
    const entry = effectiveFieldMeta('course_curricula', 'entry');

    expect(entry['readonly']).toBe(false);
    expect(conditions.parse(entry['conditions'])).toEqual([
      {
        name: 'Generation not chosen yet',
        readonly: true,
        rule: { generation: { _null: true } },
      },
    ]);
    expect(entry['conditions']).toEqual([lockedWithoutGeneration]);
    // Studio evaluates only rules with exactly one top-level key.
    expect(
      declaredConditions.filter(
        ({ condition }) => Object.keys(condition.rule).length !== 1,
      ),
    ).toEqual([]);
    expect(declaredConditions.map(({ field }) => field)).toEqual([
      'curriculum_entries.program_states',
      'course_curricula.entry',
      'course_equivalency_members.entry',
      'moodle_pattern_mappings.year_pattern',
      'moodle_pattern_mappings.year_pattern',
    ]);
    // The other conditions show or require a pattern mapping's year
    // pattern (test/pattern-mapping-model.test.ts).
    expect(
      declaredConditions
        .filter(
          ({ condition }) =>
            JSON.stringify(condition) !==
            JSON.stringify(lockedWithoutGeneration),
        )
        .map(({ field }) => field),
    ).toEqual([
      'moodle_pattern_mappings.year_pattern',
      'moodle_pattern_mappings.year_pattern',
    ]);
  });

  test('names a council member by the linked student, beside the index', () => {
    expect(fieldNames('student_council')).not.toContain('name');
    expect(effectiveFieldMeta('student_council', 'student')).toMatchObject({
      display: 'related-values',
      interface: 'select-dropdown-m2o',
    });
    expect(findCollection('student_council').displayTemplate).toBe(
      '{{year}} - {{student.name}}',
    );
  });

  test('leaves the choices and rule of every enum to its declaration', () => {
    const enums = new Set(dataModelCollections.flatMap(enumNames));
    const owned = presentationFieldPatches.filter(
      ({ collection, field, meta }) =>
        enums.has(`${collection}.${field}`) && ownsChoices(meta),
    );

    expect(enums.size).toBeGreaterThanOrEqual(7);
    expect(owned).toEqual([]);
  });

  test('labels the role dropdown', () => {
    expect(choicesOf('teaching_assignments', 'role')).toEqual([
      { text: 'Professor', value: 'professor' },
      { text: 'Assistant', value: 'assistant' },
    ]);
    expect(effectiveFieldMeta('teaching_assignments', 'role')['display']).toBe(
      'labels',
    );
  });

  test('shows the course status first in the staff group, as a required dropdown starting Active', () => {
    expect(findFieldGroup('courses', 'staff')?.members).toEqual([
      'status',
      'assignments',
    ]);
    expect(choicesOf('courses', 'status')).toEqual([
      { text: 'Active', value: 'active' },
      { text: 'All professors', value: 'all_professors' },
      { text: 'Inactive', value: 'inactive' },
    ]);
    expect(effectiveFieldMeta('courses', 'status')).toMatchObject({
      display: 'labels',
      required: true,
    });
  });

  test('makes every relation list searchable and orders the sortable ones', () => {
    expect(relationLists.length).toBeGreaterThan(0);
    expect(
      relationLists.filter(({ enableSearchFilter }) => !enableSearchFilter),
    ).toEqual([]);
    expect(
      relationLists.filter(({ sort, sortField }) => sort !== sortField),
    ).toEqual([]);
  });

  test('drops the raw sort column from editable ordered lists only', () => {
    const assignments = relationLists.find(
      ({ field }) => field === 'courses.assignments',
    );
    const programs = relationLists.find(
      ({ field }) => field === 'curriculum_generations.programs',
    );
    const history = relationLists.find(
      ({ field }) => field === 'moodle_users.history_memberships',
    );

    expect(assignments?.fields).toEqual(['role', 'staff']);
    expect(assignments?.sort).toBe('sort');
    expect(programs?.fields).toEqual(['code', 'name', 'published']);
    expect(programs?.sort).toBe('sort');
    expect(history?.fields).toEqual([
      'entry',
      'entry.counted_for.course',
      'entry.counted_for.academic_year',
      'sort',
    ]);
    expect(
      relationLists.filter(
        ({ fields, readOnly, sortField }) =>
          !readOnly && sortField !== undefined && fields.includes(sortField),
      ),
    ).toEqual([]);
    expect(
      relationLists.filter(
        ({ declared, fields, readOnly, sortField }) =>
          (readOnly || sortField === undefined) &&
          JSON.stringify(fields) !== JSON.stringify(declared),
      ),
    ).toEqual([]);
  });

  test('changes at least one installer-written key per patch, so a rerun finds nothing to do', () => {
    expect(presentationFieldPatches.length).toBeGreaterThan(
      fieldPresentations.length,
    );
    expect(
      presentationFieldPatches.filter((patch) => !changesBaseline(patch)),
    ).toEqual([]);
    expect(
      fieldPresentations.filter(({ meta }) => meta.group !== undefined),
    ).toEqual([]);
    expect(findFieldPatch('courses', 'no_such_field')).toBeUndefined();
  });
});

describe('navigation', () => {
  test('places every model collection in exactly one folder', () => {
    const placed = collectionPlacements.map(({ collection }) => collection);

    expect(sorted(placed)).toEqual(
      sorted(dataModelCollections.map(({ collection }) => collection)),
    );

    const folderNames = folders.map(({ collection }) => collection);

    expect(new Set(folderNames).size).toBe(folderNames.length);
    expect(
      collectionPlacements.filter(
        ({ meta }) =>
          !folderNames.includes(meta.group) || placed.includes(meta.group),
      ),
    ).toEqual([]);
  });

  test('keeps junction, staging and candidate collections out of the sidebar', () => {
    const hidden = dataModelCollections
      .filter((collection) => collection.hidden)
      .map(({ collection }) => collection);

    expect(sorted(hidden)).toEqual(sorted(helperCollections));
  });
});

describe('the Needs review bookmarks', () => {
  test('are exactly the registry entries that carry a review, one each, on the page of the check', async () => {
    const { request, requests } = fakeDirectus(freshState());

    await installPresentation(request);

    const installed = installedReviews(mutations(requests));

    expect(installed).toEqual(reviewedBy(readinessRegistry));
    // No other shared bookmark: a hand-written review preset shows here.
    expect(createdBookmarks(mutations(requests))).toEqual([
      curriculumBookmark.bookmark,
      ...reviewedBy(readinessRegistry).map(({ bookmark }) => bookmark),
      searchBookmark.bookmark,
      unmappedLinesBookmark.bookmark,
    ]);
    expect(installed.length).toBeGreaterThan(2);
    expect(installed.map(({ bookmark }) => bookmark)).toContain(
      'Equivalencies without a course',
    );
    expect(reviewPresets()).toHaveLength(installed.length);
  });

  test('gain one bookmark for a test-only extra check, and a rerun installs only that one', async () => {
    const { request, requests } = fakeDirectus(freshState());

    const summary = await installPresentation(request, withExtraCheck);

    expect(installedReviews(mutations(requests))).toEqual(
      reviewedBy(withExtraCheck),
    );
    expect(summary.presets.created).toBe(presetDefinitions.length + 1);
    expect(presetDefinitionsFor(withExtraCheck)).toHaveLength(
      presetDefinitions.length + 1,
    );

    const rerun = fakeDirectus(appliedState());
    const again = await installPresentation(rerun.request, withExtraCheck);

    expect(mutations(rerun.requests)).toEqual([
      expect.objectContaining({ method: 'POST', pathname: '/presets' }),
    ]);
    expect(installedReviews(mutations(rerun.requests))).toEqual([
      {
        bookmark: 'Synthetic entries without a code',
        collection: 'curriculum_entries',
        fields: ['generation', 'name', 'code'],
        filter: { code: { _null: true } },
      },
    ]);
    expect(again.presets).toEqual({
      adopted: 0,
      created: 1,
      skipped: presetDefinitions.length,
    });
  });

  test('create nothing on a rerun, and give each generation-scoped check one bookmark that names no generation row', async () => {
    const { request, requests } = fakeDirectus(appliedState());

    await installPresentation(request);

    expect(mutations(requests)).toEqual([]);

    const scoped = readinessRegistry.flatMap(
      ({ generationScoped, page, review }) =>
        generationScoped && review !== undefined
          ? [{ bookmark: review.bookmark, collection: page }]
          : [],
    );
    const bookmarks = reviewPresets().map(({ bookmark, collection }) => ({
      bookmark,
      collection,
    }));

    expect(scoped.length).toBeGreaterThan(1);
    expect(bookmarks).toEqual(expect.arrayContaining(scoped));
    expect(
      reviewPresets().filter(({ filter }) =>
        generationRowPattern.test(JSON.stringify(filter)),
      ),
    ).toEqual([]);
  });
});

describe('installPresentation on a fresh schema', () => {
  test('applies folders, placements, groups, field metas and presets in that order', async () => {
    const { request, requests } = fakeDirectus(freshState());

    const summary = await installPresentation(request);

    const writes = mutations(requests);

    expect(byShape(writes, 'POST', collectionsPath)).toHaveLength(
      folders.length,
    );
    expect(byShape(writes, 'PATCH', collectionPath)).toHaveLength(
      collectionPlacements.length,
    );
    expect(byShape(writes, 'POST', fieldsPath)).toHaveLength(
      fieldGroups.length,
    );
    expect(byShape(writes, 'PATCH', fieldPath)).toHaveLength(
      presentationFieldPatches.length,
    );
    expect(byShape(writes, 'POST', presetsPath)).toHaveLength(
      presetDefinitions.length,
    );
    expect(writes).toHaveLength(totalWrites);
    expect(summary).toEqual({
      collections: {
        adopted: collectionPlacements.length,
        created: folders.length,
        skipped: 0,
      },
      fields: {
        adopted: presentationFieldPatches.length,
        created: 0,
        skipped: 0,
      },
      groups: { adopted: 0, created: fieldGroups.length, skipped: 0 },
      presets: { adopted: 0, created: presetDefinitions.length, skipped: 0 },
    });

    const ordered = writes.map(
      ({ method, pathname }) => `${method} ${pathname}`,
    );

    expect(ordered.indexOf('POST /collections')).toBeLessThan(
      ordered.indexOf('PATCH /collections/courses'),
    );
    expect(ordered.indexOf('POST /fields/courses')).toBeLessThan(
      ordered.indexOf('PATCH /fields/courses/name'),
    );
    expect(ordered.indexOf('PATCH /fields/courses/name')).toBeLessThan(
      ordered.indexOf('POST /presets'),
    );
  });

  test('sends the group, filter, membership and folder bodies Studio expects', async () => {
    const { request, requests } = fakeDirectus(freshState());

    await installPresentation(request);

    const writes = mutations(requests);
    const overview = groupBody.parse(
      writes.find((call) => isGroupPost(call, 'overview'))?.body,
    );

    expect(overview.meta.special).toEqual(['alias', 'no-data', 'group']);
    expect(overview.meta.interface).toBe('group-detail');
    expect(overview.meta.readonly).toBe(false);

    const usage = groupBody.parse(
      writes.find((call) => isGroupPost(call, 'usage'))?.body,
    );

    expect(usage.meta.readonly).toBeTruthy();
    expect(usage.meta.options.start).toBe('closed');

    const entry = writes.find(
      ({ pathname }) => pathname === '/fields/course_curricula/entry',
    );

    expect(metaBody.parse(entry?.body).meta['options']).toMatchObject({
      filter: generationFilter,
    });

    const name = writes.find(
      ({ pathname }) => pathname === '/fields/courses/name',
    );

    expect(metaBody.parse(name?.body).meta).toEqual({
      group: 'overview',
      sort: 1,
    });

    const folder = collectionBody.parse(
      byShape(writes, 'POST', collectionsPath)[0]?.body,
    );

    expect(folder.collection).toBe('courses_and_curriculum');
    expect(folder.meta.translations[0]?.translation).toBe(
      'Courses & curriculum',
    );
    expect(Object.keys(folder)).not.toContain('schema');
  });

  test('leaves a field alone once a Studio user changed its interface or options', async () => {
    const state = freshState();
    editLiveMeta(
      state,
      { collection: 'course_curricula', field: 'entry' },
      { interface: 'input', options: null },
    );
    editLiveMeta(
      state,
      { collection: 'courses', field: 'curricula' },
      {
        options: {
          ...options.parse(
            baselineFieldMeta('courses', 'curricula')['options'],
          ),
          enableCreate: false,
        },
      },
    );
    const { request, requests } = fakeDirectus(state);

    const summary = await installPresentation(request);

    const paths = mutations(requests).map(({ pathname }) => pathname);

    expect(paths).not.toContain('/fields/course_curricula/entry');
    expect(paths).not.toContain('/fields/courses/curricula');
    expect(paths).toContain('/fields/course_curricula/available');
    expect(summary.fields).toEqual({
      adopted: presentationFieldPatches.length - 2,
      created: 0,
      skipped: 2,
    });
  });
});

describe('installPresentation over Studio edits', () => {
  test('keeps a collection where a user filed it and never duplicates an existing bookmark', async () => {
    const state = freshState();
    const courses = state.collections.find(
      ({ collection }) => collection === 'courses',
    );
    if (courses === undefined) {
      throw new Error('courses missing');
    }
    courses.meta = { ...courses.meta, group: 'my_own_folder' };
    state.presets = [
      {
        bookmark: 'Curriculum by generation',
        collection: 'curriculum_entries',
        role: null,
        user: null,
      },
      { bookmark: null, collection: 'courses', role: null, user: null },
    ];
    const { request, requests } = fakeDirectus(state);

    const summary = await installPresentation(request);

    const writes = mutations(requests);

    expect(writes.map(({ pathname }) => pathname)).not.toContain(
      '/collections/courses',
    );

    const created = byShape(writes, 'POST', presetsPath).map(({ body }) =>
      presetBody.parse(body),
    );

    expect(created).not.toContainEqual({
      bookmark: 'Curriculum by generation',
      collection: 'curriculum_entries',
    });
    expect(created).not.toContainEqual({
      bookmark: null,
      collection: 'courses',
    });
    expect(created).toContainEqual({
      bookmark: null,
      collection: 'curriculum_entries',
    });
    expect(summary.collections.skipped).toBe(1);
    expect(summary.presets).toEqual({
      adopted: 0,
      created: presetDefinitions.length - 2,
      skipped: 2,
    });
  });

  test('installs Unmapped history lines as declared, keeps an existing one and installs it again once deleted', async () => {
    const isUnmapped = (call: RecordedRequest): boolean =>
      presetBody.safeParse(call.body).data?.bookmark ===
      unmappedLinesBookmark.bookmark;
    const fresh = fakeDirectus(freshState());

    await installPresentation(fresh.request);

    expect(
      byShape(mutations(fresh.requests), 'POST', presetsPath)
        .filter((call) => isUnmapped(call))
        .map(({ body }) => body),
    ).toEqual([unmappedLinesBookmark]);

    const kept = fakeDirectus(appliedState());

    await installPresentation(kept.request);

    expect(mutations(kept.requests)).toEqual([]);

    const state = appliedState();
    state.presets = (state.presets ?? []).filter(
      ({ bookmark }) => bookmark !== unmappedLinesBookmark.bookmark,
    );
    const deleted = fakeDirectus(state);

    const summary = await installPresentation(deleted.request);

    expect(mutations(deleted.requests).map((call) => isUnmapped(call))).toEqual(
      [true],
    );
    expect(summary.presets).toEqual({
      adopted: 0,
      created: 1,
      skipped: presetDefinitions.length - 1,
    });
  });

  test('skips a group and its members when a non-group field already carries the name', async () => {
    const state = freshState();
    state.fields['courses']?.push({
      field: 'overview',
      meta: { interface: 'input', special: null },
      schema: {
        is_indexed: false,
        is_nullable: true,
        is_primary_key: false,
        is_unique: false,
      },
      type: 'string',
    });
    const overviewMembers =
      courseGroups.find(({ field }) => field === 'overview')?.members ?? [];
    const { request, requests } = fakeDirectus(state);

    const summary = await installPresentation(request);

    const writes = mutations(requests);
    const paths = writes.map(({ pathname }) => pathname);

    expect(writes.filter((call) => isGroupPost(call, 'overview'))).toEqual([]);
    expect(paths).toContain('/fields/courses');
    expect(
      overviewMembers.filter((member) =>
        paths.includes(`/fields/courses/${member}`),
      ),
    ).toEqual([]);
    expect(summary.groups).toEqual({
      adopted: 0,
      created: fieldGroups.length - 1,
      skipped: 1,
    });
    expect(summary.fields.skipped).toBe(overviewMembers.length);
  });
});

describe('installPresentation once applied', () => {
  test('issues no mutating call', async () => {
    const { request, requests } = fakeDirectus(appliedState());

    const summary = await installPresentation(request);

    expect(mutations(requests)).toEqual([]);
    expect(summary).toEqual({
      collections: {
        adopted: 0,
        created: 0,
        skipped: folders.length + collectionPlacements.length,
      },
      fields: {
        adopted: 0,
        created: 0,
        skipped: presentationFieldPatches.length,
      },
      groups: { adopted: 0, created: 0, skipped: fieldGroups.length },
      presets: { adopted: 0, created: 0, skipped: presetDefinitions.length },
    });
  });

  test('does not recreate a group a user deleted while its members stay changed', async () => {
    const state = appliedState();
    const fields = state.fields['courses'];
    const index = fields?.findIndex(({ field }) => field === 'moodle') ?? -1;
    fields?.splice(index, 1);
    const { request, requests } = fakeDirectus(state);

    const summary = await installPresentation(request);

    expect(mutations(requests)).toEqual([]);
    expect(summary.groups.created).toBe(0);
  });
});

describe('labels and the presentation', () => {
  test('takes the declared label of every field and alias, or none, into the installer baseline', () => {
    const baselines = dataModelCollections.flatMap(baselineLabels);

    expect(baselines.length).toBeGreaterThan(0);
    expect(
      baselines.filter(
        ({ actual, expected }) => !isDeepStrictEqual(actual, expected),
      ),
    ).toEqual([]);
  });

  test('adopts a field whose installed meta carries a label, and never sends a label itself', async () => {
    const state = freshState();
    editLiveMeta(
      state,
      { collection: 'courses', field: 'name' },
      { translations: fieldTranslations('Course name') },
    );
    const { request, requests } = fakeDirectus(state);

    await installPresentation(request);

    const patches = byShape(mutations(requests), 'PATCH', fieldPath);
    const name = patches.find(
      ({ pathname }) => pathname === '/fields/courses/name',
    );

    expect(metaBody.parse(name?.body).meta).toEqual({
      group: 'overview',
      sort: 1,
    });
    expect(patches).toHaveLength(presentationFieldPatches.length);
    expect(
      patches.filter(({ body }) =>
        Object.hasOwn(metaBody.parse(body).meta, 'translations'),
      ),
    ).toEqual([]);
  });
});
