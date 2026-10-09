import { describe, expect, test } from 'vitest';

import { defaultYearPattern } from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { findModelCollection } from '../src/data-model/collections.js';
import { planned, type PlannedCollection, ref } from '../src/import/planned.js';
import { publicRows } from '../src/live-check/fetch.js';
import { projectedCounts } from '../src/projection/counts.js';
import { storeReader } from '../src/projection/memory-reader.js';
import {
  type MemoryRow,
  memoryStore,
  type MemoryStore,
  storedRow,
  withRows,
} from '../src/projection/memory-store.js';
import { asData, expectedData } from './expected-exports.js';
import { planOf } from './import-plan-helpers.js';
import {
  engineAssets,
  importedStore,
  parityDataset,
} from './relational-export-helpers.js';

const rowsIn = (store: MemoryStore, collection: string) =>
  store.items.get(collection) ?? [];

// A plan of three collections: two generations, one course and the
// course's link to the second generation.
const generations: PlannedCollection = {
  collection: 'curriculum_generations',
  rows: [
    planned('2018', { code: '2018', label: 'Curriculum 2018' }),
    planned('2023', { code: '2023', label: 'Curriculum 2023' }),
  ],
};
const courses: PlannedCollection = {
  collection: 'courses',
  rows: [planned(7, { name: 'Synthetic Course' })],
};
const links: PlannedCollection = {
  collection: 'course_curricula',
  rows: [
    planned('7/2023', {
      course: ref('courses', 7),
      generation: ref('curriculum_generations', '2023'),
    }),
  ],
};
const smallPlan = [generations, courses, links];

describe('the memory store of an import plan', () => {
  test('numbers each collection from 1 in plan order', () => {
    const store = memoryStore(smallPlan);

    expect(rowsIn(store, 'curriculum_generations').map(({ id }) => id)).toEqual(
      [1, 2],
    );
    expect(rowsIn(store, 'courses').map(({ id }) => id)).toEqual([1]);
    expect(rowsIn(store, 'course_curricula').map(({ id }) => id)).toEqual([1]);
  });

  test('replaces every reference by the id of the row it names', () => {
    const [link] = rowsIn(memoryStore(smallPlan), 'course_curricula');

    expect(link).toMatchObject({ course: 1, generation: 2 });
  });

  test('fills every model column the plan leaves out with its default, or null', () => {
    const store = memoryStore(smallPlan);
    const [generation] = rowsIn(store, 'curriculum_generations');
    const [link] = rowsIn(store, 'course_curricula');

    expect(generation).toMatchObject({
      has_curriculum: false,
      published: false,
    });
    expect(link).toMatchObject({ available: true, credits: null, entry: null });

    for (const { collection } of smallPlan) {
      const fields = findModelCollection(collection)?.fields ?? [];
      for (const row of rowsIn(store, collection)) {
        expect(new Set(Object.keys(row))).toEqual(
          new Set([...fields.map(({ field }) => field), 'id']),
        );
      }
    }
  });

  test('refuses a reference to a row the plan creates later, and a repeated key', () => {
    expect(() => memoryStore([links, generations, courses])).toThrow(
      'plan: course_curricula.course references courses 7 before it is created',
    );
    expect(() =>
      memoryStore([
        { ...generations, rows: [...generations.rows, ...generations.rows] },
      ]),
    ).toThrow('plan: duplicate curriculum_generations key 2018');
  });

  test('holds what the import writes into an empty project, row for row', async () => {
    const plan = planOf(parityDataset());
    const store = memoryStore(plan.collections);
    const imported = await importedStore();

    const collections = plan.collections.map(({ collection }) => collection);

    expect(
      Object.fromEntries(
        collections.map((name) => [name, rowsIn(store, name)]),
      ),
    ).toEqual(
      Object.fromEntries(
        collections.map((name) => [name, imported.items.get(name)]),
      ),
    );
  });

  test('publishes the parity files, counting by the planned pattern mappings line by line', async () => {
    const plan = planOf(parityDataset());
    const store = memoryStore(plan.collections);
    const counts = projectedCounts(store);
    const files = await engineAssets(
      exportDefinitions,
      storeReader(withRows(store, 'course_enrollments', counts.rows)),
    );
    const expected = await expectedData('parity');
    const published = (name: 'courses' | 'rooms' | 'staff') =>
      asData(name, publicRows.parse(files[name]));

    expect(published('courses')).toEqual(expected.courses);
    expect(published('staff')).toEqual(expected.staff);
    expect(published('rooms')).toEqual(expected.rooms);
  });
});

// One course, two published years and an unpublished one, three users,
// and the course's mappings: its standard all-years mapping, and an
// only-in-year mapping that replaces it in 2024/2025.
const seamStore = (): MemoryStore => ({
  items: new Map<string, readonly MemoryRow[]>([
    [
      'academic_years',
      [
        ['2025/2026', true],
        ['2024/2025', true],
        ['2023/2024', false],
      ].map(([label, published], index) =>
        storedRow('academic_years', { label, published }, index + 1),
      ),
    ],
    ['courses', [storedRow('courses', { name: 'Seam Course' }, 4)]],
    [
      'moodle_pattern_mappings',
      [
        storedRow(
          'moodle_pattern_mappings',
          {
            course: 4,
            only_in_year: null,
            pattern: 'Seam Course-',
            year_pattern: defaultYearPattern,
          },
          1,
        ),
        storedRow(
          'moodle_pattern_mappings',
          {
            course: 4,
            only_in_year: 2,
            pattern: 'Seam Lab',
            year_pattern: null,
          },
          2,
        ),
      ],
    ],
    [
      'moodle_users',
      [
        'Seam Course-2025/2026/Z\nSeam Course-2023/2024/Z',
        'Seam Course-2025/2026/L\r\nSeam Course-2024/2025/Z',
        'Seam Lab 2024\nSeam Course-2025/2026/Z',
      ].map((Courses, index) =>
        storedRow('moodle_users', { Courses }, index + 1),
      ),
    ],
  ]),
});

describe('the count seam', () => {
  test('counts the distinct users of the lines the mappings count, per course and published academic year', () => {
    const counts = projectedCounts(seamStore());

    expect(counts.derived).toBeTruthy();
    expect(
      counts.rows.map(({ academic_year, count, course, id }) => ({
        academic_year,
        count,
        course,
        id,
      })),
    ).toEqual([
      { academic_year: 1, count: 3, course: 4, id: 1 },
      { academic_year: 2, count: 1, course: 4, id: 2 },
    ]);
    expect(counts.rows[0]).toMatchObject({
      computed_at: null,
      computed_revision: null,
    });
  });

  test('counts every course in every published academic year of an import plan', () => {
    const plan = planOf(parityDataset());
    const store = memoryStore(plan.collections);
    const years = rowsIn(store, 'academic_years');
    const counts = projectedCounts(
      withRows(
        store,
        'academic_years',
        years.map((year, index) =>
          index === 0 ? { ...year, published: false } : year,
        ),
      ),
    );

    expect(counts.rows).toHaveLength(
      rowsIn(store, 'courses').length * (years.length - 1),
    );
    expect(
      new Set(counts.rows.map(({ academic_year }) => academic_year)),
    ).toEqual(new Set(years.slice(1).map(({ id }) => id)));
    expect(new Set(counts.rows.map(({ id }) => id)).size).toBe(
      counts.rows.length,
    );
  });
});
