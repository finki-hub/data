import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { FakeItem } from './migration-test-helpers.js';

import { exportedYears } from '../directus/extensions/directus-extension-data-operations/src/exports/courses.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { readinessAction } from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import { academicYears } from '../src/specs/public.js';
import {
  courseNames,
  forbiddenPrivateFields,
  makeSyntheticDataset,
  privateSentinels,
} from './fixtures/synthetic-data.js';
import { lifecycleDataset } from './fixtures/synthetic-workbook.js';
import {
  convertedStore,
  derivedLegacyAssets,
  edit,
  engineAssets,
  injecting,
  legacyAssets,
  parityDataset,
  referenceConstants,
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

const courseNamed = (assets: Assets, name: string) =>
  assets.courses.find((row) => row['name'] === name);

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

const fieldMap = z.array(z.tuple([z.string(), z.string()]));
const referenceMaps = z
  .object({
    courseFields: fieldMap,
    roomFields: fieldMap,
    staffFields: fieldMap,
    studentFields: fieldMap,
  })
  .parse(
    referenceConstants([
      'courseFields',
      'roomFields',
      'staffFields',
      'studentFields',
    ]),
  );

const keysOf = (filename: string) =>
  exportDefinitions
    .find((definition) => definition.filename === filename)
    ?.fields.map(({ key }) => key);

const labelsOf = (map: ReadonlyArray<readonly [string, string]>) =>
  map.map(([, label]) => label);

const numericKeys = (definition: (typeof exportDefinitions)[number]) =>
  definition.fields
    .filter(({ rule }) => rule === 'numeric_boolean')
    .map(({ key }) => key);

// A count row of the year for every course of the store.
const countsOf = (courses: readonly FakeItem[], year: number): FakeItem[] =>
  courses.map((course, index) => ({
    academic_year: year,
    count: 7,
    course: course.id,
    id: 900 + index,
  }));

const isLink = (row: FakeItem, course: number, generation: string) =>
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
  (course: number, generation: string) =>
  (rows: FakeItem[]): FakeItem[] => [
    ...rows,
    ...rows
      .filter((row) => isLink(row, course, generation))
      .map((row) => ({ ...row, id: 900 })),
  ];

// The course's 2018 link pointed at its 2023 entry.
const crossedLink =
  (course: number) =>
  (rows: FakeItem[]): FakeItem[] => {
    const current = rows.find((row) => isLink(row, course, '2023'));
    return rows.map((row) =>
      isLink(row, course, '2018') ? { ...row, entry: current?.['entry'] } : row,
    );
  };

describe('parity with the legacy serializer', () => {
  test('projects the converted fixture into exactly the files the legacy serializer publishes', async () => {
    const dataset = parityDataset();
    const assets = await projected(await convertedStore(dataset));
    const expected = legacyAssets(dataset);

    expect(assets).toEqual(expected);
    expect(sameJson(assets, expected)).toBeTruthy();
    // The oracle covers the value rules: false, zero, empty and null.
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

  test('declares exactly the keys of the reference serializer, in its order', () => {
    expect(exportDefinitions.map(({ filename }) => filename)).toEqual([
      'courses.json',
      'rooms.json',
      'staff.json',
      'students.json',
    ]);
    expect(keysOf('courses.json')).toEqual(
      labelsOf(referenceMaps.courseFields),
    );
    expect(keysOf('rooms.json')).toEqual(labelsOf(referenceMaps.roomFields));
    expect(keysOf('staff.json')).toEqual(labelsOf(referenceMaps.staffFields));
    expect(keysOf('students.json')).toEqual(
      labelsOf(referenceMaps.studentFields),
    );
  });

  test('publishes "1"/"0" exactly where the reference does', () => {
    // numericBooleans holds active, channel_2018 and channel_2023.
    const numeric = exportDefinitions.flatMap(numericKeys);

    expect(numeric).toEqual(['2023-channel', '2018-channel', 'active']);
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

describe('every difference from the legacy files blocks readiness', () => {
  test('the unresolved lifecycle fixture differs only at its two review items, each a blocker until resolved', async () => {
    const dataset = lifecycleDataset();
    const store = await convertedStore(dataset);
    const assets = await projected(store);
    const expected = legacyAssets(dataset);

    // The duplicate assignment row publishes its labels too, and a 2018
    // availability without a 2018 curriculum has no link to live on.
    expect(courseNamed(assets, courseNames.alpha)?.['professors']).toBe(
      'Prof. Zed Alpha, Prof. Later Alpha, Prof. Abe Alpha',
    );
    expect(courseNamed(expected, courseNames.alpha)?.['professors']).toBe(
      'Prof. Zed Alpha, Prof. Abe Alpha',
    );
    expect(courseNamed(assets, courseNames.gamma)).not.toHaveProperty(
      '2018-available',
    );
    expect(courseNamed(expected, courseNames.gamma)).toHaveProperty(
      '2018-available',
      'FALSE',
    );
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
    expect(
      sameJson(await projected(store), legacyAssets(parityDataset())),
    ).toBeTruthy();
  });

  test('re-derives the legacy files of the parity fixture unchanged', async () => {
    const dataset = parityDataset();

    expect(
      sameJson(await derivedLegacyAssets(dataset), legacyAssets(dataset)),
    ).toBeTruthy();
  });

  test.each([
    {
      change: renamedCurrent,
      generation: '2023',
      label: 'a 2023 name',
      name: courseNames.iota,
    },
    {
      change: unmatchedLegacy,
      generation: '2018',
      label: 'an equivalency 2018 label',
      name: courseNames.zeta,
    },
  ] as const)(
    '$label that matched no entry blocks until an editor links the label, then publishes exactly the legacy file',
    async ({ change, generation, name }) => {
      const dataset = change(parityDataset());
      const store = await convertedStore(dataset);
      const expected = await derivedLegacyAssets(dataset);
      const course = rowsOf(store, 'courses').find(
        (row) => row['name'] === name,
      );

      expect(courseNamed(expected, name)).toHaveProperty(
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
      expect(sameJson(await projected(store), expected)).toBeTruthy();
    },
  );

  test.each([
    'Prof. Zed Alpha, Prof. Abe Alpha',
    'Prof. Zed Alpha; Prof. Abe Alpha',
    'Prof. Zed Alpha;Prof. Abe Alpha',
    'Prof. Zed Alpha\nProf. Abe Alpha',
    'Prof. Zed Alpha,Prof. Abe Alpha',
    'Prof. Zed Alpha ,  Prof. Abe Alpha',
    ' Prof. Zed Alpha, Prof. Abe Alpha',
    'Prof. Zed Alpha ',
  ])(
    'republishes the assignment text %j exactly although every part names a staff row',
    async (text) => {
      const base = parityDataset();
      const dataset = {
        ...base,
        teaching_assignments: base.teaching_assignments.map((row) =>
          row.id === 1 ? { ...row, professors: text } : row,
        ),
      };
      const store = await convertedStore(dataset);

      expect(
        sameJson(await projected(store), await derivedLegacyAssets(dataset)),
      ).toBeTruthy();
      await expect(readinessOf(store)).resolves.toMatchObject({ ready: true });
    },
  );
});

describe('year configuration', () => {
  test('lists the fifteen public years in the courses definition', () => {
    expect([...exportedYears]).toEqual([...academicYears]);
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

  test('publishes the 2018 name override before the linked entry name, with or without a link', async () => {
    const override = 'name_2018_override';
    const store = edit(
      await convertedStore(),
      'courses',
      setOnCourse(courseNames.gamma, override, 'Gamma Legacy Label'),
    );
    edit(
      store,
      'courses',
      setOnCourse(courseNames.beta, override, 'Beta Override Label'),
    );
    const assets = await projected(store);

    expect(courseNamed(assets, courseNames.beta)).toMatchObject({
      '2018-code': 'SYN18-002-MANUAL',
      '2018-name': 'Beta Override Label',
    });

    const gamma = Object.keys(courseNamed(assets, courseNames.gamma) ?? {});

    expect(gamma.filter((key) => key.startsWith('2018-'))).toEqual([
      '2018-name',
    ]);
  });

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
    const twice = edit(
      await convertedStore(),
      'course_curricula',
      duplicateLink(1, '2023'),
    );
    const crossed = edit(
      await convertedStore(),
      'course_curricula',
      crossedLink(7),
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
