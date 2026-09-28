import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import type { MigrationData } from '../src/schema.js';
import type { WorkbookContent } from '../src/workbook.js';

import { dataModelCollectionKeys } from '../src/data-model/collections.js';
import { createDirectusRequest } from '../src/directus-request.js';
import { importWorkbook } from '../src/directus.js';
import { ImportInterruptedError } from '../src/import-interruption.js';
import {
  applicationCollections,
  ExistingDataError,
} from '../src/import-state.js';
import { runConversion } from '../src/migrations/conversion.js';
import { readInventory } from '../src/migrations/inventory.js';
import { ledgerCollection } from '../src/migrations/ledger-claim.js';
import { preflight } from '../src/migrations/preflight.js';
import { academicYears } from '../src/specs/public.js';
import {
  config,
  emptyData,
  emptyWorkbook,
  toUrl,
} from './directus-test-helpers.js';
import { makeSyntheticDataset } from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  withSequentialIds,
  workbookContent,
} from './fixtures/synthetic-workbook.js';
import {
  emptyStore,
  fakeImportDirectus,
  type ImportFake,
} from './import-test-helpers.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  type RecordedCall,
  storeFromDataset,
} from './migration-test-helpers.js';

const stepNames = [
  'preflight',
  'curricula',
  'rules',
  'assignments',
  'council',
  'equivalencies',
];
const targetCollections = [
  'academic_years',
  'course_curricula',
  'course_enrollment_rules',
  'curriculum_entries',
];
const ledgerRow = z.looseObject({ status: z.string(), step: z.string() });

const workbook = (): WorkbookContent => workbookContent(lifecycleDataset());

const isItemWrite = ({ method, pathname }: RecordedCall): boolean =>
  method === 'POST' && pathname.startsWith('/items/');

const firstIndex = (
  calls: readonly RecordedCall[],
  predicate: (call: RecordedCall) => boolean,
): number => calls.findIndex(predicate);

const rowsIn = (store: FakeStore, collection: string) =>
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

const importInto = (fake: ImportFake, content: WorkbookContent = workbook()) =>
  importWorkbook(fake.request, content, fake.io);

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

// The lifecycle dataset with a second student under a council member's
// index: an ambiguity that blocks the relational conversion.
const duplicateIndex = () => {
  const base = lifecycleDataset();
  return {
    ...base,
    students: [
      ...base.students,
      {
        id: 99,
        index_number: 'SYN-0001',
        name: 'Synthetic Student One (Other List)',
        source_group: 'synthetic:other-list',
      },
    ],
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lifecycle states of the workbook import', () => {
  test('imports into a fresh project: setup first, then the rows and the ledger; it writes and runs no Flow', async () => {
    const fake = fakeImportDirectus(emptyStore());

    const summary = await importInto(fake);

    expect(fake.setups()).toBe(1);
    expect(summary.rows).toEqual({
      course_enrollment_patterns: 4,
      course_equivalencies: 9,
      courses: 8,
      curriculum_2018: 9,
      curriculum_2023: 9,
      deans_office: 2,
      discord_channels: 2,
      moodle_users: 9,
      rooms: 3,
      staff: 7,
      student_council: 4,
      students: 3,
      teaching_assignments: 8,
    });
    expect(summary.conversion).toMatchObject({
      status: 'converted',
      steps: { completed: stepNames, skipped: [] },
    });
    expect(
      rowsIn(fake.store, ledgerCollection).map((row) => ledgerRow.parse(row)),
    ).toMatchObject(stepNames.map((step) => ({ status: 'completed', step })));

    const firstWrite = firstIndex(fake.calls, isItemWrite);
    const ledgerAt = firstIndex(
      fake.calls,
      ({ method, pathname }) =>
        method === 'POST' && pathname.startsWith(`/items/${ledgerCollection}`),
    );

    expect(firstWrite).toBeGreaterThan(0);
    expect(ledgerAt).toBeGreaterThan(firstWrite);
    expect(
      fake
        .mutations()
        .filter(
          ({ pathname }) =>
            pathname.startsWith('/flows') || pathname.startsWith('/operations'),
        ),
    ).toEqual([]);
  });

  test('accepts the empty schema setup creates, coordination singleton included', async () => {
    const fake = fakeImportDirectus(installedStore());

    await expect(importInto(fake)).resolves.toMatchObject({
      conversion: { status: 'converted' },
    });
    expect(applicationCollections).not.toContain('data_operations');
    expect(applicationCollections).toContain(ledgerCollection);
  });

  test('refuses a populated checkpoint project before its first write, naming the exact record counts', async () => {
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
    expect(String(error)).toContain(
      '3 record(s) in 2 application collection(s): courses 2, staff 1.',
    );
    expect(String(error)).toContain('npm run migrate');
    expect(fake.mutations()).toEqual([]);
    expect(fake.setups()).toBe(0);
  });

  test('refuses records in relational collections and in the ledger too', async () => {
    const store = installedStore();
    store.items.set('curriculum_entries', [{ id: 7 }]);
    store.items.set(ledgerCollection, [{ id: 1 }, { id: 2 }]);
    const fake = fakeImportDirectus(store);

    await expect(importInto(fake)).rejects.toMatchObject({
      counts: { curriculum_entries: 1, [ledgerCollection]: 2 },
    });
    expect(fake.mutations()).toEqual([]);
  });
});

describe('an import interrupted after it began writing', () => {
  test('reports a partial write with the rows Directus confirmed, and a rerun is then refused', async () => {
    const fake = fakeImportDirectus(emptyStore(), { batchSize: 2 });
    const failing = failingAt(fake, '/items/courses', 2);

    const error = await refusalOf(importWorkbook(failing, workbook(), fake.io));

    expect(error).toBeInstanceOf(ImportInterruptedError);
    expect(error).toMatchObject({
      progress: { confirmed: 2, phase: 'writing', total: 77 },
    });

    const message = String(error);

    expect(message).toContain(
      'while writing the workbook rows: synthetic outage. Directus had confirmed 2 of the 77 workbook rows, so npm run import now refuses this project',
    );
    expect(message).toContain(
      'Restore the pre-import backup or remove every application record',
    );
    expect(message).toContain(
      'Do not upgrade the partial rows with npm run migrate.',
    );
    expect(rowsIn(fake.store, 'courses')).toHaveLength(2);
    await expect(importInto(fake)).rejects.toBeInstanceOf(ExistingDataError);
  });

  test('says so when the first batch fails with no row confirmed, and a rerun is then accepted', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const failing = failingAt(fake, '/items/courses', 1);

    const error = await refusalOf(importWorkbook(failing, workbook(), fake.io));

    expect(error).toMatchObject({
      progress: { confirmed: 0, phase: 'writing' },
    });

    const message = String(error);

    expect(message).toContain(
      'Directus confirmed no workbook row, so once the cause is fixed npm run import can run again',
    );
    expect(message).not.toContain('refuses this project');
    expect(message).not.toContain('npm run migrate');
    expect(
      applicationCollections.filter(
        (collection) => rowsIn(fake.store, collection).length > 0,
      ),
    ).toEqual([]);
    await expect(importInto(fake)).resolves.toMatchObject({
      conversion: { status: 'converted' },
    });
  });

  test('sends an interrupted conversion to the upgrade path', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const failing = failingAt(fake, '/items/curriculum_entries', 1);

    const error = await refusalOf(importWorkbook(failing, workbook(), fake.io));

    expect(error).toMatchObject({
      progress: { confirmed: 77, phase: 'converting' },
    });

    const message = String(error);

    expect(message).toContain(
      'Every workbook row was written, so npm run import now refuses this project. Fix the cause, then finish with npm run migrate (dry-run, then apply)',
    );
    expect(
      rowsIn(fake.store, ledgerCollection).map((row) => ledgerRow.parse(row)),
    ).toMatchObject([
      { status: 'completed', step: 'preflight' },
      { status: 'failed', step: 'curricula' },
    ]);
    expect(
      projected(fake.store, 'academic_years', ['label', 'published']),
    ).toEqual(academicYears.map((label) => ({ label, published: true })));
  });

  test('sends an import whose academic years were not seeded back to a fresh import, never to the upgrade path', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const failing = failingAt(fake, '/items/academic_years', 1);

    const error = await refusalOf(importWorkbook(failing, workbook(), fake.io));

    expect(error).toMatchObject({
      progress: { confirmed: 77, phase: 'converting' },
    });

    const message = String(error);

    expect(message).toContain(
      'The academic years of the workbook were not all seeded: synthetic outage',
    );
    expect(message).toContain(
      'Every workbook row was written, but not every academic year the workbook names was seeded, so npm run import now refuses this project, and npm run migrate would convert only the years the project holds. Restore the pre-import backup or remove every application record',
    );
    expect(message).not.toContain('finish with npm run migrate');
    expect(rowsIn(fake.store, 'academic_years')).toEqual([]);
    expect(rowsIn(fake.store, ledgerCollection)).toEqual([]);
  });
});

describe('workbook rows and their relational conversion', () => {
  test('batches large private imports below the request payload limit', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const data: MigrationData = {
      ...emptyData,
      moodle_users: Array.from({ length: 501 }, (_, moodleId) => ({
        ID_new: moodleId,
      })),
    };

    await importInto(fake, { ...emptyWorkbook, data });

    expect(
      fake.calls.filter(
        ({ method, pathname }) =>
          method === 'POST' && pathname === '/items/moodle_users?fields=id',
      ),
    ).toHaveLength(3);
    expect(rowsIn(fake.store, 'moodle_users')).toHaveLength(501);
  });

  test('converts the workbook rows to exactly the target rows an upgrade of the same checkpoint rows writes', async () => {
    const content = workbook();
    const imported = fakeImportDirectus(emptyStore());
    await importInto(imported, content);

    const upgraded = storeFromDataset(withSequentialIds(content.data), {
      installed: true,
    });
    const { request } = fakeItemsDirectus(upgraded);
    const inventory = await readInventory(request, {});
    await runConversion(
      request,
      { inventory, live: preflight(inventory, null) },
      {
        batchSize: 250,
        now: imported.io.now,
        resume: false,
        runToken: 'upgrade',
      },
    );

    for (const collection of [
      ...targetCollections,
      'teaching_assignments',
      'student_council',
      'course_equivalencies',
      'curriculum_generations',
      'study_programs',
      'curriculum_entry_program_states',
      'course_equivalency_members',
    ]) {
      const keys = Object.keys(rowsIn(upgraded, collection)[0] ?? {});

      expect(projected(imported.store, collection, keys)).toEqual(
        projected(upgraded, collection, keys),
      );
    }

    expect(rowsIn(imported.store, 'curriculum_entries')).toHaveLength(18);
    expect(
      rowsIn(imported.store, ledgerCollection).map((row) => row['id_map']),
    ).toEqual(rowsIn(upgraded, ledgerCollection).map((row) => row['id_map']));
  });

  test('seeds the academic years the workbook names, a later one included, with their rules', async () => {
    const years = ['2026/2027', ...academicYears];
    const fake = fakeImportDirectus(emptyStore());

    const summary = await importInto(
      fake,
      workbookContent(lifecycleDataset(), years),
    );

    expect(summary.conversion.status).toBe('converted');
    expect(
      projected(fake.store, 'academic_years', ['label', 'published', 'sort']),
    ).toEqual(
      years.map((label, index) => ({
        label,
        published: true,
        sort: years.length - index,
      })),
    );
    expect(rowsIn(fake.store, 'course_enrollment_rules')).toHaveLength(
      rowsIn(fake.store, 'courses').length * years.length,
    );
  });

  test('imports the rows but leaves the ledger untouched while an ambiguity blocks the conversion', async () => {
    const content = workbookContent(duplicateIndex());
    const fake = fakeImportDirectus(emptyStore());

    const summary = await importInto(fake, content);

    expect(summary.conversion).toEqual({
      blockers: { ambiguous_student_index: 1 },
      status: 'blocked',
    });
    expect(rowsIn(fake.store, 'students')).toHaveLength(4);
    expect(rowsIn(fake.store, ledgerCollection)).toEqual([]);
    expect(rowsIn(fake.store, 'curriculum_entries')).toEqual([]);
    expect(rowsIn(fake.store, 'course_enrollment_rules')).toEqual([]);
    // The generations and the programs of the curriculum sheets are
    // seeded before the gate, like the years, for npm run migrate.
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
    expect(rowsIn(fake.store, 'study_programs')).toHaveLength(15);
    expect(
      projected(fake.store, 'academic_years', ['label', 'published', 'sort']),
    ).toEqual(
      academicYears.map((label, index) => ({
        label,
        published: true,
        sort: academicYears.length - index,
      })),
    );
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
      importWorkbook(createDirectusRequest(config), emptyWorkbook, {
        now: () => '2026-09-22T12:00:00.000Z',
        runToken: () => 'run',
      }),
    ).rejects.toThrow('application collection(s): courses 2.');
    expect(methods.every((method) => method === 'GET')).toBeTruthy();
  });
});
