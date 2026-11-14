import { z } from 'zod';

import type { SourceReader } from '../directus/extensions/directus-extension-data-operations/src/exports/engine.js';
import type { SourceRead } from '../directus/extensions/directus-extension-data-operations/src/exports/types.js';

import { findModelCollection } from '../src/data-model/collections.js';
import { aliasesFor, findModelRelation } from '../src/data-model/relations.js';

// A stored row: its id and its columns.
export type MemoryRow = Readonly<Record<string, unknown>> & {
  readonly id: number | string;
};

// The rows of each collection, by collection name. A collection the store
// does not hold reads as empty.
export type MemoryStore = {
  readonly items: ReadonlyMap<string, readonly MemoryRow[]>;
};

// The export engine's reader over a memory store: it answers every read
// of the export definitions as the ItemsService of Directus would answer
// it over the same rows.

const rowsOf = (store: MemoryStore, collection: string) =>
  store.items.get(collection) ?? [];

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
    _nempty: z.literal(true),
    _neq: z.unknown(),
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

type Place = { readonly collection: string; readonly store: MemoryStore };

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
  row: MemoryRow,
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
const sorted = (
  rows: readonly MemoryRow[],
  sort: readonly string[],
): MemoryRow[] =>
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
const aggregated = (read: SourceRead, rows: readonly MemoryRow[]) => {
  const [field = 'id'] = read.fields;
  const values = rows.map((row) => row[field]).filter(present);
  const count =
    read.aggregate === 'countDistinct' ? new Set(values).size : values.length;
  return [{ [read.aggregate ?? 'count']: { [field]: String(count) } }];
};

// A reader over a memory store that honours every read exactly as the
// ItemsService would: the filter, the sort, only the listed fields, and
// aggregate reads. Every read it answers is logged.
export const storeReader =
  (store: MemoryStore, log: SourceRead[] = []): SourceReader =>
  async (read) => {
    log.push(read);
    // Answered on a later turn, as a request to Directus is.
    await Promise.resolve();
    const place = { collection: read.collection, store };
    const rows = rowsOf(store, read.collection).filter((row) =>
      matches(place, row, read.filter),
    );
    if (read.aggregate !== undefined) {
      return aggregated(read, rows);
    }
    return sorted(rows, read.sort).map((row) => pick(place, row, read.fields));
  };
