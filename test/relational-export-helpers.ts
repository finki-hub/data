import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileFunction, createContext } from 'node:vm';
import { z } from 'zod';

import type {
  ExportDefinition,
  RowContext,
  SourceRead,
} from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';
import type { FakeItem, FakeStore } from './migration-test-helpers.js';

import {
  fileKeys,
  readFileSources,
  serializeFile,
  type SourceReader,
  validateFile,
} from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import { deriveCourses } from '../directus/extensions/directus-extension-rebuild-derived-data/derive.js';
import { findModelRelation } from '../src/data-model/relations.js';
import {
  courseNames,
  type SyntheticDataset,
  toCourseSources,
} from './fixtures/synthetic-data.js';
import { lifecycleDataset } from './fixtures/synthetic-workbook.js';
import { prepare, rowsOf, runSteps } from './relational-migration-helpers.js';

type ModuleShell = { exports: unknown };
type Loader = (module: ModuleShell) => void;

const isLoader = (value: unknown): value is Loader =>
  typeof value === 'function';

const isFunction = (value: unknown): value is (data: unknown) => unknown =>
  typeof value === 'function';

// The reference public contract: the checkpoint serializer, unchanged.
export const referenceSource = await readFile(
  join(import.meta.dirname, '..', 'directus', 'flows', 'serialize-assets.cjs'),
  'utf8',
);

// Compiles the reference the way the Run Script operation isolates it: a
// CommonJS-style body in a fresh context that sees a module shell only.
const moduleOf = (source: string): unknown => {
  const loader: unknown = compileFunction(source, ['module'], {
    parsingContext: createContext({}),
  });
  if (!isLoader(loader)) {
    throw new TypeError('The script did not compile to a loader');
  }
  const shell: ModuleShell = { exports: null };
  loader(shell);
  return shell.exports;
};

// Named top-level constants of the reference, read by appending an export.
export const referenceConstants = (names: readonly string[]): unknown =>
  structuredClone(
    moduleOf(`${referenceSource}\nmodule.exports = { ${names.join(', ')} };`),
  );

const assetsSchema = z.strictObject({
  courses: z.array(z.record(z.string(), z.string())),
  rooms: z.array(z.record(z.string(), z.string())),
  staff: z.array(z.record(z.string(), z.string())),
  students: z.array(z.record(z.string(), z.string())),
});

export type Assets = z.infer<typeof assetsSchema>;

type LegacyInput = Readonly<
  Record<'courses' | 'rooms' | 'staff' | 'students', readonly unknown[]>
>;

// The four files the checkpoint Publish public assets Flow publishes from
// the checkpoint rows of a dataset.
export const legacyAssets = (dataset: LegacyInput): Assets => {
  const serialize = moduleOf(referenceSource);
  if (!isFunction(serialize)) {
    throw new TypeError('serialize-assets.cjs must export a function');
  }
  return assetsSchema.parse(
    structuredClone(
      serialize({
        read_courses: dataset.courses,
        read_rooms: dataset.rooms,
        read_staff: dataset.staff,
        read_students: dataset.students,
      }),
    ),
  );
};

// The legacy files of a dataset whose source columns were changed: the
// checkpoint derivation recomputes the derived course columns first, as the
// checkpoint Rebuild Flow did before every publication.
export const derivedLegacyAssets = async (
  dataset: SyntheticDataset,
): Promise<Assets> => {
  const derived = await deriveCourses(toCourseSources(dataset));
  const updates = new Map(derived.map((update) => [update['id'], update]));
  return legacyAssets({
    ...dataset,
    courses: dataset.courses.map((course) => ({
      ...course,
      ...updates.get(course.id),
    })),
  });
};

// The two review items of the importable lifecycle dataset whose
// relational representation would change the published text; readiness
// blocks on each until an editor resolves it.
type ReviewItems = {
  // The duplicate assignment row of Alpha the checkpoint derivation never
  // displayed (assignment_source_duplicate).
  readonly duplicateAssignment?: boolean;
  // Gamma's 2018 availability, a value without any 2018 curriculum that no
  // course_curricula link holds (curriculum_value_unlinked).
  readonly gammaAvailability?: boolean;
};

// The importable lifecycle dataset, by default with both review items
// resolved as an editor would: the duplicate row removed, Gamma's 2018
// availability cleared.
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

// The count rows the legacy rule Flows install: each Moodle user whose raw
// history matches the rule's pattern (Unicode mode) counts once.
const countRows = (store: FakeStore): FakeItem[] => {
  const histories = rowsOf(store, 'moodle_users').flatMap((user) =>
    typeof user['Courses'] === 'string' ? [user['Courses']] : [],
  );
  return rowsOf(store, 'course_enrollment_rules').map((rule, index) => {
    const parsed = pattern.parse(rule);
    const matcher = new RegExp(parsed.pattern, 'u');
    return {
      academic_year: parsed.academic_year,
      computed_revision: 1,
      count: histories.filter((history) => matcher.test(history)).length,
      course: parsed.course,
      id: index + 1,
    };
  });
};

// The relational rows of a dataset: the checkpoint rows converted by the
// migration converters into a fake store, with the count rows its rules
// produce.
export const convertedStore = async (
  dataset: SyntheticDataset = parityDataset(),
): Promise<FakeStore> => {
  const prepared = await prepare(dataset);
  const { outcome } = await runSteps(prepared);
  if (outcome.completed.length !== 5) {
    throw new Error('The conversion did not complete');
  }
  prepared.store.items.set('course_enrollments', countRows(prepared.store));
  return prepared.store;
};

export const edit = (
  store: FakeStore,
  collection: string,
  change: (rows: FakeItem[]) => FakeItem[],
): FakeStore => {
  store.items.set(collection, change(rowsOf(store, collection)));
  return store;
};

// What an editor does to publish an unmatched label as before: a
// curriculum entry of the generation carrying the label, linked to the
// course with the course's imported credits and availability.
export const withLinkedLabel = (
  store: FakeStore,
  course: number,
  generation: '2018' | '2023',
): FakeStore => {
  const row = rowsOf(store, 'courses').find(({ id }) => id === course);
  edit(store, 'curriculum_entries', (rows) => [
    ...rows,
    { generation, id: 900, name: unmatchedLabel },
  ]);
  return edit(store, 'course_curricula', (rows) => [
    ...rows,
    {
      available: row?.[`available_${generation}`] ?? null,
      course,
      credits: row?.[`credits_${generation}`] ?? null,
      entry: 900,
      generation,
      id: 900,
      sort: generation === '2023' ? 1 : 2,
    },
  ]);
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
    _eq: z.unknown(),
    _in: z.array(z.unknown()),
    _neq: z.unknown(),
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
  (test._nnull === undefined || present(value)) &&
  (test._null === undefined || !present(value));

type Place = { readonly collection: string; readonly store: FakeStore };

const linked = (place: Place, row: FakeItem, field: string) => {
  const target = relatedCollection(place.collection, field);
  const found = rowsOf(place.store, target).find(({ id }) => id === row[field]);
  return { found, place: { collection: target, store: place.store } };
};

// The filters the definitions and the readiness registry use: _and, _or,
// plain operators and M2O paths.
const matches = (place: Place, row: FakeItem, filter: unknown): boolean =>
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
    const { found, place: next } = linked(place, row, key);
    return found !== undefined && matches(next, found, test);
  });

// The explicit fields of a row the way Directus answers them: `a.b`
// follows the M2O relation a and answers { a: { b } }, null without a row.
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
// with fields ['*'] would hand private columns to the serializer.
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
