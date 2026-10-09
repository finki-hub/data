import { afterEach, describe, expect, test, vi } from 'vitest';

import type { PlannedCollection } from '../src/import/planned.js';
import type { WorkbookData } from '../src/schema.js';

import { dataModelCollectionKeys } from '../src/data-model/collections.js';
import { createDirectusRequest } from '../src/directus-request.js';
import { ImportInterruptedError } from '../src/import-interruption.js';
import {
  applicationCollections,
  ExistingDataError,
} from '../src/import-state.js';
import { importWorkbook } from '../src/import-workbook.js';
import { planImport } from '../src/import/plan.js';
import {
  config,
  emptyData,
  emptyWorkbook,
  toUrl,
} from './directus-test-helpers.js';
import {
  academicYears,
  courseNames,
  makeSyntheticDataset,
} from './fixtures/synthetic-data.js';
import { planOf } from './import-plan-helpers.js';
import {
  emptyStore,
  fakeImportDirectus,
  type ImportFake,
} from './import-test-helpers.js';
import { parityDataset } from './relational-export-helpers.js';
import {
  type FakeItem,
  type FakeStore,
  type RecordedCall,
} from './store-test-helpers.js';

// The relational rows the import writes for the parity dataset.
const planned = (): readonly PlannedCollection[] =>
  planOf(parityDataset()).collections;

const isItemWrite = ({ method, pathname }: RecordedCall): boolean =>
  method === 'POST' && pathname.startsWith('/items/');

const rowsIn = (store: FakeStore, collection: string): readonly FakeItem[] =>
  store.items.get(collection) ?? [];

// The rows of a collection restricted to `keys`, an absent column as null.
const projected = (
  store: FakeStore,
  collection: string,
  keys: readonly string[],
) =>
  rowsIn(store, collection).map((row) =>
    Object.fromEntries(keys.map((key) => [key, row[key] ?? null])),
  );

// A setup-created, empty project: every model collection exists with no
// records, beside the coordination singleton row.
const installedStore = (): FakeStore => {
  const store = emptyStore();
  for (const collection of dataModelCollectionKeys) {
    store.items.set(
      collection,
      collection === 'data_operations' ? [{ id: 1 }] : [],
    );
  }
  return store;
};

const importInto = (
  fake: ImportFake,
  collections: readonly PlannedCollection[] = planned(),
) => importWorkbook(fake.request, collections, fake.io);

// The fake's request, except that the `nth` POST whose path starts with
// `prefix` rejects as an outage would.
const failingAt = (
  fake: ImportFake,
  prefix: string,
  nth: number,
): ImportFake['request'] => {
  let seen = 0;
  return (pathname, init) => {
    if (init?.method === 'POST' && pathname.startsWith(prefix)) {
      seen += 1;
      if (seen === nth) {
        return Promise.reject(new Error('synthetic outage'));
      }
    }
    return fake.request(pathname, init);
  };
};

const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

// The collection a POST wrote, in the order the import sent them.
const writtenOrder = (calls: readonly RecordedCall[]): readonly string[] => [
  ...new Set(
    calls
      .filter(isItemWrite)
      .map(
        ({ pathname }) =>
          pathname.slice('/items/'.length).split('?', 1)[0] ?? pathname,
      ),
  ),
];

const plannedTotal = (collections: readonly PlannedCollection[]): number =>
  collections.reduce((sum, { rows }) => sum + rows.length, 0);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the one-time workbook import', () => {
  test('imports into a fresh project: setup first, then the relational rows in dependency order; it writes and runs no Flow', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const collections = planned();

    const summary = await importInto(fake, collections);

    expect(fake.setups()).toBe(1);
    expect(summary.rows).toEqual(
      Object.fromEntries(
        collections.map(({ collection, rows }) => [collection, rows.length]),
      ),
    );
    expect(writtenOrder(fake.calls)).toEqual(
      collections
        .filter(({ rows }) => rows.length > 0)
        .map(({ collection }) => collection),
    );
    expect(summary.rows).toMatchObject({
      course_curricula: 12,
      courses: 8,
      curriculum_generations: 3,
      moodle_pattern_mappings: 10,
      student_council: 4,
      study_programs: 15,
    });
    expect(
      fake
        .mutations()
        .filter(
          ({ pathname }) =>
            pathname.startsWith('/flows') || pathname.startsWith('/operations'),
        ),
    ).toEqual([]);
  });

  test('writes every reference as the id Directus gave the row it names, whatever ids the tables hand out', async () => {
    const fake = fakeImportDirectus({ items: new Map(), sequenceStart: 500 });

    await importInto(fake);

    const courses = new Map(
      rowsIn(fake.store, 'courses').map((row) => [row.id, row['name']]),
    );
    const entries = new Map(
      rowsIn(fake.store, 'curriculum_entries').map((row) => [
        row.id,
        row['name'],
      ]),
    );
    const alpha = rowsIn(fake.store, 'course_curricula').filter(
      (link) => courses.get(Number(link['course'])) === courseNames.alpha,
    );

    expect(Math.min(...courses.keys().map(Number))).toBe(500);
    expect(alpha.map((link) => entries.get(Number(link['entry'])))).toEqual([
      'Alpha Course (2023)',
      'Alpha Legacy',
    ]);
    expect(
      rowsIn(fake.store, 'teaching_assignments').every((row) =>
        courses.has(Number(row['course'])),
      ),
    ).toBeTruthy();

    // Every staff link names a staff row by the id Directus gave it.
    const staff = new Set(rowsIn(fake.store, 'staff').map(({ id }) => id));
    const links = rowsIn(fake.store, 'teaching_assignments');

    expect(links).toHaveLength(11);
    expect(links.filter((row) => !staff.has(Number(row['staff'])))).toEqual([]);
  });

  test('accepts the empty schema setup creates, coordination singleton included', async () => {
    const fake = fakeImportDirectus(installedStore());

    await expect(importInto(fake)).resolves.toMatchObject({
      rows: { courses: 8 },
    });
    expect(applicationCollections).not.toContain('data_operations');
  });

  test('refuses a populated project before its first write, naming the exact record counts', async () => {
    const store = emptyStore();
    const base = makeSyntheticDataset();
    store.items.set(
      'courses',
      base.courses.slice(0, 2).map((row) => ({ ...row })),
    );
    store.items.set(
      'staff',
      base.staff.slice(0, 1).map((row) => ({ ...row })),
    );
    store.items.set('rooms', []);
    const fake = fakeImportDirectus(store);

    const error = await refusalOf(importInto(fake));

    expect(error).toBeInstanceOf(ExistingDataError);
    expect(error).toMatchObject({ counts: { courses: 2, staff: 1 } });
    expect(String(error)).toBe(
      'ExistingDataError: project not empty: 3 records in 2 collections (courses 2, staff 1)',
    );
    expect(String(error)).not.toContain('migrate');
    expect(fake.mutations()).toEqual([]);
    expect(fake.setups()).toBe(0);
  });

  test('refuses records in relational collections too', async () => {
    const store = installedStore();
    store.items.set('curriculum_entries', [{ id: 7 }]);
    const fake = fakeImportDirectus(store);

    await expect(importInto(fake)).rejects.toMatchObject({
      counts: { curriculum_entries: 1 },
    });
    expect(fake.mutations()).toEqual([]);
  });
});

describe('an import interrupted after it began writing', () => {
  test('reports the rows Directus confirmed; a rerun is then refused', async () => {
    const fake = fakeImportDirectus(emptyStore(), { batchSize: 2 });
    const failing = failingAt(fake, '/items/courses', 2);
    const collections = planned();

    const error = await refusalOf(
      importWorkbook(failing, collections, fake.io),
    );
    const before = collections.slice(
      0,
      collections.findIndex(({ collection }) => collection === 'courses'),
    );
    const confirmed = plannedTotal(before) + 2;

    expect(error).toBeInstanceOf(ImportInterruptedError);
    expect(error).toMatchObject({
      progress: { confirmed, total: plannedTotal(collections) },
    });
    expect(String(error)).toBe(
      `ImportInterruptedError: synthetic outage (rows confirmed: ${String(confirmed)}/${String(plannedTotal(collections))})`,
    );
    expect(String(error)).not.toContain('migrate');
    expect(rowsIn(fake.store, 'courses')).toHaveLength(2);
    await expect(importInto(fake)).rejects.toBeInstanceOf(ExistingDataError);
  });

  test('counts no row when the first batch fails, and a rerun is then accepted', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const failing = failingAt(fake, '/items/academic_years', 1);

    const error = await refusalOf(importWorkbook(failing, planned(), fake.io));

    expect(error).toMatchObject({ progress: { confirmed: 0 } });
    expect(
      applicationCollections.filter(
        (collection) => rowsIn(fake.store, collection).length > 0,
      ),
    ).toEqual([]);
    await expect(importInto(fake)).resolves.toMatchObject({
      rows: { courses: 8 },
    });
  });
});

describe('the rows the import writes', () => {
  test('batches large private imports below the request payload limit', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const data: WorkbookData = {
      ...emptyData,
      moodle_users: Array.from({ length: 501 }, (_, moodleId) => ({
        ID_new: moodleId,
        Name: `Synthetic Moodle User ${String(moodleId)}`,
      })),
    };

    await importInto(fake, planImport({ ...emptyWorkbook, data }).collections);

    expect(
      fake.calls.filter(
        ({ method, pathname }) =>
          method === 'POST' && pathname === '/items/moodle_users?fields=id',
      ),
    ).toHaveLength(3);
    expect(rowsIn(fake.store, 'moodle_users')).toHaveLength(501);
  });

  test('seeds the academic years the workbook names, a later one included, which needs no mapping of its own', async () => {
    const years = ['2026/2027', ...academicYears];
    const fake = fakeImportDirectus(emptyStore());

    await importInto(fake, planOf(parityDataset(), years).collections);

    expect(
      projected(fake.store, 'academic_years', ['label', 'published', 'sort']),
    ).toEqual(
      years.map((label, index) => ({
        label,
        published: true,
        sort: years.length - index,
      })),
    );
    // The all-years mappings count the later year too.
    expect(rowsIn(fake.store, 'moodle_pattern_mappings')).toHaveLength(
      planned().find(
        ({ collection }) => collection === 'moodle_pattern_mappings',
      )?.rows.length ?? 0,
    );
    expect(
      projected(fake.store, 'curriculum_generations', [
        'code',
        'has_curriculum',
        'published',
      ]),
    ).toEqual([
      { code: '2013', has_curriculum: false, published: false },
      { code: '2018', has_curriculum: true, published: true },
      { code: '2023', has_curriculum: true, published: true },
    ]);
  });
});

describe('the import over the real request', () => {
  test('refuses a populated project through fetch before any write', async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        methods.push(init?.method ?? 'GET');
        const url = toUrl(input);
        if (url.pathname === '/collections') {
          return Response.json({
            data: [{ collection: 'courses', schema: { name: 'courses' } }],
          });
        }
        return Response.json({ data: [{ count: '2' }] });
      }),
    );

    await expect(
      importWorkbook(createDirectusRequest(config), [], {}),
    ).rejects.toThrow(
      'project not empty: 2 records in 1 collection (courses 2)',
    );
    expect(methods.every((method) => method === 'GET')).toBeTruthy();
  });
});
