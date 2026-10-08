import type { PlannedCollection } from '../import/planned.js';

import { findModelCollection } from '../data-model/collections.js';
import { recordId, resolved } from '../import/write.js';

// The relational rows of an import plan held in memory, as the database
// would hold them after the one-time import: what the export engine reads
// when the live check projects the public files without a Directus.

// A stored row: its id and its columns.
export type MemoryRow = Readonly<Record<string, unknown>> & {
  readonly id: number | string;
};

// The rows of each collection, by collection name. A collection the store
// does not hold reads as empty.
export type MemoryStore = {
  readonly items: ReadonlyMap<string, readonly MemoryRow[]>;
};

// Every column the model declares for a collection, at its default, or
// null without one, as the database fills a column an insert leaves out.
const columnDefaults = (collection: string): Record<string, unknown> =>
  Object.fromEntries(
    (findModelCollection(collection)?.fields ?? []).map((field) => [
      field.field,
      field.kind === 'm2o' ? null : (field.defaultValue ?? null),
    ]),
  );

// A row as the database stores it: the given columns over every model
// column's default, with its id.
export const storedRow = (
  collection: string,
  columns: Readonly<Record<string, unknown>>,
  id: number,
): MemoryRow => ({ ...columnDefaults(collection), ...columns, id });

// The planned collections as stored rows. Ids follow plan order within
// each collection, from 1; every reference is replaced by the id of the
// row it names, which the plan creates earlier, by the resolver the
// import's writer uses (src/import/write.ts).
export const memoryStore = (
  collections: readonly PlannedCollection[],
): MemoryStore => {
  const created = new Map<string, ReadonlyMap<string, number>>();
  const items = new Map<string, readonly MemoryRow[]>();
  for (const { collection, rows } of collections) {
    const ids = new Map<string, number>();
    const stored = rows.map((row, index) => {
      const id = index + 1;
      const columns = resolved(collection, row.record, created);
      recordId(ids, { collection, key: row.key }, id);
      return storedRow(collection, columns, id);
    });
    created.set(collection, ids);
    items.set(collection, stored);
  }
  return { items };
};

// The store with the rows of one collection replaced.
export const withRows = (
  store: MemoryStore,
  collection: string,
  rows: readonly MemoryRow[],
): MemoryStore => ({
  items: new Map([...store.items, [collection, rows]]),
});
