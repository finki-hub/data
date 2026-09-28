import { describe, expect, test } from 'vitest';

import type { DirectusRequest } from '../src/directus-request.js';
import type { SourceMapEntry } from '../src/migrations/source-map.js';

import { ledgerCollection } from '../src/migrations/ledger-claim.js';
import {
  type FakeItem,
  fakeItemsDirectus,
  type FakeStore,
} from './migration-test-helpers.js';
import {
  codes,
  idsOf,
  ledgerMap,
  prepare,
  type Prepared,
  rowsOf,
  runSteps,
  scalarsOf,
  stepNames,
  uniqueDataset,
  withStaff,
} from './relational-migration-helpers.js';

// The scalar columns of the old rows the migration must leave as they are.
const checkpointScalars: Readonly<Record<string, readonly string[]>> = {
  course_enrollment_patterns: ['id', 'course_name', 'academic_year', 'pattern'],
  course_equivalencies: ['id', 'course_2023', 'course_2018', 'course_2013'],
  courses: [
    'id',
    'name',
    'name_2023',
    'name_2018_override',
    'professors_override',
    'professors',
    'assistants',
    'credits_2023',
    'available_2023',
  ],
  staff: ['id', 'name'],
  student_council: ['id', 'year', 'index_number', 'position', 'name'],
  students: ['id', 'index_number', 'name'],
  teaching_assignments: ['id', 'course_name', 'professors', 'assistants'],
};

const snapshot = (store: FakeStore) =>
  new Map(
    Object.entries(checkpointScalars).map(([collection, fields]) => [
      collection,
      scalarsOf(store, collection, fields),
    ]),
  );

// The original rows keep their ids and scalar columns; only rows appended
// after them (the role rows of teaching_assignments) are new.
const assertOriginalsUntouched = (
  store: FakeStore,
  before: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>,
): void => {
  for (const [collection, fields] of Object.entries(checkpointScalars)) {
    const expected = before.get(collection) ?? [];
    const rows = scalarsOf(store, collection, fields);

    expect(rows.slice(0, expected.length)).toEqual(expected);
  }
};

const entriesOf = (
  map: readonly SourceMapEntry[],
  sourceCollection: string,
  relation?: string,
) =>
  map.filter(
    (entry) =>
      entry.sourceCollection === sourceCollection &&
      (relation === undefined || entry.relation === relation),
  );

const ledgerMaps = (store: FakeStore): readonly SourceMapEntry[] =>
  stepNames.flatMap((step) => ledgerMap(store, step));

// Each equivalency row's members as `<generation code>:<linked>`, in row
// order: today's link decisions, 2013 never linked.
const memberLinks = (store: FakeStore) => {
  const generationCodes = new Map(
    rowsOf(store, 'curriculum_generations').map((row) => [row.id, row['code']]),
  );
  const label = (row: FakeItem) =>
    `${String(generationCodes.get(Number(row['generation'])))}:${String(row['entry'] !== null)}`;
  return Map.groupBy(
    rowsOf(store, 'course_equivalency_members'),
    (row) => row['equivalency'],
  )
    .entries()
    .map(([equivalency, rows]) => [equivalency, rows.map(label)])
    .toArray();
};

const [linked2023, linked2018, ancient] = [
  '2023:true',
  '2018:true',
  '2013:false',
];

const collator = new Intl.Collator('en');

const mutatedCollections = (
  fake: ReturnType<typeof fakeItemsDirectus>,
): readonly string[] =>
  [
    ...new Set(
      fake
        .mutations()
        .map(
          ({ pathname }) => pathname.split('?', 1)[0]?.split('/', 3)[2] ?? '',
        ),
    ),
  ].toSorted((left, right) => collator.compare(left, right));

// A request that fails the second POST batch to the given collection.
const failingAfterFirstBatch = (
  prepared: Prepared,
  collection: string,
): DirectusRequest => {
  const fake = fakeItemsDirectus(prepared.store);
  let posts = 0;
  return (pathname, init) => {
    if (
      init?.method === 'POST' &&
      pathname.startsWith(`/items/${collection}`)
    ) {
      posts += 1;
      if (posts === 2) {
        return Promise.reject(
          new Error('synthetic outage after the first batch'),
        );
      }
    }
    return fake.request(pathname, init);
  };
};

describe('converter steps under the ledger', () => {
  test('writes every target once, keeps old rows and ids, and records a target or provenance for every old row', async () => {
    const prepared = await prepare(uniqueDataset());
    const before = snapshot(prepared.store);
    const originalAssignments = idsOf(prepared.store, 'teaching_assignments');

    const { fake, outcome, sink } = await runSteps(prepared);

    expect(outcome).toEqual({ completed: stepNames, skipped: [] });
    expect(rowsOf(prepared.store, 'curriculum_entries')).toHaveLength(18);
    expect(rowsOf(prepared.store, 'course_curricula')).toHaveLength(12);
    expect(rowsOf(prepared.store, 'academic_years')).toHaveLength(15);
    expect(rowsOf(prepared.store, 'course_enrollment_rules')).toHaveLength(120);
    expect(rowsOf(prepared.store, 'teaching_assignments')).toHaveLength(17);
    expect(sink.written).toEqual({
      academic_years: 15,
      course_curricula: 12,
      course_enrollment_rules: 120,
      course_equivalencies: 6,
      course_equivalency_members: 21,
      curriculum_entries: 18,
      curriculum_entry_program_states: 33,
      curriculum_generations: 3,
      student_council: 3,
      study_programs: 15,
      teaching_assignments: 10,
    });

    assertOriginalsUntouched(prepared.store, before);

    expect(mutatedCollections(fake)).toEqual([
      'academic_years',
      'course_curricula',
      'course_enrollment_rules',
      'course_equivalencies',
      'course_equivalency_members',
      'curriculum_entries',
      'curriculum_entry_program_states',
      'curriculum_generations',
      'migration_ledger',
      'student_council',
      'study_programs',
      'teaching_assignments',
    ]);

    const roleRows = rowsOf(prepared.store, 'teaching_assignments').filter(
      ({ id }) => !originalAssignments.includes(id),
    );

    expect(roleRows).toHaveLength(10);
    expect(
      roleRows.every(
        (row) =>
          row['source_collection'] === 'teaching_assignments' &&
          row['professors'] === null &&
          row['assistants'] === null &&
          typeof row['course_name'] === 'string',
      ),
    ).toBeTruthy();
    expect(
      rowsOf(prepared.store, 'student_council').map((row) => row['student']),
    ).toEqual([1, null, 3, 4]);
    expect(
      rowsOf(prepared.store, 'course_equivalencies').map(
        (row) => row['course'],
      ),
    ).toEqual([1, null, 2, 3, 5, 6, 7, null, null]);

    expect(memberLinks(prepared.store)).toEqual([
      [1, [linked2023, linked2018, ancient]],
      [3, [linked2023, '2018:false']],
      [4, [linked2023, linked2018, ancient]],
      [5, [linked2023, ancient]],
      [6, [linked2023, linked2018]],
      [7, [linked2023, linked2018]],
      [8, [linked2023, linked2018, ancient]],
      [9, ['2023:false', linked2018, ancient]],
      [10, [ancient]],
    ]);
    expect(codes(sink.findings)).toContain('unresolved_staff_text');
  });

  test('records every old row in the ledger id map as a target or a retained relation', async () => {
    const prepared = await prepare(uniqueDataset());

    await runSteps(prepared);

    const map = ledgerMaps(prepared.store);
    const council = entriesOf(map, 'student_council', 'student').map(
      ({ sourceId, status }) => [sourceId, status],
    );
    const assignments = entriesOf(map, 'teaching_assignments')
      .map(({ sourceId }) => Number(sourceId))
      .toSorted((left, right) => left - right);

    expect(entriesOf(map, 'curriculum_2023', 'entry')).toHaveLength(9);
    expect(entriesOf(map, 'curriculum_2018', 'entry')).toHaveLength(9);

    const courseLinks = map.filter(
      ({ sourceCollection, targetCollection }) =>
        sourceCollection === 'courses' &&
        targetCollection === 'course_curricula',
    );

    expect(courseLinks).toHaveLength(13);
    expect(courseLinks.filter(({ status }) => status === 'unresolved')).toEqual(
      [expect.objectContaining({ relation: 'curriculum_2018', sourceId: 3 })],
    );
    expect(council).toEqual([
      [1, 'existing'],
      [2, 'unresolved'],
      [3, 'existing'],
      [4, 'existing'],
    ]);
    expect(assignments).toEqual([1, 1, 3, 3, 4, 5, 6, 7, 7, 8, 8]);
    expect(
      entriesOf(map, 'course_equivalencies').map(({ sourceId }) => sourceId),
    ).toContain(10);
    expect(
      map.every(({ status, targetId }) =>
        status === 'unresolved' ? targetId === null : targetId !== null,
      ),
    ).toBeTruthy();
    expect(map.some(({ status }) => status === 'pending')).toBe(false);
  });

  test('a second run skips every completed step without a write', async () => {
    const prepared = await prepare(uniqueDataset());
    await runSteps(prepared);

    const again = await runSteps(prepared, { runToken: 'run-2' });

    expect(again.outcome).toEqual({ completed: [], skipped: stepNames });
    expect(again.fake.mutations()).toEqual([]);
    expect(rowsOf(prepared.store, ledgerCollection)).toHaveLength(5);
  });
});

describe('converter steps resume', () => {
  test('a failure after the first batch leaves a resumable ledger and the resumed run creates no duplicate', async () => {
    const prepared = await prepare(uniqueDataset());

    await expect(
      runSteps(prepared, {
        batchSize: 5,
        request: failingAfterFirstBatch(prepared, 'curriculum_entries'),
      }),
    ).rejects.toThrow('synthetic outage');
    expect(rowsOf(prepared.store, 'curriculum_entries')).toHaveLength(5);
    expect(
      rowsOf(prepared.store, ledgerCollection).map((row) => [
        row['step'],
        row['status'],
      ]),
    ).toEqual([['curricula', 'failed']]);
    // The generations and programs, then the first batch of entries.
    expect(
      Object.fromEntries(
        Map.groupBy(
          ledgerMap(prepared.store, 'curricula'),
          ({ targetCollection }) => targetCollection,
        )
          .entries()
          .map(([collection, rows]) => [collection, rows.length]),
      ),
    ).toEqual({
      curriculum_entries: 5,
      curriculum_generations: 3,
      study_programs: 15,
    });

    const resumed = await runSteps(prepared, {
      batchSize: 5,
      runToken: 'run-2',
    });
    const provenance = rowsOf(prepared.store, 'curriculum_entries').map(
      (row) =>
        `${String(row['source_collection'])}/${String(row['source_id'])}`,
    );
    const statuses = rowsOf(prepared.store, ledgerCollection).map(
      (row) => row['status'],
    );

    expect(resumed.outcome).toEqual({ completed: stepNames, skipped: [] });
    expect(provenance).toHaveLength(18);
    expect(new Set(provenance).size).toBe(18);
    expect(rowsOf(prepared.store, 'course_curricula')).toHaveLength(12);
    expect(
      ledgerMap(prepared.store, 'curricula').filter(
        ({ relation }) => relation === 'entry',
      ),
    ).toHaveLength(18);
    expect(resumed.sink.written['curriculum_entries']).toBe(13);
    expect(statuses).toHaveLength(5);
    expect(statuses.every((status) => status === 'completed')).toBeTruthy();
  });

  test('a failure inside a later step keeps the earlier steps completed and resumes only that step', async () => {
    const prepared = await prepare(uniqueDataset());

    await expect(
      runSteps(prepared, {
        batchSize: 50,
        request: failingAfterFirstBatch(prepared, 'course_enrollment_rules'),
      }),
    ).rejects.toThrow('synthetic outage');
    expect(rowsOf(prepared.store, 'course_enrollment_rules')).toHaveLength(50);
    expect(
      rowsOf(prepared.store, ledgerCollection).map((row) => [
        row['step'],
        row['status'],
      ]),
    ).toEqual([
      ['curricula', 'completed'],
      ['rules', 'failed'],
    ]);

    const resumed = await runSteps(prepared, {
      batchSize: 50,
      runToken: 'run-2',
    });

    expect(resumed.outcome).toEqual({
      completed: ['rules', 'assignments', 'council', 'equivalencies'],
      skipped: ['curricula'],
    });
    expect(rowsOf(prepared.store, 'course_enrollment_rules')).toHaveLength(120);
    expect(rowsOf(prepared.store, 'academic_years')).toHaveLength(15);
    expect(resumed.sink.written['course_enrollment_rules']).toBe(70);
  });

  test('a duplicate student index that no council row references migrates with every student row retained', async () => {
    const base = uniqueDataset();
    const prepared = await prepare({
      ...base,
      students: [
        ...base.students,
        {
          id: 5,
          index_number: 'SYN-0042',
          name: 'Synthetic Twin A',
          source_group: 'g',
        },
        {
          id: 6,
          index_number: 'SYN-0042',
          name: 'Synthetic Twin B',
          source_group: 'g',
        },
      ],
    });

    expect(prepared.report.blockers).toEqual([]);
    expect(codes(prepared.report.warnings)).toContain(
      'duplicate_student_index',
    );

    const { outcome } = await runSteps(prepared);

    expect(outcome.completed).toEqual(stepNames);
    expect(idsOf(prepared.store, 'students')).toEqual([1, 3, 4, 5, 6]);
  });
});

const rowAt = (rows: readonly FakeItem[], index: number): FakeItem => {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`no role row at ${String(index)}`);
  }
  return row;
};

// Role rows an interrupted run wrote are recognised by their source row
// and role, whatever an editor changed in them before the resumed run.
describe('role rows after an interruption', () => {
  test('a reorder and a resolved review row after an interruption never make the resumed run write a pair twice', async () => {
    const prepared = await prepare(
      withStaff(uniqueDataset(), ['Prof. Abe Alpha', 'Prof. Zed Alpha']),
    );
    const originals = idsOf(prepared.store, 'teaching_assignments');
    const roleRows = () =>
      rowsOf(prepared.store, 'teaching_assignments').filter(
        ({ id }) => !originals.includes(id),
      );

    await expect(
      runSteps(prepared, {
        batchSize: 3,
        request: failingAfterFirstBatch(prepared, 'teaching_assignments'),
      }),
    ).rejects.toThrow('synthetic outage');

    const written = roleRows();

    expect(
      written.map(({ role, sort, source_id, staff }) => [
        source_id,
        role,
        sort,
        staff,
      ]),
    ).toEqual([
      [1, 'professor', 1, 101],
      [1, 'professor', 2, 100],
      [1, 'assistant', 1, null],
    ]);

    // An editor drags the pair into the other order and resolves the
    // review row by hand before the operator resumes.
    const first = rowAt(written, 0);
    const second = rowAt(written, 1);
    const review = rowAt(written, 2);
    Object.assign(first, { sort: 2 });
    Object.assign(second, { sort: 1 });
    Object.assign(review, { staff: 1 });

    const resumed = await runSteps(prepared, {
      batchSize: 3,
      runToken: 'run-2',
    });
    const pairs = roleRows().map(
      ({ role, source_id }) => `${String(source_id)}/${String(role)}`,
    );

    expect(resumed.outcome.completed).toContain('assignments');
    expect(roleRows()).toHaveLength(11);
    expect(pairs.filter((pair) => pair === '1/professor')).toHaveLength(2);
    expect(pairs.filter((pair) => pair === '1/assistant')).toHaveLength(1);
    expect(
      roleRows()
        .filter(({ source_id }) => source_id === 1)
        .map(({ id, role, sort, staff }) => [id, role, sort, staff]),
    ).toEqual([
      [first.id, 'professor', 2, 101],
      [second.id, 'professor', 1, 100],
      [review.id, 'assistant', 1, 1],
    ]);
    expect(
      ledgerMap(prepared.store, 'assignments').filter(
        ({ sourceId, relation }) =>
          sourceId === 1 && relation.startsWith('role:'),
      ),
    ).toEqual([
      expect.objectContaining({
        relation: 'role:assistant:1',
        status: 'existing',
        targetId: review.id,
      }),
      expect.objectContaining({
        relation: 'role:professor:1',
        status: 'existing',
        targetId: first.id,
      }),
      expect.objectContaining({
        relation: 'role:professor:2',
        status: 'existing',
        targetId: second.id,
      }),
    ]);
  });
});
