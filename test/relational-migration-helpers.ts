import { z } from 'zod';

import type { ConverterSink } from '../src/migrations/converter-types.js';

import { converterSteps } from '../src/migrations/converters.js';
import { entryKey } from '../src/migrations/curricula.js';
import { readInventory } from '../src/migrations/inventory.js';
import { ledgerCollection } from '../src/migrations/ledger-claim.js';
import { runLedger } from '../src/migrations/ledger.js';
import { preflight } from '../src/migrations/preflight.js';
import {
  type MigrationReport,
  migrationVersion,
} from '../src/migrations/report.js';
import {
  type SourceMapEntry,
  sourceMapEntrySchema,
} from '../src/migrations/source-map.js';
import {
  academicYears,
  makeSyntheticDataset,
  type SyntheticDataset,
  type SyntheticRow,
} from './fixtures/synthetic-data.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  storeFromDataset,
} from './migration-test-helpers.js';

export const clockValue = '2026-09-22T10:00:00.000Z';
export const fingerprint = 'a'.repeat(64);
export const stepNames = [
  'curricula',
  'rules',
  'assignments',
  'council',
  'equivalencies',
];

// The synthetic dataset without its deliberate duplicates: one curriculum
// row per label, one equivalency label per course, one assignment and one
// pattern per course and year, and one student per index.
export const uniqueDataset = (
  base = makeSyntheticDataset(),
): SyntheticDataset => ({
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

export const staffRow = (id: number, name: string): SyntheticRow => ({
  id,
  name,
  active: true,
  title: null,
  position: null,
  email: null,
  cabinet: null,
  profile: null,
  courses: null,
  consultations: null,
});

export const withStaff = (
  dataset: SyntheticDataset,
  names: readonly string[],
): SyntheticDataset => ({
  ...dataset,
  staff: [
    ...dataset.staff,
    ...names.map((name, index) => staffRow(100 + index, name)),
  ],
});

export const withAssignment = (
  dataset: SyntheticDataset,
  row: SyntheticRow,
): SyntheticDataset => ({
  ...dataset,
  teaching_assignments: [...dataset.teaching_assignments, row],
});

export type Prepared = {
  readonly checkpoint: Awaited<ReturnType<typeof readInventory>>['checkpoint'];
  readonly report: MigrationReport;
  readonly store: FakeStore;
};

// An installed fake store over the dataset, its inventory and the
// preflight report whose candidates the converters consume.
export const prepare = async (dataset: SyntheticDataset): Promise<Prepared> => {
  const store = storeFromDataset(dataset, { installed: true });
  const { request } = fakeItemsDirectus(store);
  const inventory = await readInventory(request, {});
  return {
    checkpoint: inventory.checkpoint,
    report: preflight(inventory, null),
    store,
  };
};

export const none: ReadonlyMap<string, number> = new Map();

// Every entry keyed by provenance with a synthetic target id, as the
// curricula step hands the link converter after creating the entries.
export const entryIdsOf = (
  checkpoint: Prepared['checkpoint'],
): Map<string, number> =>
  new Map([
    ...checkpoint.curriculum_2023.map((row, index): [string, number] => [
      entryKey('curriculum_2023', row.id),
      1_000 + index,
    ]),
    ...checkpoint.curriculum_2018.map((row, index): [string, number] => [
      entryKey('curriculum_2018', row.id),
      2_000 + index,
    ]),
  ]);

export const yearIdsOf = (): Map<string, number> =>
  new Map(academicYears.map((label, index) => [label, 500 + index]));

const byText = (left: string, right: string): number =>
  left.localeCompare(right);

export const codes = (
  findings: ReadonlyArray<{ readonly code: string }>,
): readonly string[] => findings.map(({ code }) => code).toSorted(byText);

export const count = (
  findings: ReadonlyArray<{ readonly code: string }>,
  code: string,
): number => findings.filter((finding) => finding.code === code).length;

export const rowsOf = (store: FakeStore, collection: string) =>
  store.items.get(collection) ?? [];

export const idsOf = (store: FakeStore, collection: string) =>
  rowsOf(store, collection).map(({ id }) => id);

export const scalarsOf = (
  store: FakeStore,
  collection: string,
  fields: readonly string[],
) =>
  rowsOf(store, collection).map((row) =>
    Object.fromEntries(fields.map((field) => [field, row[field]])),
  );

export const sinkOf = (): ConverterSink => ({ findings: [], written: {} });

export type RunOptions = {
  readonly batchSize?: number;
  readonly request?: Parameters<typeof runLedger>[0];
  readonly runToken?: string;
};

// Runs the five converter steps under the ledger against the prepared
// store, optionally through a wrapped request and with a smaller batch.
export const runSteps = async (
  prepared: Prepared,
  options: RunOptions = {},
) => {
  const fake = fakeItemsDirectus(prepared.store);
  const sink = sinkOf();
  const inventory = await readInventory(fake.request, {});
  const outcome = await runLedger(options.request ?? fake.request, {
    now: () => clockValue,
    resume: false,
    runToken: options.runToken ?? 'run-1',
    sourceFingerprint: fingerprint,
    steps: converterSteps(inventory, prepared.report, {
      batchSize: options.batchSize ?? 250,
      sink,
    }),
    version: migrationVersion,
  });
  return { fake, outcome, sink };
};

const idMapSchema = z.array(sourceMapEntrySchema);

export const ledgerMap = (
  store: FakeStore,
  step: string,
): readonly SourceMapEntry[] =>
  idMapSchema.parse(
    rowsOf(store, ledgerCollection).find((row) => row['step'] === step)?.[
      'id_map'
    ] ?? [],
  );
