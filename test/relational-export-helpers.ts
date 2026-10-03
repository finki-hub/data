import { z } from 'zod';

import type {
  ExportDefinition,
  RowContext,
  SourceRead,
} from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type { FakeItem, FakeStore } from './store-test-helpers.js';

import {
  fileKeys,
  readFileSources,
  serializeFile,
  type SourceReader,
  validateFile,
} from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import { findModelCollection } from '../src/data-model/collections.js';
import { aliasesFor, findModelRelation } from '../src/data-model/relations.js';
import { importWorkbook } from '../src/import-workbook.js';
import {
  courseNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import { lifecycleDataset } from './fixtures/synthetic-workbook.js';
import { planOf } from './import-plan-helpers.js';
import { emptyStore, fakeImportDirectus } from './import-test-helpers.js';

// The two places the committed lifecycle files (the lifecycle dataset as
// today's files publish it) differ from the parity ones.
type ReviewItems = {
  // The duplicate assignment row of Alpha, which the published file never
  // listed: the import refuses it (duplicate_assignment) until the operator
  // removes the row.
  readonly duplicateAssignment?: boolean;
  // Gamma's 2018 availability of FALSE without any 2018 name, which the
  // committed lifecycle file publishes: it holds no value the relational
  // model keeps (owner decision 2026-09-29), so the import links no 2018
  // curriculum and courses.json omits the key, as for an empty cell.
  readonly gammaAvailability?: boolean;
};

// The lifecycle dataset, by default as the committed parity files state
// it: the duplicate row removed, Gamma's 2018 availability cleared.
export const parityDataset = ({
  duplicateAssignment = false,
  gammaAvailability = false,
}: ReviewItems = {}): SyntheticDataset => {
  const base = lifecycleDataset();
  return {
    ...base,
    courses: gammaAvailability
      ? base.courses
      : base.courses.map((course) =>
          course['name'] === courseNames.gamma
            ? { ...course, available_2018: null }
            : course,
        ),
    teaching_assignments: duplicateAssignment
      ? base.teaching_assignments
      : base.teaching_assignments.filter((row) => row.id !== 2),
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

// The relational rows of a dataset: the workbook import of it into an
// empty fake project, with the count rows its rules produce. A dataset
// the import refuses fails here.
export const importedStore = async (
  dataset: SyntheticDataset = parityDataset(),
): Promise<FakeStore> => {
  const plan = planOf(dataset);
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

export const edit = (
  store: FakeStore,
  collection: string,
  change: (rows: FakeItem[]) => FakeItem[],
): FakeStore => {
  store.items.set(collection, change(rowsOf(store, collection)));
  return store;
};

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

const relatedCollection = (collection: string, field: string): string => {
  const relation = findModelRelation(collection, field);
  if (relation === undefined) {
    throw new Error(`${collection}.${field} is no M2O relation`);
  }
  return relation.related;
};

const record = z.record(z.string(), z.unknown());
const operators = z
  .strictObject({
    _empty: z.literal(true),
    _eq: z.unknown(),
    _in: z.array(z.unknown()),
    _neq: z.unknown(),
    _nempty: z.literal(true),
    _nin: z.array(z.unknown()),
    _nnull: z.literal(true),
    _null: z.literal(true),
  })
  .partial();

const present = (value: unknown): boolean =>
  value !== null && value !== undefined;

// A field condition the way PostgreSQL answers it: a comparison with NULL
// is never true.
const holds = (value: unknown, test: z.infer<typeof operators>): boolean =>
  (test._eq === undefined || (present(value) && value === test._eq)) &&
  (test._neq === undefined || (present(value) && value !== test._neq)) &&
  (test._in === undefined || test._in.includes(value)) &&
  (test._nin === undefined || (present(value) && !test._nin.includes(value))) &&
  (test._nnull === undefined || present(value)) &&
  (test._null === undefined || !present(value)) &&
  (test._empty === undefined || !present(value) || value === '') &&
  (test._nempty === undefined || (present(value) && value !== ''));

type Place = { readonly collection: string; readonly store: FakeStore };

// A row of a store, or the all-NULL row of a LEFT JOIN without a match.
type Candidate = Readonly<Record<string, unknown>>;

const linked = (place: Place, row: Candidate, field: string) => {
  const target = relatedCollection(place.collection, field);
  const found = rowsOf(place.store, target).find(({ id }) => id === row[field]);
  return { found, place: { collection: target, store: place.store } };
};

// The rows an O2M or M2M alias of the row lists (for an M2M, its junction
// rows), in id order, or null when `field` is no alias.
const aliased = (place: Place, row: Candidate, field: string) => {
  const model = findModelCollection(place.collection);
  const declaration =
    model === undefined
      ? undefined
      : aliasesFor(model.collection).find(({ alias }) => alias.field === field);
  if (declaration === undefined) {
    return null;
  }
  const { collection, field: parent } = declaration.relation;
  return {
    place: { collection, store: place.store },
    rows: rowsOf(place.store, collection)
      .filter((candidate) => candidate[parent] === row['id'])
      .toSorted((left, right) => Number(left.id) - Number(right.id)),
  };
};

// The filters the definitions, the readiness registry and its review
// views use: _and, _or, plain operators, M2O paths and O2M paths. An O2M
// path is a LEFT JOIN the way Directus runs it: the row matches when one
// of its related rows does, or, without any, when an all-NULL row would.
const matches = (place: Place, row: Candidate, filter: unknown): boolean =>
  Object.entries(record.parse(filter ?? {})).every(([key, test]) => {
    if (key === '_and' || key === '_or') {
      const inner = z.array(z.unknown()).parse(test);
      const holdsFor = (part: unknown) => matches(place, row, part);
      return key === '_and' ? inner.every(holdsFor) : inner.some(holdsFor);
    }
    const condition = operators.safeParse(test);
    if (condition.success) {
      return holds(row[key], condition.data);
    }
    const listed = aliased(place, row, key);
    if (listed !== null) {
      const joined = listed.rows.length === 0 ? [{ id: null }] : listed.rows;
      return joined.some((item) => matches(listed.place, item, test));
    }
    const { found, place: next } = linked(place, row, key);
    return found !== undefined && matches(next, found, test);
  });

// The explicit fields of a row the way Directus answers them: `a.b`
// follows the M2O relation a and answers { a: { b } }, null without a row;
// through an O2M or M2M alias a it answers { a: [{ b }, ...] }.
const pick = (
  place: Place,
  row: FakeItem,
  paths: readonly string[],
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  const nested = new Map<string, string[]>();
  for (const path of paths) {
    const [head = '', ...rest] = path.split('.');
    if (rest.length === 0) {
      output[head] = row[head] ?? null;
    } else {
      nested.set(head, [...(nested.get(head) ?? []), rest.join('.')]);
    }
  }
  for (const [head, rest] of nested) {
    const listed = aliased(place, row, head);
    if (listed !== null) {
      output[head] = listed.rows.map((item) => pick(listed.place, item, rest));
      continue;
    }
    const { found, place: next } = linked(place, row, head);
    output[head] = found === undefined ? null : pick(next, found, rest);
  }
  return output;
};

// PostgreSQL's order: NULL sorts last ascending and first descending.
const compare = (left: unknown, right: unknown): number => {
  if (!present(left) || !present(right)) {
    return Number(!present(left)) - Number(!present(right));
  }
  return typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right));
};

const descending = /^-/u;

// The rows in the order of a sort list (`-field` descending).
const sorted = (rows: FakeItem[], sort: readonly string[]): FakeItem[] =>
  rows.toSorted((left, right) => {
    for (const entry of sort) {
      const field = entry.replace(descending, '');
      const direction = entry.startsWith('-') ? -1 : 1;
      const order = compare(left[field], right[field]) * direction;
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });

// The one row an aggregate read answers, as Directus does: the count as
// text under the aggregate and its field.
const aggregated = (read: SourceRead, rows: readonly FakeItem[]) => {
  const [field = 'id'] = read.fields;
  const values = rows.map((row) => row[field]).filter(present);
  const count =
    read.aggregate === 'countDistinct' ? new Set(values).size : values.length;
  return [{ [read.aggregate ?? 'count']: { [field]: String(count) } }];
};

// A reader over a fake store that honours every read exactly as the
// ItemsService would: the filter, the sort, only the listed fields, and
// aggregate reads. Every read it answers is logged.
export const storeReader =
  (store: FakeStore, log: SourceRead[] = []): SourceReader =>
  async (read) => {
    log.push(read);
    const place = { collection: read.collection, store };
    const rows = rowsOf(store, read.collection).filter((row) =>
      matches(place, row, read.filter),
    );
    if (read.aggregate !== undefined) {
      return aggregated(read, rows);
    }
    return sorted(rows, read.sort).map((row) => pick(place, row, read.fields));
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
    const file = validateFile(definition, serializeFile(definition, sources), {
      keys: fileKeys(definition, sources),
      rows: sources.rows.length,
    });
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
      { keys: fileKeys(definition, sources), rows: sources.rows.length },
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
