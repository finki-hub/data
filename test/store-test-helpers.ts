import type { SyntheticDataset } from './fixtures/synthetic-data.js';

import { findModelCollection } from '../src/data-model/collections.js';
import { compositeKeys } from '../src/data-model/relations.js';
import {
  type DirectusRequest,
  DirectusRequestError,
} from '../src/directus-request.js';

export type FakeItem = Record<string, unknown> & {
  readonly id: number | string;
};

export type FakeStore = {
  readonly items: Map<string, FakeItem[]>;
  // The first id a table hands out, 1 unless a test advances the
  // sequences as an earlier, emptied project would have.
  readonly sequenceStart?: number;
};

export type RecordedCall = {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
};

const listPattern = /^\/items\/(?<collection>[^/?]+)(?:\?|$)/u;
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

// A store holding the rows of a dataset as they are, ids included.
export const storeFromDataset = (dataset: SyntheticDataset): FakeStore => ({
  items: new Map(
    Object.entries(dataset).map(([collection, rows]) => [
      collection,
      rows.map((row) => ({ ...row })),
    ]),
  ),
});

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

const rowsOf = (store: FakeStore, pathname: string) => {
  const collection = listPattern.exec(pathname)?.groups?.['collection'];
  const rows =
    collection === undefined ? undefined : store.items.get(collection);
  if (collection === undefined || rows === undefined) {
    throw forbidden(`collection at ${pathname}`);
  }
  return { collection, rows };
};

// `GET /items/:collection`: the rows by id, a page of them, projected to
// the requested fields.
const list = (store: FakeStore, pathname: string): readonly FakeItem[] => {
  const { collection, rows } = rowsOf(store, pathname);
  const search = new URL(pathname, 'https://fake.example').searchParams;
  const fields = (search.get('fields') ?? 'id').split(',');
  const limit = Number(search.get('limit') ?? '100');
  const offset = Number(search.get('offset') ?? '0');
  return rows
    .toSorted((left, right) =>
      collator.compare(String(left.id), String(right.id)),
    )
    .slice(offset, offset + limit)
    .map((row) => project(row, fields, collection));
};

const asItem = (parsed: unknown): FakeItem => {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw failure(400, 'INVALID_PAYLOAD', 'The body must be one object');
  }
  return { ...parsed, id: 0 };
};

// The domain keys the database enforces: the unique scalar columns the
// model declares and the composite unique keys the constraints migration
// creates. A create landing on a taken key fails the way the database
// would, RECORD_NOT_UNIQUE.
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
    const taken = rows.some((row) =>
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

const createOne = (
  {
    collection,
    sequenceStart,
  }: {
    readonly collection: string;
    readonly sequenceStart: number;
  },
  rows: FakeItem[],
  body: FakeItem,
): FakeItem => {
  assertUnique(collection, rows, body);
  let nextId = sequenceStart;
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
  if (typeof init?.body !== 'string') {
    throw failure(400, 'INVALID_PAYLOAD', 'A JSON body is required');
  }
  const { collection, rows } = rowsOf(store, pathname);
  const fields = new URL(pathname, 'https://fake.example').searchParams.get(
    'fields',
  );
  const shape = (row: FakeItem): FakeItem =>
    fields === null ? { ...row } : project(row, fields.split(','), collection);
  const table = { collection, sequenceStart: store.sequenceStart ?? 1 };
  const parsed: unknown = JSON.parse(init.body);
  if (Array.isArray(parsed)) {
    return parsed.map((item: unknown) =>
      shape(createOne(table, rows, asItem(item))),
    );
  }
  return shape(createOne(table, rows, asItem(parsed)));
};

// A DirectusRequest over the in-memory store: paged item listings and
// creates on any existing collection, with the unique keys enforced like
// the database would.
export const fakeItemsDirectus = (
  store: FakeStore,
): {
  readonly calls: RecordedCall[];
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
        return list(store, pathname);
      case 'POST':
        return create(store, pathname, init);
      default:
        throw failure(405, 'METHOD_NOT_ALLOWED', `${method} ${pathname}`);
    }
  };
  return { calls, request };
};
