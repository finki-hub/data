import { describe, expect, test } from 'vitest';

import type { DirectusRequest } from '../src/directus-request.js';

import { fingerprintInventory } from '../src/migrations/fingerprint.js';
import { readInventory } from '../src/migrations/inventory.js';
import { PagingError } from '../src/migrations/paging.js';
import { preflight } from '../src/migrations/preflight.js';
import { type MigrationReport } from '../src/migrations/report.js';
import { collectionKeys } from '../src/schema.js';
import { academicYears as specAcademicYears } from '../src/specs/public.js';
import {
  academicYears,
  makeSyntheticDataset,
  privateSentinels,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  storeFromDataset,
} from './migration-test-helpers.js';

const hexPattern = /^[0-9a-f]{64}$/u;
const offsetPattern = /offset=\d+/u;
const fakeBase = 'https://fake.example';
const studentName = 'Synthetic Student';
const alphaCurrentName = 'Alpha Course (2023)';
const collator = new Intl.Collator('en');
const byName = (left: string, right: string): number =>
  collator.compare(left, right);

// The synthetic dataset without its deliberate duplicates.
const uniqueDataset = (base = makeSyntheticDataset()): SyntheticDataset => ({
  ...base,
  course_enrollment_patterns: base.course_enrollment_patterns.filter(
    (row) => row.id !== 2,
  ),
  course_equivalencies: base.course_equivalencies.filter((row) => row.id !== 2),
  curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
  curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
  students: base.students.filter((row) => row.id !== 2),
  teaching_assignments: base.teaching_assignments.filter((row) => row.id !== 2),
});

const reportFor = async (
  dataset: SyntheticDataset,
  options: { readonly installed?: boolean; readonly pageSize?: number } = {},
): Promise<{ report: MigrationReport; store: FakeStore }> => {
  const store = storeFromDataset(dataset, {
    installed: options.installed ?? true,
  });
  const { request } = fakeItemsDirectus(store);
  const inventory = await readInventory(request, {
    pageSize: options.pageSize ?? 3,
  });
  return { report: preflight(inventory, null), store };
};

const reportOf = async (store: FakeStore): Promise<MigrationReport> => {
  const { request } = fakeItemsDirectus(store);
  return preflight(await readInventory(request, {}), null);
};

const fingerprintOf = async (store: FakeStore): Promise<string> => {
  const { request } = fakeItemsDirectus(store);
  return fingerprintInventory(await readInventory(request, {}));
};

const findings = (report: MigrationReport, code: string) =>
  [...report.blockers, ...report.warnings].filter(
    (finding) => finding.code === code,
  );

const queryOf = (pathname: string): URLSearchParams =>
  new URL(pathname, fakeBase).searchParams;

// The target collections the inventory lists the fields of.
const targetListings = [
  'academic_years',
  'course_curricula',
  'course_enrollment_rules',
  'curriculum_entries',
  'curriculum_generations',
];

describe('inventory', () => {
  test('reads every checkpoint collection with explicit fields, sorted by id and paged', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    const { calls, mutations, request } = fakeItemsDirectus(store);
    const inventory = await readInventory(request, { pageSize: 3 });

    expect(mutations()).toEqual([]);
    expect(inventory.checkpoint.courses.map(({ id }) => id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(inventory.checkpoint.curriculum_2023).toHaveLength(10);
    expect(inventory.checkpoint.moodle_users.map(({ id }) => id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);

    const courseReads = calls.filter(({ pathname }) =>
      pathname.startsWith('/items/courses?'),
    );

    expect(courseReads.length).toBeGreaterThan(1);

    const fieldListings = calls.filter(({ pathname }) =>
      pathname.startsWith('/fields/'),
    );

    expect(fieldListings.map(({ pathname }) => pathname)).toEqual(
      [...collectionKeys, ...targetListings].map((name) => `/fields/${name}`),
    );

    const listings = calls.filter((call) => !fieldListings.includes(call));

    for (const { pathname } of listings) {
      const query = queryOf(pathname);

      expect(query.get('fields')).not.toBeNull();
      expect(query.get('fields')).not.toContain('*');
      expect(query.get('sort')).toBe('id');
      expect(query.get('limit')).toBe('3');
    }
    const moodleRead = calls.find(({ pathname }) =>
      pathname.startsWith('/items/moodle_users?'),
    );

    expect(queryOf(moodleRead?.pathname ?? '').get('fields')).toBe(
      'Courses,id',
    );
    expect(inventory.fields.moodle_users).toContain('Mail');
    expect(inventory.fields.courses).toContain('credits_2023');
    expect(inventory.checkpoint.curriculum_2023[0]).toMatchObject({
      channel: true,
      code: 'SYN23-001',
      level: 1,
      semester: 1,
      state_kn: 'mandatory',
    });
    expect(inventory.checkpoint.courses[0]).toMatchObject({
      available_2023: true,
      credits_2023: 6,
    });

    const text = JSON.stringify(inventory);

    expect(text).not.toContain('@');
    expect(text).not.toContain(studentName);

    for (const sentinel of privateSentinels) {
      expect(text).not.toContain(sentinel);
    }
  });

  test('inventories persisted Flows and their operations', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    store.flows.push({
      id: 1,
      name: 'Rebuild derived data',
      operation: 'op-1',
      status: 'active',
      trigger: 'manual',
    });
    store.operations.push({
      flow: 1,
      id: 2,
      key: 'rebuild_derived_data',
      options: { collections: ['courses'] },
      reject: null,
      resolve: null,
      type: 'finki-hub-rebuild-derived-data',
    });
    const { request } = fakeItemsDirectus(store);
    const inventory = await readInventory(request, { pageSize: 50 });

    expect(inventory.flows).toEqual([
      {
        id: '1',
        name: 'Rebuild derived data',
        operation: 'op-1',
        status: 'active',
        trigger: 'manual',
      },
    ]);
    expect(inventory.operations.map(({ type }) => type)).toEqual([
      'finki-hub-rebuild-derived-data',
    ]);
  });

  test('reads the whole collection when the server clamps the page size below the requested limit', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), {
      installed: true,
      limitMax: 2,
    });
    const { calls, request } = fakeItemsDirectus(store);
    const inventory = await readInventory(request, { pageSize: 250 });

    expect(inventory.checkpoint.courses.map(({ id }) => id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(inventory.checkpoint.moodle_users).toHaveLength(9);
    expect(
      calls
        .filter(({ pathname }) => pathname.startsWith('/items/courses?'))
        .map(({ pathname }) => queryOf(pathname).get('offset')),
    ).toEqual(['0', '2', '4', '6', '8']);
    await expect(fingerprintOf(store)).resolves.toBe(
      await fingerprintOf(
        storeFromDataset(makeSyntheticDataset(), {
          installed: true,
        }),
      ),
    );
  });

  test('fails instead of looping or truncating when a page repeats rows', async () => {
    const store = storeFromDataset(uniqueDataset(), { installed: true });
    const { request } = fakeItemsDirectus(store);
    const repeating: DirectusRequest = (pathname, init) =>
      request(pathname.replace(offsetPattern, 'offset=0'), init);

    await expect(readInventory(repeating, { pageSize: 3 })).rejects.toThrow(
      PagingError,
    );
  });

  test('reports the relational model as missing before setup ran', async () => {
    const { report } = await reportFor(uniqueDataset(), { installed: false });

    expect(report.targets).toBeNull();
    expect(findings(report, 'model_not_installed')).toHaveLength(1);
    expect(report.blockers).toEqual([]);
  });

  test('fails closed when a target collection exists but its provenance rows cannot be read', async () => {
    const store = storeFromDataset(uniqueDataset(), { installed: true });
    store.items
      .get('curriculum_entries')
      ?.push({ generation: '2023', id: 1, name: 'Hand made' });
    const { request } = fakeItemsDirectus(store);

    await expect(readInventory(request, {})).rejects.toThrow(
      'source_collection',
    );
  });

  test('inventories the columns of every checkpoint collection and warns about an undeclared one', async () => {
    const store = storeFromDataset(uniqueDataset(), { installed: true });
    const courses = store.items.get('courses') ?? [];
    courses[0] = { ...courses[0], id: 1, legacy_note: 'operator column' };
    const report = await reportOf(store);

    expect(report.fields.courses).toContain('legacy_note');
    expect(report.fields.courses).toContain('name_2018_override');
    expect(report.fields.students).toEqual(
      [...report.fields.students].toSorted(byName),
    );
    expect(findings(report, 'unknown_source_field')).toEqual([
      expect.objectContaining({
        collection: 'courses',
        ids: [],
        label: 'legacy_note',
      }),
    ]);
    expect(report.blockers).toEqual([]);

    const clean = await reportOf(
      storeFromDataset(uniqueDataset(), { installed: true }),
    );

    expect(findings(clean, 'unknown_source_field')).toEqual([]);
    expect(Object.keys(clean.fields).toSorted(byName)).toEqual(
      [...collectionKeys].toSorted(byName),
    );
  });

  test('seeds rules for the same academic years as the derivation', () => {
    expect([...specAcademicYears]).toEqual([...academicYears]);
  });
});

describe('source fingerprint', () => {
  test('is a deterministic sha256 over the inventoried source rows', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    const first = await fingerprintOf(store);

    expect(first).toMatch(hexPattern);
    await expect(fingerprintOf(store)).resolves.toBe(first);
  });

  test('changes with an inventoried source field and ignores target rows', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    const original = await fingerprintOf(store);
    store.items.get('curriculum_entries')?.push({
      generation: 3,
      id: 1,
      name: alphaCurrentName,
      source_collection: 'curriculum_2023',
      source_id: 1,
    });

    await expect(fingerprintOf(store)).resolves.toBe(original);

    const courses = store.items.get('courses') ?? [];
    courses[0] = { ...courses[0], id: 1, name_2023: 'Renamed' };

    await expect(fingerprintOf(store)).resolves.not.toBe(original);
  });

  test('changes with every curriculum and course value column a converter copies', async () => {
    const edits: ReadonlyArray<
      readonly [
        string,
        number,
        Record<string, boolean | null | number | string>,
      ]
    > = [
      ['curriculum_2023', 0, { channel: false }],
      ['curriculum_2023', 0, { semester: 99 }],
      ['curriculum_2023', 0, { level: 42 }],
      ['curriculum_2023', 0, { prerequisites: 'REWRITTEN' }],
      ['curriculum_2023', 0, { state_kn: 'rewritten' }],
      ['curriculum_2023', 0, { state_ie: 'rewritten' }],
      ['curriculum_2023', 0, { url: 'https://curriculum.example/moved' }],
      ['curriculum_2023', 0, { catalog_order: 77 }],
      ['curriculum_2018', 0, { state_ke: 'rewritten' }],
      ['curriculum_2018', 0, { code: 'SYN18-MOVED' }],
      ['courses', 0, { credits_2023: 12 }],
      ['courses', 0, { credits_2018: 12 }],
      ['courses', 0, { available_2023: false }],
      ['courses', 0, { available_2018: true }],
    ];
    const original = await fingerprintOf(
      storeFromDataset(makeSyntheticDataset(), { installed: true }),
    );
    const seen = new Set<string>([original]);

    for (const [collection, index, values] of edits) {
      const store = storeFromDataset(makeSyntheticDataset(), {
        installed: true,
      });
      const rows = store.items.get(collection) ?? [];
      rows[index] = { ...rows[index], id: rows[index]?.id ?? 0, ...values };
      const changed = await fingerprintOf(store);

      expect(changed).not.toBe(original);

      seen.add(changed);
    }

    expect(seen.size).toBe(edits.length + 1);
  });

  test('changes when a column is added to a checkpoint collection', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    const original = await fingerprintOf(store);
    const staff = store.items.get('staff') ?? [];
    staff[0] = { ...staff[0], id: 1, office_hours_note: null };

    await expect(fingerprintOf(store)).resolves.not.toBe(original);
  });

  test('changes when a persisted Flow changes', async () => {
    const store = storeFromDataset(makeSyntheticDataset(), { installed: true });
    const original = await fingerprintOf(store);
    store.flows.push({
      id: 1,
      name: 'Synthetic flow',
      operation: null,
      status: 'inactive',
      trigger: 'manual',
    });

    await expect(fingerprintOf(store)).resolves.not.toBe(original);
  });
});
