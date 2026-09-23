import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { dataModelCollections } from '../src/data-model/collections.js';
import { installPresentation } from '../src/data-model/presentation.js';
import {
  baselineFieldMeta,
  entryLockedWithoutGeneration,
  fieldPresentations,
  findFieldPatch,
  generationFilter,
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
  curriculumBookmarks,
  presetDefinitions,
} from '../src/data-model/presentation/presets.js';
import { aliasesFor, modelRelations } from '../src/data-model/relations.js';
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
  effectiveFieldMeta,
  freshState,
} from './presentation-test-helpers.js';

const collator = new Intl.Collator('en');
const descendingPrefix = /^-/u;
const collectionsPath = /^\/collections$/u;
const collectionPath = /^\/collections\/[^/]+$/u;
const fieldsPath = /^\/fields\/[^/]+$/u;
const fieldPath = /^\/fields\/[^/]+\/[^/]+$/u;
const presetsPath = /^\/presets$/u;

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

const relatedCollection = (
  collection: string,
  field: string,
): string | undefined =>
  modelRelations.find(
    (relation) =>
      relation.collection === collection && relation.field === field,
  )?.related;

// Whether a tabular preset path such as `student.name` resolves in the model.
const resolves = (collection: string, path: string): boolean => {
  const [head, ...rest] = path.replace(descendingPrefix, '').split('.');
  if (head === undefined || !fieldNames(collection).includes(head)) {
    return false;
  }
  if (rest.length === 0) {
    return true;
  }
  const related = relatedCollection(collection, head);
  return related !== undefined && resolves(related, rest.join('.'));
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
  'data_operation_results',
  'data_operations',
  'migration_ledger',
  'moodle_history_memberships',
  'moodle_import_rows',
];

const courseGroups = fieldGroups.filter(
  ({ collection }) => collection === 'courses',
);

const derivedCourseFields = findCollection('courses').fields.flatMap(
  ({ field, readOnly }) => (readOnly === true ? [field] : []),
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

const unresolvedPresetPaths = presetDefinitions.flatMap((preset) =>
  [...preset.layout_query.tabular.fields, ...preset.layout_query.tabular.sort]
    .filter((path) => !resolves(preset.collection, path))
    .map((path) => `${preset.collection}: ${path}`),
);

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

describe('field groups', () => {
  test('groups every course field once, with the derived columns collapsed and read-only', () => {
    expect(courseGroups.map(({ field }) => field)).toEqual([
      'overview',
      'curriculum',
      'staff',
      'moodle',
      'enrollment',
      'legacy_calculated',
    ]);
    expect(sorted(courseGroups.flatMap(({ members }) => members))).toEqual(
      sorted(fieldNames('courses')),
    );

    const legacy = courseGroups.find(
      ({ field }) => field === 'legacy_calculated',
    );

    expect(legacy?.start).toBe('closed');
    expect(legacy?.readOnly).toBeTruthy();
    expect(sorted(legacy?.members ?? [])).toEqual(sorted(derivedCourseFields));
  });

  test('collapses the imported labels and provenance of an assignment together', () => {
    const legacy = findFieldGroup('teaching_assignments', 'legacy_imported');

    expect(legacy?.start).toBe('closed');
    expect(legacy?.members).toEqual([
      'professors',
      'assistants',
      'source_collection',
      'source_id',
    ]);
    expect(
      findFieldPatch('teaching_assignments', 'source_id')?.meta.group,
    ).toBe('legacy_imported');
    expect(
      findFieldPatch('teaching_assignments', 'course_name')?.meta.group,
    ).toBeUndefined();
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

describe('field presentation', () => {
  test('filters the curriculum entry picker by the link generation', () => {
    const entry = effectiveFieldMeta('course_curricula', 'entry');

    expect(entry['interface']).toBe('select-dropdown-m2o');
    expect(entry['options']).toMatchObject({
      enableSelect: true,
      filter: generationFilter,
      template: '{{code}} - {{name}} ({{generation}})',
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
    expect(entry['conditions']).toEqual([entryLockedWithoutGeneration]);
    // Studio evaluates only rules with exactly one top-level key.
    expect(
      declaredConditions.filter(
        ({ condition }) => Object.keys(condition.rule).length !== 1,
      ),
    ).toEqual([]);
    expect(declaredConditions.map(({ field }) => field)).toEqual([
      'course_curricula.entry',
    ]);
  });

  test('keeps the copied council name visible but read-only beside the linked student', () => {
    expect(effectiveFieldMeta('student_council', 'name')).toMatchObject({
      hidden: false,
      readonly: true,
    });
    expect(effectiveFieldMeta('student_council', 'student')).toMatchObject({
      display: 'related-values',
      interface: 'select-dropdown-m2o',
    });
    expect(
      collectionPlacements.find(
        ({ collection }) => collection === 'student_council',
      )?.meta.display_template,
    ).toBe('{{year}} - {{student.name}}');
  });

  test('leaves the choices and rule of every enum to its declaration', () => {
    const enums = new Set(dataModelCollections.flatMap(enumNames));
    const owned = presentationFieldPatches.filter(
      ({ collection, field, meta }) =>
        enums.has(`${collection}.${field}`) && ownsChoices(meta),
    );

    expect(enums.size).toBeGreaterThanOrEqual(10);
    expect(owned).toEqual([]);
  });

  test('labels the role and review-state dropdowns', () => {
    expect(choicesOf('teaching_assignments', 'role')).toEqual([
      { text: 'Professor', value: 'professor' },
      { text: 'Assistant', value: 'assistant' },
    ]);
    expect(effectiveFieldMeta('teaching_assignments', 'role')['display']).toBe(
      'labels',
    );
    expect(
      choicesOf('moodle_course_entries', 'review_state').map(
        ({ value }) => value,
      ),
    ).toEqual(['needs_mapping', 'mapped', 'ignored']);
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
    const history = relationLists.find(
      ({ field }) => field === 'moodle_users.history_memberships',
    );

    expect(assignments?.fields).toEqual(['role', 'staff', 'display_override']);
    expect(assignments?.sort).toBe('sort');
    expect(history?.fields).toEqual(['entry', 'sort']);
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

describe('presets', () => {
  test('defines the 2018 and 2023 curriculum bookmarks from the repository file', () => {
    expect(
      curriculumBookmarks.map(({ bookmark, collection, filter }) => ({
        bookmark,
        collection,
        filter,
      })),
    ).toEqual([
      {
        bookmark: 'Curriculum 2018',
        collection: 'curriculum_entries',
        filter: { generation: { _eq: '2018' } },
      },
      {
        bookmark: 'Curriculum 2023',
        collection: 'curriculum_entries',
        filter: { generation: { _eq: '2023' } },
      },
    ]);
    expect(curriculumBookmarks.map(({ role, user }) => [role, user])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  test('lists only fields that exist on the collection or its relation targets', () => {
    expect(unresolvedPresetPaths).toEqual([]);

    const defaults = presetDefinitions.filter(
      ({ bookmark }) => bookmark === null,
    );

    expect(new Set(defaults.map(({ collection }) => collection)).size).toBe(
      defaults.length,
    );
    expect(defaults.map(({ collection }) => collection)).not.toContain(
      'data_operations',
    );
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

    const legacy = groupBody.parse(
      writes.find((call) => isGroupPost(call, 'legacy_calculated'))?.body,
    );

    expect(legacy.meta.readonly).toBeTruthy();
    expect(legacy.meta.options.start).toBe('closed');

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
        bookmark: 'Curriculum 2018',
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
      bookmark: 'Curriculum 2018',
      collection: 'curriculum_entries',
    });
    expect(created).not.toContainEqual({
      bookmark: null,
      collection: 'courses',
    });
    expect(created).toContainEqual({
      bookmark: 'Curriculum 2023',
      collection: 'curriculum_entries',
    });
    expect(summary.collections.skipped).toBe(1);
    expect(summary.presets).toEqual({
      adopted: 0,
      created: presetDefinitions.length - 2,
      skipped: 2,
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
