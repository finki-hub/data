import { describe, expect, test } from 'vitest';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { findModelCollection } from '../src/data-model/collections.js';
import { planned, type PlannedCollection, ref } from '../src/import/planned.js';
import { publicRows } from '../src/live-check/fetch.js';
import { projectedCounts } from '../src/projection/counts.js';
import { storeReader } from '../src/projection/memory-reader.js';
import {
  memoryStore,
  type MemoryStore,
  withRows,
} from '../src/projection/memory-store.js';
import { isYearLabel } from '../src/workbook-enrollment-reader.js';
import { asData, expectedData, type PublicRow } from './expected-exports.js';
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

const withoutYearKeys = (rows: readonly PublicRow[]) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !isYearLabel(key)),
    ),
  );

// Every year value of the rows.
const yearValues = (rows: readonly PublicRow[]) =>
  rows
    .flatMap((row) => Object.entries(row))
    .filter(([key]) => isYearLabel(key))
    .map(([, value]) => value);

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
      sort: null,
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

  test('publishes the parity files apart from the counts, which are 0', async () => {
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

    expect(withoutYearKeys(published('courses'))).toEqual(
      withoutYearKeys(expected.courses),
    );
    expect(new Set(yearValues(published('courses')))).toEqual(new Set(['0']));
    expect(yearValues(published('courses'))).toHaveLength(
      yearValues(expected.courses).length,
    );
    expect(published('staff')).toEqual(expected.staff);
    expect(published('rooms')).toEqual(expected.rooms);
  });
});

describe('the count seam', () => {
  test('counts 0 for every course in every published academic year, not derived', () => {
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
    const courseRows = rowsIn(store, 'courses');

    expect(counts.derived).toBe(false);
    expect(counts.rows).toHaveLength(courseRows.length * (years.length - 1));
    expect(new Set(counts.rows.map(({ count }) => count))).toEqual(
      new Set([0]),
    );
    expect(
      new Set(counts.rows.map(({ academic_year }) => academic_year)),
    ).toEqual(new Set(years.slice(1).map(({ id }) => id)));
    expect(new Set(counts.rows.map(({ id }) => id)).size).toBe(
      counts.rows.length,
    );
    expect(counts.rows[0]).toMatchObject({
      computed_at: null,
      computed_revision: null,
    });
  });
});
