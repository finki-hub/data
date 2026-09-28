import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { FakeItem, FakeStore } from './migration-test-helpers.js';

import {
  fileKeys,
  readFileSources,
} from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import { resolveFields } from '../directus/extensions/directus-extension-data-operations/src/exports/field-map.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { readinessAction } from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import { legacyImportColumns } from '../src/data-model/presentation/groups.js';
import { academicYears } from '../src/specs/public.js';
import {
  assignmentTexts,
  expectedFiles,
  expectedKeys,
  expectedRows,
  type ExportCase,
} from './expected-exports.js';
import {
  courseNames,
  forbiddenPrivateFields,
  makeSyntheticDataset,
  privateSentinels,
} from './fixtures/synthetic-data.js';
import { lifecycleDataset } from './fixtures/synthetic-workbook.js';
import {
  convertedStore,
  edit,
  engineAssets,
  generationIdOf,
  injecting,
  parityDataset,
  publishedFiles,
  refusalOf,
  renamedCurrent,
  reversed,
  storeReader,
  unmatchedLabel,
  unmatchedLegacy,
  withLinkedLabel,
} from './relational-export-helpers.js';
import { prepare, rowsOf } from './relational-migration-helpers.js';

const assetsSchema = z.strictObject({
  courses: z.array(z.record(z.string(), z.string())),
  rooms: z.array(z.record(z.string(), z.string())),
  staff: z.array(z.record(z.string(), z.string())),
  students: z.array(z.record(z.string(), z.string())),
});

type Assets = z.infer<typeof assetsSchema>;

const projected = async (
  store: Parameters<typeof storeReader>[0],
  reader = storeReader(store),
): Promise<Assets> =>
  assetsSchema.parse(await engineAssets(exportDefinitions, reader));

// The four files the definitions publish over a store: each exact body
// and its sha256, to compare with the committed expected files.
const publishedOf = (store: Parameters<typeof storeReader>[0]) =>
  publishedFiles(exportDefinitions, storeReader(store));

// Parsed JSON compared as text, so key order, row order and every string
// form count, not only deep equality.
const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

// Readiness over a store, with current calculations and a promoted
// snapshot: only the checks of the definitions decide.
const readinessOf = (store: Parameters<typeof storeReader>[0]) =>
  readinessAction(exportDefinitions, {
    coordination: () =>
      Promise.resolve({
        calculation: 'graph-a',
        domains: { enrollments: 'current', history_index: 'current' },
        revision: 1,
      }),
    reader: storeReader(store),
    snapshot: () =>
      Promise.resolve({
        activeMatchesPromotion: true,
        activeRows: 9,
        state: 'completed',
      }),
  });

const courseNamed = (assets: Pick<Assets, 'courses'>, name: string) =>
  assets.courses.find((row) => row['name'] === name);

// The course row of the name in a case's committed courses.json.
const expectedCourse = async (name: ExportCase, course: string) =>
  courseNamed({ courses: [...(await expectedRows(name, 'courses'))] }, course);

const renamed =
  (field: string, from: string, to: string) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.map((row) => (row[field] === from ? { ...row, [field]: to } : row));

const setOnCourse =
  (name: string, field: string, value: null | string) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.map((row) =>
      row['name'] === name ? { ...row, [field]: value } : row,
    );

// The column set to the value on every course.
const setEverywhere =
  (column: string, value: unknown) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.map((row) => ({ ...row, [column]: value }));

// An edited value of each kind of import column; names take a label.
const importEdits: Readonly<Record<string, unknown>> = {
  available: false,
  credits: 99,
};

const coursesFile = 'courses.json';

const definitionOf = (filename: string) => {
  const definition = exportDefinitions.find(
    (candidate) => candidate.filename === filename,
  );
  if (definition === undefined) {
    throw new Error(`${filename} is not declared`);
  }
  return definition;
};

// The keys a file resolves to over the converted fixture (the published
// years included), in output order.
const keysOf = async (filename: string, store?: FakeStore) => {
  const definition = definitionOf(filename);
  return fileKeys(
    definition,
    await readFileSources(
      definition,
      storeReader(store ?? (await convertedStore())),
    ),
  );
};

// The keys a definition publishes as "1"/"0" over the converted fixture.
const numericKeys = async (definition: (typeof exportDefinitions)[number]) => {
  const { keyRows } = await readFileSources(
    definition,
    storeReader(await convertedStore()),
  );
  return resolveFields(definition, keyRows)
    .filter(({ rule }) => rule === 'numeric_boolean')
    .map(({ key }) => key);
};

// A count row of the year for every course of the store.
const countsOf = (courses: readonly FakeItem[], year: number): FakeItem[] =>
  courses.map((course, index) => ({
    academic_year: year,
    count: 7,
    course: course.id,
    id: 900 + index,
  }));

const isLink = (row: FakeItem, course: number, generation: number) =>
  row['course'] === course && row['generation'] === generation;

// Every role row but those converted from the assignment row.
const withoutSource =
  (source: number) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.filter((row) => row['source_id'] !== source);

// Every count row but the one of the course and academic year.
const withoutCount =
  (course: number, year: number) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.filter(
      (row) => row['course'] !== course || row['academic_year'] !== year,
    );

// A second link of the course and generation.
const duplicateLink =
  (course: number, generation: number) =>
  (rows: FakeItem[]): FakeItem[] => [
    ...rows,
    ...rows
      .filter((row) => isLink(row, course, generation))
      .map((row) => ({ ...row, id: 900 })),
  ];

// The course's legacy (2018) link pointed at its current (2023) entry.
const crossedLink =
  (course: number, ids: { current: number; legacy: number }) =>
  (rows: FakeItem[]): FakeItem[] => {
    const current = rows.find((row) => isLink(row, course, ids.current));
    return rows.map((row) =>
      isLink(row, course, ids.legacy)
        ? { ...row, entry: current?.['entry'] }
        : row,
    );
  };

describe('parity with the committed public files', () => {
  test('projects the converted fixture into exactly the committed parity files, byte for byte', async () => {
    const store = await convertedStore(parityDataset());
    const assets = await projected(store);

    await expect(publishedOf(store)).resolves.toEqual(
      await expectedFiles('parity'),
    );
    // The files cover the value rules: false, zero, empty and null.
    expect(courseNamed(assets, courseNames.beta)).toMatchObject({
      '2018-credits': '0',
      '2023-channel': '0',
      channel: 'TRUE',
      professors: 'Prof. Beta Override',
    });
    expect(courseNamed(assets, courseNames.zeta)).toMatchObject({
      '2018-channel': '0',
      '2023-available': 'FALSE',
      '2023-credits': '0',
      channel: 'FALSE',
    });
    expect(courseNamed(assets, courseNames.zeta)).not.toHaveProperty(
      '2023-code',
    );
    expect(courseNamed(assets, courseNames.alpha)?.['professors']).toBe(
      'Prof. Zed Alpha, Prof. Abe Alpha',
    );
    expect(assets.rooms.map((room) => room['floor'])).toEqual(['0', '2', '-1']);
    expect(assets.staff.map((row) => row['active'])).toContain('0');
  });

  test('declares exactly the committed keys of every file, in their order', async () => {
    expect(exportDefinitions.map(({ filename }) => filename)).toEqual([
      'courses.json',
      'rooms.json',
      'staff.json',
      'students.json',
    ]);
    await expect(keysOf(coursesFile)).resolves.toEqual(
      await expectedKeys('courses'),
    );
    await expect(keysOf('rooms.json')).resolves.toEqual(
      await expectedKeys('rooms'),
    );
    await expect(keysOf('staff.json')).resolves.toEqual(
      await expectedKeys('staff'),
    );
    await expect(keysOf('students.json')).resolves.toEqual(
      await expectedKeys('students'),
    );
  });

  test('publishes "1"/"0" exactly where the committed files do', async () => {
    // The files publish active, 2023-channel and 2018-channel as 1/0.
    const numeric = await Promise.all(exportDefinitions.map(numericKeys));

    expect(numeric.flat()).toEqual(['2023-channel', '2018-channel', 'active']);
  });

  test('keeps the ambiguous checkpoint fixture out of the conversion instead of guessing', async () => {
    const { report } = await prepare(makeSyntheticDataset());

    expect(report.blockers.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'ambiguous_curriculum_2018',
        'ambiguous_curriculum_2023',
      ]),
    );
  });

  test('orders every file by canonical id whatever order the reads answer', async () => {
    const store = await convertedStore();

    expect(
      sameJson(
        await projected(store, reversed(storeReader(store))),
        await projected(store),
      ),
    ).toBeTruthy();
  });

  test('exports an empty project as four empty files', async () => {
    const empty = await projected({
      flows: [],
      items: new Map(),
      limitMax: null,
      operations: [],
    });

    expect(empty).toEqual({ courses: [], rooms: [], staff: [], students: [] });
  });
});

describe('every difference from the committed files blocks readiness', () => {
  test('the unresolved lifecycle fixture differs only at its two review items, each a blocker until resolved', async () => {
    const store = await convertedStore(lifecycleDataset());
    const assets = await projected(store);

    // The duplicate assignment row publishes its labels too, and a 2018
    // availability without a 2018 curriculum has no link to live on.
    expect(courseNamed(assets, courseNames.alpha)?.['professors']).toBe(
      'Prof. Zed Alpha, Prof. Later Alpha, Prof. Abe Alpha',
    );

    const expectedAlpha = await expectedCourse('lifecycle', courseNames.alpha);

    expect(expectedAlpha?.['professors']).toBe(
      'Prof. Zed Alpha, Prof. Abe Alpha',
    );
    expect(courseNamed(assets, courseNames.gamma)).not.toHaveProperty(
      '2018-available',
    );
    await expect(
      expectedCourse('lifecycle', courseNames.gamma),
    ).resolves.toHaveProperty('2018-available', 'FALSE');

    // Both review items live in courses.json: the other three files are
    // already exactly the committed lifecycle ones.
    const { rooms, staff, students } = await expectedFiles('lifecycle');

    await expect(publishedOf(store)).resolves.toMatchObject({
      rooms,
      staff,
      students,
    });
    await expect(readinessOf(store)).resolves.toMatchObject({
      blockers: ['curriculum_value_unlinked', 'assignment_source_duplicate'],
      issueCounts: {
        assignment_source_duplicate: 1,
        curriculum_value_unlinked: 1,
      },
      ready: false,
    });

    // The editor's resolutions: the later row's role rows removed, Gamma's
    // imported 2018 availability cleared.
    edit(store, 'teaching_assignments', withoutSource(2));
    edit(
      store,
      'courses',
      setOnCourse(courseNames.gamma, 'available_2018', null),
    );

    await expect(readinessOf(store)).resolves.toMatchObject({ ready: true });
    await expect(publishedOf(store)).resolves.toEqual(
      await expectedFiles('parity'),
    );
  });

  test.each([
    {
      change: renamedCurrent,
      expected: 'renamed-current',
      generation: '2023',
      label: 'a 2023 name',
      name: courseNames.iota,
    },
    {
      change: unmatchedLegacy,
      expected: 'unmatched-legacy',
      generation: '2018',
      label: 'an equivalency 2018 label',
      name: courseNames.zeta,
    },
  ] as const)(
    '$label that matched no entry blocks until an editor links the label, then publishes exactly the committed file',
    async ({ change, expected, generation, name }) => {
      const store = await convertedStore(change(parityDataset()));
      const course = rowsOf(store, 'courses').find(
        (row) => row['name'] === name,
      );

      await expect(expectedCourse(expected, name)).resolves.toHaveProperty(
        `${generation}-name`,
        unmatchedLabel,
      );
      expect(courseNamed(await projected(store), name)).not.toHaveProperty(
        `${generation}-name`,
      );
      await expect(readinessOf(store)).resolves.toMatchObject({
        issueCounts: { curriculum_value_unlinked: 1 },
        ready: false,
      });

      withLinkedLabel(store, Number(course?.id), generation);

      await expect(readinessOf(store)).resolves.toMatchObject({ ready: true });
      await expect(publishedOf(store)).resolves.toEqual(
        await expectedFiles(expected),
      );
    },
  );

  test.each(
    assignmentTexts.map((text, index) => ({
      expected: `assignment-text-${String(index + 1)}` as const,
      text,
    })),
  )(
    'republishes the assignment text $text exactly although every part names a staff row',
    async ({ expected, text }) => {
      const base = parityDataset();
      const store = await convertedStore({
        ...base,
        teaching_assignments: base.teaching_assignments.map((row) =>
          row.id === 1 ? { ...row, professors: text } : row,
        ),
      });

      await expect(publishedOf(store)).resolves.toEqual(
        await expectedFiles(expected),
      );
      await expect(readinessOf(store)).resolves.toMatchObject({ ready: true });
    },
  );
});

// The keys of a course row after `professors`, up to the first key that
// is not an academic year label.
const yearKeys = (row: Readonly<Record<string, string>> | undefined) => {
  const keys = Object.keys(row ?? {});
  const first = keys.indexOf('professors') + 1;
  return keys.slice(first, keys.indexOf('2023-available'));
};

// The academic year of the label, unpublished.
const unpublished =
  (label: string) =>
  (rows: FakeItem[]): FakeItem[] =>
    rows.map((row) =>
      row['label'] === label ? { ...row, published: false } : row,
    );

// Every course row without the key.
const withoutKey = (assets: Assets, key: string) =>
  assets.courses.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([name]) => name !== key)),
  );

describe('year configuration', () => {
  test('publishes the fifteen converted years, newest first, where the reference lists them', async () => {
    const assets = await projected(await convertedStore());

    expect(yearKeys(assets.courses[0])).toEqual([...academicYears]);
    expect(
      rowsOf(await convertedStore(), 'academic_years').every(
        (year) => year['published'] === true,
      ),
    ).toBeTruthy();
  });

  test('leaves an unpublished year out of every course and changes nothing else', async () => {
    const store = await convertedStore();
    const before = await projected(store);
    edit(store, 'academic_years', unpublished('2014/2015'));
    const after = await projected(store);

    expect(JSON.stringify(after)).not.toContain('2014/2015');
    expect(after.courses).toEqual(withoutKey(before, '2014/2015'));
    expect(after.rooms).toEqual(before.rooms);

    const committedKeys = await expectedKeys('courses');

    await expect(keysOf(coursesFile, store)).resolves.toHaveLength(
      committedKeys.length - 1,
    );
  });

  test('opting a new year in adds exactly one key per course, at the newest position, and nothing else', async () => {
    const store = await convertedStore();
    const before = await projected(store);
    edit(store, 'academic_years', (rows) => [
      ...rows,
      { id: 99, label: '2026/2027', published: true, sort: 16 },
    ]);
    edit(store, 'course_enrollments', (rows) => [
      ...rows,
      ...countsOf(rowsOf(store, 'courses'), 99),
    ]);
    const after = await projected(store);

    expect(after.courses.map((row) => row['2026/2027'])).toEqual(
      Array.from(before.courses, () => '7'),
    );
    expect(withoutKey(after, '2026/2027')).toEqual(before.courses);
    expect(yearKeys(after.courses[0])).toEqual(['2026/2027', ...academicYears]);
    expect(
      sameJson({ ...after, courses: withoutKey(after, '2026/2027') }, before),
    ).toBeTruthy();
  });

  test('a new academic year with counts for every course adds no public key', async () => {
    const store = await convertedStore();
    const before = await projected(store);
    edit(store, 'academic_years', (rows) => [
      ...rows,
      { id: 99, label: '2026/2027', sort: 16 },
    ]);
    edit(store, 'course_enrollments', (rows) => [
      ...rows,
      ...countsOf(rowsOf(store, 'courses'), 99),
    ]);
    const after = await projected(store);

    expect(sameJson(after, before)).toBeTruthy();
    expect(JSON.stringify(after)).not.toContain('2026/2027');
  });

  test('refuses a published year whose label is another key of the file', async () => {
    const store = edit(await convertedStore(), 'academic_years', (rows) => [
      ...rows,
      { id: 98, label: 'tags', published: true, sort: 20 },
    ]);

    await expect(refusalOf(() => projected(store))).resolves.toEqual({
      code: 'EXPORT_UNRESOLVED',
      message:
        'courses.json would publish the key tags twice: a key-source row names another key; nothing was prepared.',
    });
  });

  test('refuses a published year labelled __proto__, a key a row object would drop', async () => {
    const store = edit(await convertedStore(), 'academic_years', (rows) => [
      ...rows,
      { id: 98, label: '__proto__', published: true, sort: 20 },
    ]);

    await expect(refusalOf(() => projected(store))).resolves.toEqual({
      code: 'EXPORT_UNRESOLVED',
      message:
        'courses.json cannot publish the key __proto__, which a key-source row names; nothing was prepared.',
    });
  });

  test('refuses a course without a count row for an exported year instead of writing zero', async () => {
    const store = edit(
      await convertedStore(),
      'course_enrollments',
      withoutCount(2, 3),
    );

    await expect(refusalOf(() => projected(store))).resolves.toEqual({
      code: 'EXPORT_UNRESOLVED',
      message:
        'Course 2 has 0 enrollment counts for 2023/2024; nothing was prepared.',
    });
  });
});

describe('relation values resolved on read', () => {
  test('publishes a renamed staff member and a renamed entry without any rebuild', async () => {
    const store = await convertedStore();
    edit(store, 'staff', renamed('name', 'Prof. Theta', 'Prof. Theta Renamed'));
    edit(
      store,
      'curriculum_entries',
      renamed('code', 'SYN23-007', 'SYN23-007-R'),
    );
    const theta = courseNamed(await projected(store), courseNames.theta);

    expect(theta).toMatchObject({
      '2023-code': 'SYN23-007-R',
      professors: 'Prof. Theta Renamed',
    });
  });

  test('orders labels by sort then id, prefers a display label and yields to the professors override', async () => {
    const store = edit(
      await convertedStore(),
      'teaching_assignments',
      (rows) => [
        ...rows,
        {
          course: 7,
          display_override: 'Visiting Lecturer',
          id: 500,
          role: 'professor',
          sort: 0,
          staff: null,
        },
        {
          course: 7,
          display_override: 'Shown Instead',
          id: 501,
          role: 'assistant',
          sort: null,
          staff: 5,
        },
        {
          course: 2,
          display_override: 'Hidden By Override',
          id: 502,
          role: 'professor',
          sort: 1,
          staff: null,
        },
      ],
    );
    const assets = await projected(store);

    expect(courseNamed(assets, courseNames.theta)).toMatchObject({
      assistants: 'Asst. Theta, Shown Instead',
      professors: 'Visiting Lecturer, Prof. Theta',
    });
    expect(courseNamed(assets, courseNames.beta)?.['professors']).toBe(
      'Prof. Beta Override',
    );
  });

  test.each(legacyImportColumns)(
    'publishes nothing from the read-only import column %s',
    async (column) => {
      const store = await convertedStore();
      const before = await projected(store);
      const [kind = ''] = column.split('_');
      const value = importEdits[kind] ?? 'Edited Import Label';
      edit(store, 'courses', setEverywhere(column, value));

      expect(sameJson(await projected(store), before)).toBeTruthy();
    },
  );

  test.each([
    [
      { display_override: null, staff: null },
      'Assignment 500 of course 7 has no label; nothing was prepared.',
    ],
    [
      { display_override: 'Label', role: null },
      'Assignment 500 of course 7 has no role; nothing was prepared.',
    ],
  ])('refuses the assignment %j', async (change, message) => {
    const store = edit(
      await convertedStore(),
      'teaching_assignments',
      (rows) => [
        ...rows,
        {
          course: 7,
          id: 500,
          role: 'assistant',
          sort: 9,
          staff: null,
          ...change,
        },
      ],
    );

    await expect(refusalOf(() => projected(store))).resolves.toEqual({
      code: 'EXPORT_UNRESOLVED',
      message,
    });
  });

  test('refuses two links of one generation and a link to an entry of the other generation', async () => {
    const twice = await convertedStore();
    edit(
      twice,
      'course_curricula',
      duplicateLink(1, generationIdOf(twice, '2023')),
    );
    const crossed = await convertedStore();
    edit(
      crossed,
      'course_curricula',
      crossedLink(7, {
        current: generationIdOf(crossed, '2023'),
        legacy: generationIdOf(crossed, '2018'),
      }),
    );

    await expect(refusalOf(() => projected(twice))).resolves.toMatchObject({
      message: 'Course 1 has 2 2023 curriculum links; nothing was prepared.',
    });
    await expect(refusalOf(() => projected(crossed))).resolves.toEqual({
      code: 'EXPORT_UNRESOLVED',
      message:
        'Course 7 links a 2018 curriculum entry of another generation or none; nothing was prepared.',
    });
  });
});

// A generation 2028 added in Studio: two programs (CD sorts before ab),
// an entry with a state in each, linked to course 1. Nothing is published
// unless asked.
const withGeneration = (
  store: FakeStore,
  published: { generation: boolean; programs: readonly [boolean, boolean] },
): FakeStore => {
  edit(store, 'curriculum_generations', (rows) => [
    ...rows,
    {
      code: '2028',
      has_curriculum: true,
      id: 90,
      label: 'Curriculum 2028',
      published: published.generation,
      sort: 4,
    },
  ]);
  edit(store, 'study_programs', (rows) => [
    ...rows,
    {
      code: 'ab',
      generation: 90,
      id: 91,
      name: 'AB',
      published: published.programs[0],
      sort: 2,
    },
    {
      code: 'cd',
      generation: 90,
      id: 92,
      name: 'CD',
      published: published.programs[1],
      sort: 1,
    },
  ]);
  edit(store, 'curriculum_entries', (rows) => [
    ...rows,
    {
      channel: false,
      code: 'SYN28-001',
      generation: 90,
      id: 950,
      level: 1,
      name: 'Synthetic 2028 Entry',
      prerequisites: null,
      semester: 2,
    },
  ]);
  edit(store, 'curriculum_entry_program_states', (rows) => [
    ...rows,
    { entry: 950, id: 960, program: 91, state: 'A' },
    { entry: 950, id: 961, program: 92, state: 'B' },
  ]);
  return edit(store, 'course_curricula', (rows) => [
    ...rows,
    {
      available: true,
      course: 1,
      credits: 6,
      entry: 950,
      generation: 90,
      id: 970,
      sort: 3,
    },
  ]);
};

// A public row without the keys of generation 2028.
const without2028 = (row: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(row).filter(([key]) => !key.startsWith('2028-')),
  );

const generationKeys = [
  '2028-name',
  '2028-code',
  '2028-level',
  '2028-semester',
  '2028-channel',
  '2028-prerequisite',
  '2028-state-cd',
  '2028-state-ab',
  '2028-credits',
];

describe('curriculum generations and study programs as rows', () => {
  test('reproduces the 15 state keys in the declared per-generation layouts', async () => {
    const keys = await keysOf(coursesFile);
    const states = keys.filter((key) => key.includes('-state-'));
    const block = (code: string) =>
      keys.filter(
        (key) => key.startsWith(`${code}-`) && !key.endsWith('-available'),
      );

    expect(states).toHaveLength(15);
    expect(block('2023').slice(-9)).toEqual([
      ...states.filter((key) => key.startsWith('2023-')),
      '2023-credits',
    ]);
    expect(block('2018').slice(-8)).toEqual([
      '2018-credits',
      ...states.filter((key) => key.startsWith('2018-')),
    ]);
  });

  test.each([
    [true, true],
    [false, false],
  ] as const)(
    'adds nothing while the generation is unpublished, programs published: %j',
    async (...programs) => {
      const before = await projected(await convertedStore());
      const store = withGeneration(await convertedStore(), {
        generation: false,
        programs,
      });

      expect(sameJson(await projected(store), before)).toBeTruthy();
    },
  );

  test('a published generation without published programs adds its keys but no state key', async () => {
    const before = await projected(await convertedStore());
    const store = withGeneration(await convertedStore(), {
      generation: true,
      programs: [false, false],
    });
    const keys = await keysOf(coursesFile, store);
    const { courses } = await projected(store);

    expect(keys.filter((key) => key.startsWith('2028-'))).toEqual([
      '2028-available',
      ...generationKeys.filter((key) => !key.includes('-state-')),
    ]);
    expect(courses.map(without2028)).toEqual(before.courses);
  });

  test('publishing the generation and both programs adds its availability key and block, states in program sort order, with no code change', async () => {
    const baseline = await keysOf(coursesFile);
    const store = withGeneration(await convertedStore(), {
      generation: true,
      programs: [true, true],
    });
    const keys = await keysOf(coursesFile, store);
    const { courses } = await projected(store);
    const [course] = courses;

    expect(keys).toEqual([
      ...baseline.slice(0, baseline.indexOf('2023-available')),
      '2028-available',
      ...baseline.slice(
        baseline.indexOf('2023-available'),
        baseline.indexOf('assistants') + 1,
      ),
      ...generationKeys,
      ...baseline.slice(baseline.indexOf('assistants') + 1),
    ]);
    expect(course).toMatchObject({
      '2028-available': 'TRUE',
      '2028-channel': '0',
      '2028-code': 'SYN28-001',
      '2028-credits': '6',
      '2028-level': '1',
      '2028-name': 'Synthetic 2028 Entry',
      '2028-semester': '2',
      '2028-state-ab': 'A',
      '2028-state-cd': 'B',
    });
    expect(course).not.toHaveProperty('2028-prerequisite');
  });

  test('unpublishing one program removes exactly its state key', async () => {
    const both = await projected(
      withGeneration(await convertedStore(), {
        generation: true,
        programs: [true, true],
      }),
    );
    const one = await projected(
      withGeneration(await convertedStore(), {
        generation: true,
        programs: [false, true],
      }),
    );
    const [first, ...rest] = both.courses;

    expect(one.courses).toEqual([
      Object.fromEntries(
        Object.entries(first ?? {}).filter(([key]) => key !== '2028-state-ab'),
      ),
      ...rest,
    ]);
  });
});

describe('the private data boundary', () => {
  test('never emits a private sentinel, even when every read row carries one', async () => {
    const store = await convertedStore();
    const assets = await projected(
      store,
      injecting(storeReader(store), forbiddenPrivateFields),
    );

    expect(sameJson(assets, await projected(store))).toBeTruthy();

    for (const sentinel of privateSentinels) {
      expect(JSON.stringify(assets)).not.toContain(sentinel);
    }
  });

  test('exports students as index and name only', async () => {
    const store = edit(await convertedStore(), 'students', () => [
      {
        id: 9,
        index_number: 'SYN-0003',
        name: '',
        source_group: 'SENTINEL_PRIVATE_SOURCE_GROUP:x',
      },
    ]);

    const { students } = await projected(store);

    expect(students).toEqual([{ index: 'SYN-0003' }]);
  });
});
