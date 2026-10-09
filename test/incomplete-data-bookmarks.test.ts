import { describe, expect, test } from 'vitest';

import type { PlannedCollection } from '../src/import/planned.js';
import type { FakeStore, RecordedCall } from './store-test-helpers.js';

import { exportDefinitions } from '../directus/extensions/directus-extension-data-operations/src/exports/index.js';
import { readinessAction } from '../directus/extensions/directus-extension-data-operations/src/exports/prepare.js';
import { ImportInterruptedError } from '../src/import-interruption.js';
import { importWorkbook } from '../src/import-workbook.js';
import {
  createIncompleteDataBookmarks,
  incompleteDataPresets,
} from '../src/import/incomplete-data-bookmarks.js';
import { storeReader } from '../src/projection/memory-reader.js';
import { planOf } from './import-plan-helpers.js';
import {
  emptyStore,
  fakeImportDirectus,
  type FakePreset,
  type ImportFake,
} from './import-test-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

// The incomplete-data bookmarks the one-time import creates once its rows
// are written: only the views that list a row, never one a global preset
// of the same collection and name already holds.

const planned = (): readonly PlannedCollection[] =>
  planOf(parityDataset()).collections;

const plannedTotal = (collections: readonly PlannedCollection[]): number =>
  collections.reduce((sum, { rows }) => sum + rows.length, 0);

const importInto = (fake: ImportFake) =>
  importWorkbook(fake.request, planned(), fake.io);

const isItemWrite = ({ method, pathname }: RecordedCall): boolean =>
  method === 'POST' && pathname.startsWith('/items/');

const isPresetWrite = ({ method, pathname }: RecordedCall): boolean =>
  method === 'POST' && pathname === '/presets';

// The parity fixture keeps an equivalency without a course, an
// equivalency label without an entry and a council member without a
// student, in registry order.
const fixtureBookmarks = [
  'Equivalencies without a course',
  'Equivalency labels without an entry',
  'Council members without a student',
];

const readiness = (store: FakeStore) =>
  readinessAction(exportDefinitions, {
    coordination: () =>
      Promise.resolve({
        calculation: 'graph-a',
        domains: { enrollments: 'current', history_index: 'current' },
        revision: 7,
      }),
    reader: storeReader(store),
    snapshot: () =>
      Promise.resolve({
        activeMatchesPromotion: true,
        activeRows: 9,
        state: 'completed',
      }),
  });

const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};

// The link each view finds empty: an equivalency's course, a member's
// entry, a council member's student.
const gapLinks = {
  course_equivalencies: 'course',
  course_equivalency_members: 'entry',
  student_council: 'student',
} as const;

type Gap = keyof typeof gapLinks;

const everyGap: readonly Gap[] = [
  'course_equivalencies',
  'course_equivalency_members',
  'student_council',
];

// The store with the given gaps filled: every row of each collection
// linked, so its view lists nothing.
const filled = (store: FakeStore, gaps: readonly Gap[]): FakeStore => {
  for (const collection of gaps) {
    const field = gapLinks[collection];
    store.items.set(
      collection,
      (store.items.get(collection) ?? []).map((row) => ({
        ...row,
        [field]: 1,
      })),
    );
  }
  return store;
};

const isFirstRowRead = ({ method, pathname }: RecordedCall): boolean =>
  method === 'GET' && pathname.includes('?fields=id&limit=1&filter=');

describe('the incomplete-data bookmarks of the import', () => {
  test('are created after the last item write for exactly the views that list a row, named as readiness names them', async () => {
    const fake = fakeImportDirectus(emptyStore());

    const summary = await importInto(fake);

    expect(summary.bookmarks).toEqual(fixtureBookmarks);
    expect(fake.presets).toEqual(incompleteDataPresets());
    expect(fake.calls.findIndex(isPresetWrite)).toBeGreaterThan(
      fake.calls.findLastIndex(isItemWrite),
    );
    expect(fake.calls.filter(isPresetWrite)).toHaveLength(3);

    const answer = await readiness(fake.store);

    expect(summary.bookmarks).toEqual(Object.values(answer.reviews));
  });

  test('are not created when no view lists a row', async () => {
    const imported = fakeImportDirectus(emptyStore());
    await importInto(imported);
    const fake = fakeImportDirectus(filled(imported.store, everyGap));

    await expect(createIncompleteDataBookmarks(fake.request)).resolves.toEqual(
      [],
    );
    expect(fake.mutations()).toEqual([]);
    expect(fake.calls.filter(isFirstRowRead)).toHaveLength(
      incompleteDataPresets().length,
    );
  });

  // The first shape is the real export's.
  test.each([
    {
      created: ['Equivalencies without a course'],
      gaps: ['course_equivalency_members', 'student_council'] as const,
      shape: 'only equivalencies without a course',
    },
    {
      created: [
        'Equivalencies without a course',
        'Council members without a student',
      ],
      gaps: ['course_equivalency_members'] as const,
      shape: 'every member with an entry',
    },
  ])(
    'are created only for the views that still list a row ($shape)',
    async ({ created, gaps }) => {
      const imported = fakeImportDirectus(emptyStore());
      await importInto(imported);
      const fake = fakeImportDirectus(filled(imported.store, gaps));

      await expect(
        createIncompleteDataBookmarks(fake.request),
      ).resolves.toEqual(created);
      expect(fake.presets).toEqual(
        incompleteDataPresets().filter(({ bookmark }) =>
          created.includes(bookmark),
        ),
      );
      expect(fake.calls.filter(isPresetWrite)).toHaveLength(created.length);
      expect(fake.calls.filter(isFirstRowRead)).toHaveLength(
        incompleteDataPresets().length,
      );
    },
  );

  test('keep an existing global preset of a name, while a personal one does not count', async () => {
    const edited: FakePreset = {
      bookmark: 'Equivalencies without a course',
      collection: 'course_equivalencies',
      icon: 'edited_in_studio',
      role: null,
      user: null,
    };
    const personal: FakePreset = {
      bookmark: 'Council members without a student',
      collection: 'student_council',
      role: null,
      user: 'synthetic-user',
    };
    const fake = fakeImportDirectus(emptyStore(), {
      presets: [edited, personal],
    });

    const summary = await importInto(fake);

    expect(summary.bookmarks).toEqual([
      'Equivalency labels without an entry',
      'Council members without a student',
    ]);
    expect(
      fake.presets.filter(({ bookmark }) => bookmark === edited.bookmark),
    ).toEqual([edited]);
    expect(
      fake.presets.filter(({ bookmark }) => bookmark === personal.bookmark),
    ).toEqual([personal, expect.objectContaining({ role: null, user: null })]);
  });

  test('interrupt the import with every row confirmed when a bookmark write fails', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const collections = planned();
    const total = String(plannedTotal(collections));

    const error = await refusalOf(
      importWorkbook(
        (pathname, init) =>
          init?.method === 'POST' && pathname === '/presets'
            ? Promise.reject(new Error('synthetic outage'))
            : fake.request(pathname, init),
        collections,
        fake.io,
      ),
    );

    expect(error).toBeInstanceOf(ImportInterruptedError);
    expect(String(error)).toBe(
      `ImportInterruptedError: synthetic outage (rows confirmed: ${total}/${total})`,
    );
    expect(fake.presets).toEqual([]);
  });
});
