import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import type { MigrationData } from '../src/schema.js';

import {
  checkpointPreset,
  installCheckpointPresets,
  searchBookmark,
} from '../src/checkpoint-presets.js';
import { dataModelCollectionKeys } from '../src/data-model/collections.js';
import {
  derivedDataFlow,
  derivedDataFlowId,
} from '../src/derived-data-flow.js';
import {
  createDirectusRequest,
  type DirectusRequest,
} from '../src/directus-request.js';
import { importWorkbook } from '../src/directus.js';
import { IncompleteFlowError } from '../src/flows/install-flows.js';
import { ImportInterruptedError } from '../src/import-interruption.js';
import {
  applicationCollections,
  ExistingDataError,
} from '../src/import-state.js';
import { runConversion } from '../src/migrations/conversion.js';
import { readInventory } from '../src/migrations/inventory.js';
import { ledgerCollection } from '../src/migrations/ledger-claim.js';
import { preflight } from '../src/migrations/preflight.js';
import { collectionSpecs } from '../src/model.js';
import {
  publicAssetsFlow,
  publicAssetsFlowId,
} from '../src/public-assets-flow.js';
import { config, emptyData, toUrl } from './directus-test-helpers.js';
import { makeSyntheticDataset } from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  withSequentialIds,
  workbookData,
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
const flowBody = z.looseObject({
  id: z.string(),
  name: z.string(),
  operation: z.null(),
  options: z.looseObject({
    collections: z.array(z.string()),
    location: z.string(),
    requireConfirmation: z.boolean(),
    requireSelection: z.boolean(),
  }),
  status: z.string(),
  trigger: z.string(),
});
const operationBody = z.looseObject({
  flow: z.string(),
  id: z.string(),
  key: z.string(),
  options: z.unknown(),
  type: z.string(),
});
const ledgerRow = z.looseObject({ status: z.string(), step: z.string() });

const workbook = (): MigrationData => workbookData(lifecycleDataset());

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

const importInto = (fake: ImportFake, data: MigrationData = workbook()) =>
  importWorkbook(fake.request, data, fake.io);

const noPublish =
  'Do not run Publish public assets before Rebuild derived data has run over the complete rows.';

// The fake's request, except that the `nth` POST whose path starts with
// `prefix` rejects as an outage would.
const failingAt = (
  fake: ImportFake,
  prefix: string,
  nth: number,
): ImportFake['request'] => {
  let seen = 0;
  return (pathname, init, mode) => {
    if (init?.method === 'POST' && pathname.startsWith(prefix)) {
      seen += 1;
      if (seen === nth) {
        return Promise.reject(new Error('synthetic outage'));
      }
    }
    return fake.request(pathname, init, mode);
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
  test('imports into a fresh project: setup first, then the Flows, the rows, the ledger and the rebuild', async () => {
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

    const flowsAt = firstIndex(fake.calls, ({ pathname }) =>
      pathname.startsWith('/flows'),
    );
    const firstWrite = firstIndex(fake.calls, isItemWrite);
    const ledgerAt = firstIndex(
      fake.calls,
      ({ method, pathname }) =>
        method === 'POST' && pathname.startsWith(`/items/${ledgerCollection}`),
    );
    const triggerAt = firstIndex(fake.calls, ({ pathname }) =>
      pathname.startsWith('/flows/trigger/'),
    );

    expect(flowsAt).toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(flowsAt);
    expect(ledgerAt).toBeGreaterThan(firstWrite);
    expect(triggerAt).toBeGreaterThan(ledgerAt);
    expect(triggerAt).toBe(fake.calls.length - 1);
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
      progress: { confirmed: 2, conversion: null, phase: 'writing', total: 77 },
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
    expect(message).toContain(noPublish);
    expect(rowsIn(fake.store, 'courses')).toHaveLength(2);
    expect(fake.triggers).toEqual([]);
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
    expect(message).toContain(noPublish);
    expect(
      applicationCollections.filter(
        (collection) => rowsIn(fake.store, collection).length > 0,
      ),
    ).toEqual([]);
    await expect(importInto(fake)).resolves.toMatchObject({
      conversion: { status: 'converted' },
    });
  });

  test('sends an interrupted conversion to the upgrade path and to Rebuild derived data, which did not run', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const failing = failingAt(fake, '/items/curriculum_entries', 1);

    const error = await refusalOf(importWorkbook(failing, workbook(), fake.io));

    expect(error).toMatchObject({
      progress: { confirmed: 77, conversion: null, phase: 'converting' },
    });

    const message = String(error);

    expect(message).toContain(
      'Every workbook row was written, so npm run import now refuses this project. Fix the cause, then finish with npm run migrate (dry-run, then apply)',
    );
    expect(message).toContain(
      'The initial rebuild did not run, so run Rebuild derived data from Studio once the upgrade is done.',
    );
    expect(message).toContain(noPublish);
    expect(fake.triggers).toEqual([]);
    expect(
      rowsIn(fake.store, ledgerCollection).map((row) => ledgerRow.parse(row)),
    ).toMatchObject([
      { status: 'completed', step: 'preflight' },
      { status: 'failed', step: 'curricula' },
    ]);
  });

  test('keeps a blocked conversion in view when the rebuild that follows it fails', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const failing = failingAt(fake, '/flows/trigger/', 1);

    const error = await refusalOf(
      importWorkbook(failing, workbookData(duplicateIndex()), fake.io),
    );

    expect(error).toMatchObject({
      progress: {
        conversion: {
          blockers: { ambiguous_student_index: 1 },
          status: 'blocked',
        },
        phase: 'rebuilding',
      },
    });

    const message = String(error);

    expect(message).toContain(
      'The rows are imported, but the relational conversion is blocked by {"ambiguous_student_index":1} and did not run',
    );
    expect(message).toContain(
      'Run Rebuild derived data from Studio, resolve those findings in Studio, then finish with npm run migrate (dry-run, then apply).',
    );
    expect(message).not.toContain('conversion are complete');
    expect(rowsIn(fake.store, ledgerCollection)).toEqual([]);
  });

  test('reports a failed rebuild after a complete conversion without sending it to the upgrade path', async () => {
    const fake = fakeImportDirectus(emptyStore());
    const failing = failingAt(fake, '/flows/trigger/', 1);

    const error = await refusalOf(importWorkbook(failing, workbook(), fake.io));

    expect(error).toMatchObject({
      progress: { conversion: { status: 'converted' }, phase: 'rebuilding' },
    });

    const message = String(error);

    expect(message).toContain(
      'The rows and the relational conversion are complete, so npm run import now refuses this project. Run Rebuild derived data from Studio instead of importing again.',
    );
    expect(message).not.toContain('npm run migrate');
    expect(message).toContain(noPublish);
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

    await importInto(fake, data);

    expect(
      fake.calls.filter(
        ({ method, pathname }) =>
          method === 'POST' && pathname === '/items/moodle_users?fields=id',
      ),
    ).toHaveLength(3);
    expect(rowsIn(fake.store, 'moodle_users')).toHaveLength(501);
  });

  test('converts the workbook rows to exactly the target rows an upgrade of the same checkpoint rows writes', async () => {
    const data = workbook();
    const imported = fakeImportDirectus(emptyStore());
    await importInto(imported, data);

    const upgraded = storeFromDataset(withSequentialIds(data), {
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

  test('imports the rows but leaves the ledger untouched while an ambiguity blocks the conversion', async () => {
    const data = workbookData(duplicateIndex());
    const fake = fakeImportDirectus(emptyStore());

    const summary = await importInto(fake, data);

    expect(summary.conversion).toEqual({
      blockers: { ambiguous_student_index: 1 },
      status: 'blocked',
    });
    expect(rowsIn(fake.store, 'students')).toHaveLength(4);
    expect(rowsIn(fake.store, ledgerCollection)).toEqual([]);
    expect(rowsIn(fake.store, 'curriculum_entries')).toEqual([]);
    expect(fake.triggers).toHaveLength(1);
  });

  test('runs the initial rebuild through the manual Flow with collection context and accepts its raw result', async () => {
    const fake = fakeImportDirectus(emptyStore(), {
      triggerResult: { courses: 8, studentCouncilMembers: 4 },
    });

    const summary = await importInto(fake);

    expect(fake.triggers).toEqual([{ id: derivedDataFlowId, mode: 'raw' }]);
    expect(fake.calls.at(-1)?.body).toEqual({ collection: 'courses' });
    expect(summary.rebuild).toEqual({ courses: 8, studentCouncilMembers: 4 });

    const edited = fakeImportDirectus(emptyStore(), {
      triggerResult: { customised: true },
    });

    await expect(importInto(edited)).resolves.toMatchObject({ rebuild: null });
  });
});

describe('checkpoint Flow templates', () => {
  test('install Rebuild derived data and Publish public assets once under stable ids', async () => {
    const fake = fakeImportDirectus(emptyStore());

    const summary = await importInto(fake);

    expect(summary.flows).toEqual({
      created: ['Rebuild derived data', 'Publish public assets'],
      skipped: [],
    });

    const flows = fake.calls
      .filter(
        ({ method, pathname }) => method === 'POST' && pathname === '/flows',
      )
      .map(({ body }) => flowBody.parse(body));

    expect(flows.map(({ id, status }) => [id, status])).toEqual([
      [derivedDataFlowId, 'inactive'],
      [publicAssetsFlowId, 'inactive'],
    ]);
    expect(flows[0]?.options.collections).toEqual([
      'courses',
      'course_enrollment_patterns',
      'curriculum_2023',
      'curriculum_2018',
      'course_equivalencies',
      'teaching_assignments',
      'moodle_users',
      'students',
      'student_council',
    ]);
    expect(flows[1]).toMatchObject({
      name: 'Publish public assets',
      options: {
        collections: ['courses', 'rooms', 'staff', 'students'],
        location: 'collection',
        requireConfirmation: true,
        requireSelection: false,
      },
      trigger: 'manual',
    });

    const operations = fake.calls
      .filter(
        ({ method, pathname }) =>
          method === 'POST' && pathname === '/operations',
      )
      .map(({ body }) => operationBody.parse(body));

    expect(operations).toHaveLength(7);
    expect(
      operations.find(({ key }) => key === 'publish_assets'),
    ).toMatchObject({
      flow: publicAssetsFlowId,
      options: {
        objects: {
          'courses.json': '{{serialize_assets.courses}}',
          'rooms.json': '{{serialize_assets.rooms}}',
          'staff.json': '{{serialize_assets.staff}}',
          'students.json': '{{serialize_assets.students}}',
        },
        storage: 'publish',
      },
      type: 'finki-hub-publish-json',
    });
    expect(
      operations.find(({ key }) => key === 'rebuild_derived_data'),
    ).toMatchObject({
      flow: derivedDataFlowId,
      type: 'finki-hub-rebuild-derived-data',
    });
    expect(
      fake.calls
        .filter(({ method }) => method === 'PATCH')
        .filter(({ pathname }) => pathname.startsWith('/flows/'))
        .map(({ body, pathname }) => [pathname, body]),
    ).toEqual([
      [
        `/flows/${derivedDataFlowId}`,
        { operation: derivedDataFlow.entry, status: 'active' },
      ],
      [
        `/flows/${publicAssetsFlowId}`,
        { operation: publicAssetsFlow('').entry, status: 'active' },
      ],
    ]);
  });

  test('leave a Flow already present under its stable id exactly as Studio left it', async () => {
    const store = emptyStore();
    const edited = {
      id: derivedDataFlowId,
      name: 'Rebuild derived data',
      operation: 'studio-edited-entry',
      options: { requireConfirmation: false },
      status: 'active',
      trigger: 'manual',
    };
    store.flows.push({ ...edited });
    const fake = fakeImportDirectus(store);

    const summary = await importInto(fake);

    expect(summary.flows).toEqual({
      created: ['Publish public assets'],
      skipped: ['Rebuild derived data'],
    });
    expect(store.flows.find(({ id }) => id === derivedDataFlowId)).toEqual(
      edited,
    );
    expect(
      fake
        .mutations()
        .filter(
          ({ body, pathname }) =>
            pathname === `/flows/${derivedDataFlowId}` ||
            JSON.stringify(body).includes(`"flow":"${derivedDataFlowId}"`),
        ),
    ).toEqual([]);
    expect(fake.triggers).toEqual([{ id: derivedDataFlowId, mode: 'raw' }]);
  });

  test('refuse a half-installed template Flow before the first row is written', async () => {
    const store = emptyStore();
    store.flows.push({
      id: publicAssetsFlowId,
      name: 'Publish public assets',
      operation: null,
    });
    const fake = fakeImportDirectus(store);

    await expect(importInto(fake)).rejects.toBeInstanceOf(IncompleteFlowError);
    expect(fake.calls.filter((call) => isItemWrite(call))).toEqual([]);
  });
});

describe('checkpoint presets and the Search bookmark', () => {
  type LivePreset = Record<
    'bookmark' | 'collection' | 'role' | 'user',
    null | string
  >;

  const postedPreset = z.looseObject({
    bookmark: z.string().optional(),
    collection: z.string(),
  });

  // A presets endpoint over `live`: a listing answers every global and
  // personal preset, a POST stores a global one.
  const install = (live: LivePreset[]) => {
    const posted: Array<z.infer<typeof postedPreset>> = [];
    const request: DirectusRequest = async (_pathname, init) => {
      await Promise.resolve();
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const body = postedPreset.parse(JSON.parse(init.body));
        posted.push(body);
        live.push({
          bookmark: body.bookmark ?? null,
          collection: body.collection,
          role: null,
          user: null,
        });
        return {};
      }
      return live.map((preset) => ({ ...preset }));
    };
    return { posted, run: () => installCheckpointPresets(request) };
  };

  test('give a fresh project a table view for every checkpoint collection and the Search bookmark', async () => {
    const { posted, run } = install([]);

    await expect(run()).resolves.toEqual({ created: 14, skipped: 0 });
    expect(
      posted
        .filter(({ bookmark }) => bookmark === undefined)
        .map(({ collection }) => collection),
    ).toEqual(collectionSpecs.map(({ key }) => key));
    expect(posted.filter(({ bookmark }) => bookmark === 'Search')).toEqual([
      expect.objectContaining({
        collection: 'moodle_users',
        layout: 'finki-hub-course-search',
      }),
    ]);
    expect(posted[0]).toEqual(checkpointPreset(collectionSpecs[0]).body);
    expect(posted.at(-1)).toEqual(searchBookmark.body);
  });

  test('keep every global view the presentation or a populated deployment already has', async () => {
    const relational: LivePreset[] = [
      'courses',
      'teaching_assignments',
      'student_council',
      'course_equivalencies',
    ].map((collection) => ({
      bookmark: null,
      collection,
      role: null,
      user: null,
    }));
    const personal: LivePreset = {
      bookmark: null,
      collection: 'rooms',
      role: null,
      user: 'someone',
    };
    const { posted, run } = install([...relational, personal]);

    await expect(run()).resolves.toEqual({ created: 10, skipped: 4 });
    expect(posted.map(({ collection }) => collection)).toEqual([
      'staff',
      'rooms',
      'students',
      'curriculum_2023',
      'curriculum_2018',
      'course_enrollment_patterns',
      'discord_channels',
      'deans_office',
      'moodle_users',
      'moodle_users',
    ]);
  });

  test('create nothing on a rerun', async () => {
    const live: LivePreset[] = [];
    await install(live).run();
    const second = install(live);

    await expect(second.run()).resolves.toEqual({ created: 0, skipped: 14 });
    expect(second.posted).toEqual([]);
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
      importWorkbook(createDirectusRequest(config), emptyData, {
        now: () => '2026-09-22T12:00:00.000Z',
        runToken: () => 'run',
      }),
    ).rejects.toThrow('application collection(s): courses 2.');
    expect(methods.every((method) => method === 'GET')).toBeTruthy();
  });
});
