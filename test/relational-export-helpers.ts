import { z } from 'zod';

import type {
  ExportDefinition,
  RowContext,
  SourceRead,
} from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type { FakeItem, FakeStore } from './store-test-helpers.js';

import {
  readFileSources,
  serializeFile,
  type SourceReader,
} from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import {
  fileShape,
  validateFile,
} from '../directus/extensions/directus-extension-data-operations/src/exports/file-check.js';
import { importWorkbook } from '../src/import-workbook.js';
import { type ImportPlan, planImport } from '../src/import/plan.js';
import { readWorkbookContent } from '../src/workbook.js';
import {
  courseNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  reloaded,
  syntheticWorkbook,
} from './fixtures/synthetic-workbook.js';
import { planOf } from './import-plan-helpers.js';
import { emptyStore, fakeImportDirectus } from './import-test-helpers.js';

// The lifecycle dataset as the committed parity files state it: one
// teaching row per course (the lifecycle dataset's second Alpha row, which
// the import ignores with a duplicate_assignment warning, removed). Gamma
// keeps its 2018 availability of FALSE without a 2018 name, which links
// nothing: Gamma publishes "2018-available" FALSE, as for an empty cell.
export const parityDataset = (): SyntheticDataset => {
  const base = lifecycleDataset();
  return {
    ...base,
    teaching_assignments: base.teaching_assignments.filter(
      (row) => row.id !== 2,
    ),
  };
};

// A label no curriculum row of either generation carries.
export const unmatchedLabel = 'Synthetic Label Without Entry';

// Iota's 2023 name changed to a label no 2023 curriculum row carries.
export const renamedCurrent = (
  dataset: SyntheticDataset,
): SyntheticDataset => ({
  ...dataset,
  courses: dataset.courses.map((course) =>
    course['name'] === courseNames.iota
      ? { ...course, name_2023: unmatchedLabel }
      : course,
  ),
});

// Zeta's equivalency pointed at a 2018 label no 2018 curriculum row
// carries.
export const unmatchedLegacy = (
  dataset: SyntheticDataset,
): SyntheticDataset => ({
  ...dataset,
  course_equivalencies: dataset.course_equivalencies.map((row) =>
    row['course_2023'] === courseNames.zeta
      ? { ...row, course_2018: unmatchedLabel }
      : row,
  ),
});

const pattern = z.object({
  academic_year: z.number(),
  course: z.number(),
  mode: z.literal('legacy_regex'),
  pattern: z.string(),
});

export const rowsOf = (store: FakeStore, collection: string) =>
  store.items.get(collection) ?? [];

// How many raw histories a legacy pattern matches, compiled once in
// Unicode mode as the legacy rule Flows compile it: each Moodle user
// counts once however often the history lists the entry.
export const matchingHistories = (
  rulePattern: string,
  histories: readonly unknown[],
): number => {
  const matcher = new RegExp(rulePattern, 'u');
  return histories.filter(
    (history) => typeof history === 'string' && matcher.test(history),
  ).length;
};

// The count rows the legacy rule Flows install for every rule of a store.
const countRows = (store: FakeStore): FakeItem[] => {
  const histories = rowsOf(store, 'moodle_users').map(
    (user) => user['Courses'],
  );
  return rowsOf(store, 'course_enrollment_rules').map((rule, index) => {
    const parsed = pattern.parse(rule);
    return {
      academic_year: parsed.academic_year,
      computed_revision: 1,
      count: matchingHistories(parsed.pattern, histories),
      course: parsed.course,
      id: index + 1,
    };
  });
};

// The relational rows of an import plan: the workbook import of it into an
// empty fake project, with the count rows its rules produce. A plan with
// blockers fails here.
const plannedStore = async (plan: ImportPlan): Promise<FakeStore> => {
  if (plan.blockers.length > 0) {
    throw new Error(
      `The import refuses the dataset: ${plan.blockers.map(({ code }) => code).join(', ')}`,
    );
  }
  const fake = fakeImportDirectus(emptyStore());
  await importWorkbook(fake.request, plan.collections, fake.io);
  fake.store.items.set('course_enrollments', countRows(fake.store));
  return fake.store;
};

// The relational rows of a dataset, planned from the rows the reader would
// read from it.
export const importedStore = (
  dataset: SyntheticDataset = parityDataset(),
): Promise<FakeStore> => plannedStore(planOf(dataset));

// The relational rows of the workbook written from a dataset, saved and
// read back as the import reads a file, with that workbook. Columns the
// reader does not read (Ниво) are written and reach no row.
export const workbookStore = async (dataset: SyntheticDataset) => {
  const workbook = await reloaded(syntheticWorkbook(dataset));
  const store = await plannedStore(planImport(readWorkbookContent(workbook)));
  return { store, workbook };
};

export const edit = (
  store: FakeStore,
  collection: string,
  change: (rows: FakeItem[]) => FakeItem[],
): FakeStore => {
  store.items.set(collection, change(rowsOf(store, collection)));
  return store;
};

// The store with the values set on one row of a collection.
export const withValues = (
  store: FakeStore,
  { collection, id }: { readonly collection: string; readonly id: number },
  values: Readonly<Record<string, unknown>>,
): FakeStore =>
  edit(store, collection, (rows) =>
    rows.map((row) => (row.id === id ? { ...row, ...values } : row)),
  );

// The id of the generation row of a code.
export const generationIdOf = (store: FakeStore, code: string): number => {
  const id = rowsOf(store, 'curriculum_generations').find(
    (row) => row['code'] === code,
  )?.id;
  if (typeof id !== 'number') {
    throw new TypeError(`The store holds no generation ${code}`);
  }
  return id;
};

// What publishing a label no curriculum row carries takes: a curriculum
// entry of the generation carrying the label, to which the course's link
// of that generation is pointed, its credits and availability kept.
export const withLinkedLabel = (
  store: FakeStore,
  course: number,
  code: '2018' | '2023',
): FakeStore => {
  const generation = generationIdOf(store, code);
  edit(store, 'curriculum_entries', (rows) => [
    ...rows,
    { generation, id: 900, name: unmatchedLabel },
  ]);
  return edit(store, 'course_curricula', (rows) =>
    rows.map((row) =>
      row['course'] === course && row['generation'] === generation
        ? { ...row, entry: 900 }
        : row,
    ),
  );
};

const rowList = z.array(z.record(z.string(), z.unknown()));

// A reader whose rows come back in reverse order.
export const reversed =
  (reader: SourceReader): SourceReader =>
  async (read) => {
    const rows = await reader(read);
    return rows.toReversed();
  };

// A reader that adds the given columns to every row it answers, as a read
// with fields ['*'] would hand private columns to the export engine.
export const injecting =
  (reader: SourceReader, columns: Readonly<Record<string, unknown>>) =>
  async (read: SourceRead): Promise<readonly unknown[]> => {
    const rows = rowList.parse(await reader(read));
    return rows.map((row) => ({ ...row, ...columns }));
  };

const jsonSuffix = /\.json$/u;

// Every file of the definitions, parsed back from its validated body and
// keyed by its name without `.json`.
export const engineAssets = async (
  definitions: readonly ExportDefinition[],
  reader: SourceReader,
): Promise<Record<string, unknown>> => {
  const files: Record<string, unknown> = {};
  for (const definition of definitions) {
    const sources = await readFileSources(definition, reader);
    const file = validateFile(
      definition,
      serializeFile(definition, sources),
      fileShape(definition, sources),
    );
    files[definition.filename.replace(jsonSuffix, '')] = rowList.parse(
      JSON.parse(file.body),
    );
  }
  return files;
};

// Every file of the definitions as the engine publishes it: the exact
// compact JSON body and its sha256, keyed by its name without `.json`.
export const publishedFiles = async (
  definitions: readonly ExportDefinition[],
  reader: SourceReader,
): Promise<Record<string, { body: string; sha256: string }>> => {
  const files: Record<string, { body: string; sha256: string }> = {};
  for (const definition of definitions) {
    const sources = await readFileSources(definition, reader);
    const { body, sha256 } = validateFile(
      definition,
      serializeFile(definition, sources),
      fileShape(definition, sources),
    );
    files[definition.filename.replace(jsonSuffix, '')] = { body, sha256 };
  }
  return files;
};

// The refusal message of a run that must refuse.
export const refusalOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return z.object({ code: z.string(), message: z.string() }).parse(error);
  }
  throw new Error('The run answered instead of refusing');
};

// A fifth file declared in the test alone: the room names and capacities,
// without touching the engine, a Flow or the schema.
export const roomCapacity: ExportDefinition = {
  fields: [
    { key: 'room', rule: 'text', value: 'name' },
    { key: 'seats', rule: 'number', value: 'capacity' },
    {
      key: 'large',
      rule: 'boolean',
      value: ({ row }: RowContext) =>
        typeof row['capacity'] === 'number' ? row['capacity'] >= 20 : null,
    },
  ],
  filename: 'room-capacity.json',
  maxBytes: 4_096,
  orderBy: 'id',
  related: {},
  rows: {
    collection: 'rooms',
    fields: ['id', 'name', 'capacity'],
    sort: ['id'],
  },
};
