import type { SyntheticDataset } from './fixtures/synthetic-data.js';

import { findModelCollection } from '../src/data-model/collections.js';
import { compositeKeys } from '../src/data-model/relations.js';
import {
  type DirectusRequest,
  DirectusRequestError,
} from '../src/directus-request.js';
import { relationalCollectionKeys } from '../src/schema.js';

export type FakeItem = Record<string, unknown> & {
  readonly id: number | string;
};

export type FakeStore = {
  readonly flows: FakeItem[];
  readonly items: Map<string, FakeItem[]>;
  // The largest page the server hands out, like QUERY_LIMIT_MAX; null
  // means the requested limit is honoured.
  readonly limitMax: null | number;
  readonly operations: FakeItem[];
};

export type RecordedCall = {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
};

const listPattern = /^\/(?<target>items\/[^/?]+|flows|operations)(?:\?|$)/u;
const singlePattern = /^\/items\/(?<collection>[^/?]+)\/(?<id>\d+)(?:\?|$)/u;
const fieldsPattern = /^\/fields\/(?<collection>[^/?]+)(?:\?|$)/u;
const collator = new Intl.Collator('en', { numeric: true });

const failure = (
  status: number,
  code: string,
  message: string,
): DirectusRequestError =>
  new DirectusRequestError(message, { code, reason: message, status });

const forbidden = (what: string): DirectusRequestError =>
  failure(
    403,
    'FORBIDDEN',
    `You don't have permission to access ${what} or it does not exist.`,
  );

// The columns `npm run setup` adds to an adopted checkpoint collection (the
// nullable link and provenance columns of the relational model), null on
// every existing row as the database leaves them.
const adopted = (collection: string, row: FakeItem): FakeItem => {
  const fields = findModelCollection(collection)?.fields ?? [];
  const additions = fields
    .filter(({ field }) => !Object.hasOwn(row, field))
    .map(({ field }): [string, null] => [field, null]);
  return { ...row, ...Object.fromEntries(additions), id: row.id };
};

// A store holding the checkpoint rows of a dataset; with `installed` the
// relational collections exist (empty) and the checkpoint collections carry
// the relational columns, as they do after `npm run setup`.
export const storeFromDataset = (
  dataset: SyntheticDataset,
  options: { readonly installed?: boolean; readonly limitMax?: number } = {},
): FakeStore => {
  const items = new Map<string, FakeItem[]>();
  for (const [collection, rows] of Object.entries(dataset)) {
    items.set(
      collection,
      rows.map((row) =>
        options.installed === true
          ? adopted(collection, { ...row })
          : { ...row },
      ),
    );
  }
  if (options.installed === true) {
    for (const collection of relationalCollectionKeys) {
      items.set(collection, []);
    }
  }
  return {
    flows: [],
    items,
    limitMax: options.limitMax ?? null,
    operations: [],
  };
};

const project = (
  row: FakeItem,
  fields: readonly string[],
  collection: string,
): FakeItem => {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (!Object.hasOwn(row, field)) {
      throw forbidden(`field "${field}" in collection "${collection}"`);
    }
    projected[field] = row[field];
  }
  return { ...projected, id: row.id };
};

type Source = {
  readonly collection: string;
  readonly rows: readonly FakeItem[];
};

const listing = (
  store: FakeStore,
  { collection, rows }: Source,
  search: URLSearchParams,
): readonly FakeItem[] => {
  const fields = (search.get('fields') ?? 'id').split(',');
  const requested = Number(search.get('limit') ?? '100');
  const limit =
    store.limitMax === null ? requested : Math.min(requested, store.limitMax);
  const offset = Number(search.get('offset') ?? '0');
  if (search.get('sort') !== 'id') {
    throw failure(400, 'INVALID_QUERY', 'The fake store only sorts by id');
  }
  return rows
    .toSorted((left, right) =>
      collator.compare(String(left.id), String(right.id)),
    )
    .slice(offset, offset + limit)
    .map((row) => project(row, fields, collection));
};

// The column-backed fields of a collection: the union of its rows' keys,
// as `GET /fields/:collection` would list the columns of the table.
const columnsOf = (
  store: FakeStore,
  collection: string,
): readonly FakeItem[] => {
  const rows = store.items.get(collection);
  if (rows === undefined) {
    throw forbidden(`collection "${collection}"`);
  }
  const columns = new Set(rows.flatMap((row) => Object.keys(row)));
  return [...columns].map((field) => ({
    collection,
    field,
    id: field,
    schema: { name: field },
  }));
};

const parseJson = (init: Parameters<typeof fetch>[1]): unknown => {
  if (typeof init?.body !== 'string') {
    throw failure(400, 'INVALID_PAYLOAD', 'A JSON body is required');
  }
  return JSON.parse(init.body);
};

const asItem = (parsed: unknown): FakeItem => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw failure(400, 'INVALID_PAYLOAD', 'The body must be one object');
  }
  return { ...parsed, id: 0 };
};

const parseBody = (init: Parameters<typeof fetch>[1]): FakeItem =>
  asItem(parseJson(init));

// The domain keys the database enforces: the unique scalar columns the
// model declares and the composite unique keys the constraints migration
// creates. A create or update landing on a taken key fails the way the
// database would, RECORD_NOT_UNIQUE.
const uniqueKeysOf = (collection: string): ReadonlyArray<readonly string[]> => [
  ...(findModelCollection(collection)?.fields ?? []).flatMap((field) =>
    field.kind !== 'm2o' && field.kind !== 'enum' && field.unique === true
      ? [[field.field]]
      : [],
  ),
  ...compositeKeys
    .filter((key) => key.collection === collection && key.kind === 'unique')
    .map(({ columns }) => columns),
];

const assertUnique = (
  collection: string,
  rows: readonly FakeItem[],
  candidate: FakeItem,
): void => {
  for (const columns of uniqueKeysOf(collection)) {
    if (
      columns.some(
        (column) =>
          candidate[column] === null || candidate[column] === undefined,
      )
    ) {
      continue;
    }
    const taken = rows.some(
      (row) =>
        row.id !== candidate.id &&
        columns.every((column) => row[column] === candidate[column]),
    );
    if (taken) {
      throw failure(
        400,
        'RECORD_NOT_UNIQUE',
        `Value for field "${columns.join(', ')}" in collection "${collection}" has to be unique.`,
      );
    }
  }
};

const get = (store: FakeStore, pathname: string): unknown => {
  const search = new URL(pathname, 'https://fake.example').searchParams;
  const single = singlePattern.exec(pathname)?.groups;
  if (single !== undefined) {
    const row = store.items
      .get(single['collection'] ?? '')
      ?.find((item) => item.id === Number(single['id']));
    if (row === undefined) {
      throw forbidden(`item at ${pathname}`);
    }
    return project(
      row,
      (search.get('fields') ?? 'id').split(','),
      single['collection'] ?? '',
    );
  }
  const fieldsCollection = fieldsPattern.exec(pathname)?.groups?.['collection'];
  if (fieldsCollection !== undefined) {
    return columnsOf(store, fieldsCollection);
  }
  const target = listPattern.exec(pathname)?.groups?.['target'];
  if (target === undefined) {
    throw failure(404, 'ROUTE_NOT_FOUND', `Route ${pathname} doesn't exist.`);
  }
  if (target === 'flows') {
    return listing(
      store,
      { collection: 'directus_flows', rows: store.flows },
      search,
    );
  }
  if (target === 'operations') {
    return listing(
      store,
      { collection: 'directus_operations', rows: store.operations },
      search,
    );
  }
  const collection = target.slice('items/'.length);
  const rows = store.items.get(collection);
  if (rows === undefined) {
    throw forbidden(`collection "${collection}"`);
  }
  return listing(store, { collection, rows }, search);
};

const collectionOf = (
  store: FakeStore,
  pathname: string,
): { readonly collection: string; readonly rows: FakeItem[] } => {
  const target = listPattern.exec(pathname)?.groups?.['target'];
  const collection = target?.slice('items/'.length);
  const rows =
    collection === undefined ? undefined : store.items.get(collection);
  if (collection === undefined || rows === undefined) {
    throw forbidden(`collection at ${pathname}`);
  }
  return { collection, rows };
};

const createOne = (
  collection: string,
  rows: FakeItem[],
  body: FakeItem,
): FakeItem => {
  assertUnique(collection, rows, body);
  let nextId = 1;
  for (const row of rows) {
    if (typeof row.id === 'number') {
      nextId = Math.max(nextId, row.id + 1);
    }
  }
  const created = { ...body, id: nextId };
  rows.push(created);
  return created;
};

// `POST /items/:collection` with one object creates one row; with an array
// it creates every row (Directus `createMany`) and returns them all, in
// both cases projected to the requested fields when `fields` is given.
const create = (
  store: FakeStore,
  pathname: string,
  init: Parameters<typeof fetch>[1],
): FakeItem | readonly FakeItem[] => {
  const { collection, rows } = collectionOf(store, pathname);
  const fields = new URL(pathname, 'https://fake.example').searchParams.get(
    'fields',
  );
  const shape = (row: FakeItem): FakeItem =>
    fields === null ? { ...row } : project(row, fields.split(','), collection);
  const parsed = parseJson(init);
  if (Array.isArray(parsed)) {
    return parsed.map((item: unknown) =>
      shape(createOne(collection, rows, asItem(item))),
    );
  }
  return shape(createOne(collection, rows, asItem(parsed)));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Evaluates the `{ field: { _eq: value } }` filters the ledger's fenced
// update uses, exactly as Directus matches the rows to update by query.
const matches = (row: FakeItem, filter: unknown): boolean =>
  isRecord(filter) &&
  Object.entries(filter).every(([field, condition]) => {
    if (!isRecord(condition) || !Object.hasOwn(condition, '_eq')) {
      throw failure(400, 'INVALID_QUERY', `Unsupported filter on ${field}`);
    }
    return row[field] === condition['_eq'];
  });

// `PATCH /items/:collection` with `{ query: { filter }, data }` updates the
// matching rows and returns them; no match returns an empty list.
const updateByQuery = (
  store: FakeStore,
  pathname: string,
  init: Parameters<typeof fetch>[1],
): readonly FakeItem[] => {
  const target = listPattern.exec(pathname)?.groups?.['target'];
  const collection = target?.slice('items/'.length);
  const rows =
    collection === undefined ? undefined : store.items.get(collection);
  if (collection === undefined || rows === undefined) {
    throw forbidden(`collection at ${pathname}`);
  }
  const { data, query } = parseBody(init);
  if (!isRecord(data) || !isRecord(query)) {
    throw failure(400, 'INVALID_PAYLOAD', 'query and data are required');
  }
  const fields = (
    new URL(pathname, 'https://fake.example').searchParams.get('fields') ?? 'id'
  ).split(',');
  const updated: FakeItem[] = [];
  for (const [index, row] of rows.entries()) {
    if (matches(row, query['filter'])) {
      rows[index] = { ...row, ...data, id: row.id };
      updated.push(project(rows[index], fields, collection));
    }
  }
  return updated;
};

// `PATCH /items/:collection` with an array of objects carrying their
// primary keys updates each of them (Directus `updateBatch`).
const updateBatch = (
  store: FakeStore,
  pathname: string,
  items: readonly unknown[],
): readonly FakeItem[] => {
  const { collection, rows } = collectionOf(store, pathname);
  const fields = (
    new URL(pathname, 'https://fake.example').searchParams.get('fields') ?? 'id'
  ).split(',');
  return items.map((item) => {
    const patch = asItem(item);
    const id =
      typeof item === 'object' && item !== null && 'id' in item
        ? Number(item.id)
        : NaN;
    const index = rows.findIndex((row) => row.id === id);
    const existing = rows[index];
    if (existing === undefined) {
      throw forbidden(`item ${String(id)} in collection "${collection}"`);
    }
    const updated = { ...existing, ...patch, id: existing.id };
    assertUnique(collection, rows, updated);
    rows[index] = updated;
    return project(updated, fields, collection);
  });
};

const update = (
  store: FakeStore,
  pathname: string,
  init: Parameters<typeof fetch>[1],
): FakeItem | readonly FakeItem[] => {
  const match = singlePattern.exec(pathname);
  if (match === null) {
    const parsed = parseJson(init);
    return Array.isArray(parsed)
      ? updateBatch(store, pathname, parsed)
      : updateByQuery(store, pathname, init);
  }
  const collection = match.groups?.['collection'];
  const id = Number(match.groups?.['id']);
  const rows =
    collection === undefined ? undefined : store.items.get(collection);
  const index = rows?.findIndex((row) => row.id === id) ?? -1;
  const existing = rows?.[index];
  if (rows === undefined || existing === undefined) {
    throw forbidden(`item at ${pathname}`);
  }
  const updated = { ...existing, ...parseBody(init), id: existing.id };
  rows[index] = updated;
  return { ...updated };
};

// A DirectusRequest over the in-memory store: paged item listings, field
// listings, Flow and operation listings, single-item reads, and creates and
// updates (by id or by query) on any existing collection with a unique
// `key` column enforced like the database would.
export const fakeItemsDirectus = (
  store: FakeStore,
): {
  readonly calls: RecordedCall[];
  readonly mutations: () => readonly RecordedCall[];
  readonly request: DirectusRequest;
} => {
  const calls: RecordedCall[] = [];
  const request: DirectusRequest = async (pathname, init) => {
    const method = init?.method ?? 'GET';
    calls.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      method,
      pathname,
    });
    await Promise.resolve();
    switch (method) {
      case 'GET':
        return get(store, pathname);
      case 'PATCH':
        return update(store, pathname, init);
      case 'POST':
        return create(store, pathname, init);
      default:
        throw failure(405, 'METHOD_NOT_ALLOWED', `${method} ${pathname}`);
    }
  };
  return {
    calls,
    mutations: () => calls.filter(({ method }) => method !== 'GET'),
    request,
  };
};
