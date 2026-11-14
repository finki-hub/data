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
import parityRows from './fixtures/stores/parity.json' with { type: 'json' };

// A label no curriculum row of either generation carries.
export const unmatchedLabel = 'Synthetic Label Without Entry';

export const rowsOf = (store: FakeStore, collection: string) =>
  store.items.get(collection) ?? [];

// The relational rows of the parity fixture, as the one-time workbook
// import wrote them (test/fixtures/stores/parity.json): a fresh copy per
// call, so a test may edit it.
export const importedStore = (): Promise<FakeStore> => {
  const rows = z
    .record(z.string(), z.array(z.looseObject({ id: z.number() })))
    .parse(structuredClone(parityRows));
  return Promise.resolve({
    items: new Map(Object.entries(rows).map(([key, list]) => [key, list])),
  });
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
