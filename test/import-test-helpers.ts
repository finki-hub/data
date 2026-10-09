import type { Filter } from '@directus/types';

import { z } from 'zod';

import type { ImportIo, SetupReport } from '../src/import-workbook.js';

import { withDefaultMapping } from '../directus/extensions/directus-extension-data-operations/src/course-default-mapping.js';
import { patternMappingCreate } from '../directus/extensions/directus-extension-data-operations/src/pattern-guard.js';
import {
  dataModelCollectionKeys,
  findModelCollection,
} from '../src/data-model/collections.js';
import {
  type DirectusRequest,
  DirectusRequestError,
} from '../src/directus-request.js';
import { storeReader } from '../src/projection/memory-reader.js';
import {
  fakeItemsDirectus,
  type FakeStore,
  type RecordedCall,
} from './store-test-helpers.js';

const setupReport: SetupReport = { setup: 'stand-in' };

export const emptyStore = (): FakeStore => ({ items: new Map() });

const aggregatePattern =
  /^\/items\/(?<collection>[^/?]+)\?aggregate\[count\]=\*$/u;
const itemsPattern = /^\/items\/(?<collection>[^/?]+)(?:\?|$)/u;

const itemsBody = z.array(z.record(z.string(), z.unknown()));
const presetsPattern = /^\/presets(?:\?|$)/u;
const filterParameter = z.custom<Filter>(
  (value) => typeof value === 'object' && value !== null,
);

// A shared or personal preset as the fake holds it: the posted body.
export type FakePreset = Readonly<Record<string, unknown>> & {
  readonly bookmark: null | string;
  readonly collection: string;
  readonly role: null | string;
  readonly user: null | string;
};

const presetBody = z.looseObject({
  bookmark: z.string().nullable(),
  collection: z.string(),
  role: z.string().nullable(),
  user: z.string().nullable(),
});

const forbidden = (what: string): DirectusRequestError =>
  new DirectusRequestError(`You don't have permission to access ${what}.`, {
    code: 'FORBIDDEN',
    reason: null,
    status: 403,
  });

const bodyOf = (init: Parameters<typeof fetch>[1]): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : null;

// A created row as the database stores it: every model column the insert
// did not name is null.
const withColumns = (
  collection: string,
  item: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  ...Object.fromEntries(
    (findModelCollection(collection)?.fields ?? []).map(({ field }) => [
      field,
      null,
    ]),
  ),
  ...item,
});

const itemRecord = z.record(z.string(), z.unknown());

// The create filters of the data-operations bundle, as Directus runs them
// on every posted row before it writes it: the new-course hook (which
// drops the import's empty list of pattern mappings) and the pattern
// guard. Nested rows are not modelled: a course that still names pattern
// mappings fails the fake.
const filtersOnCreate: Readonly<Record<string, (payload: unknown) => unknown>> =
  {
    courses: withDefaultMapping,
    moodle_pattern_mappings: patternMappingCreate,
  };

const filtered = (
  collection: string,
  item: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const filter = filtersOnCreate[collection];
  const row = filter === undefined ? item : itemRecord.parse(filter(item));
  if (Object.hasOwn(row, 'pattern_mappings')) {
    throw new Error(`fake: nested pattern mappings of a ${collection} row`);
  }
  return row;
};

export type ImportFake = {
  readonly calls: RecordedCall[];
  readonly io: ImportIo;
  readonly mutations: () => readonly RecordedCall[];
  // Every preset of the project, the posted ones appended.
  readonly presets: FakePreset[];
  readonly request: DirectusRequest;
  readonly setups: () => number;
  readonly store: FakeStore;
};

type FakeOptions = {
  readonly batchSize?: number;
  // The presets the project holds before the import.
  readonly presets?: readonly FakePreset[];
};

// What the handler answers for a request it does not serve.
const unhandled = Symbol('unhandled');

// Answers the collection listing and the record counts.
const schemaHandler =
  (store: FakeStore) =>
  (pathname: string): unknown => {
    if (pathname === '/collections') {
      return store.items
        .keys()
        .map((name) => ({
          collection: name,
          meta: { singleton: name === 'data_operations' },
          schema: { name },
        }))
        .toArray();
    }
    const aggregate = aggregatePattern.exec(pathname)?.groups?.['collection'];
    if (aggregate === undefined) {
      return unhandled;
    }
    const rows = store.items.get(aggregate);
    if (rows === undefined) {
      throw forbidden(`collection "${aggregate}"`);
    }
    return [{ count: String(rows.length) }];
  };

// The preset listing (bookmark, collection, user and role of each) and
// a preset POST, which the fake keeps.
const presetsHandler =
  (presets: FakePreset[]) =>
  (pathname: string, init: Parameters<typeof fetch>[1]): unknown => {
    if (!presetsPattern.test(pathname)) {
      return unhandled;
    }
    if (init?.method === 'POST') {
      const preset = presetBody.parse(bodyOf(init));
      presets.push(preset);
      return { ...preset, id: presets.length };
    }
    return presets.map(({ bookmark, collection, role, user }) => ({
      bookmark,
      collection,
      role,
      user,
    }));
  };

// A filtered item read (`fields`, `filter`, `limit`), answered through the
// memory reader as the ItemsService would answer it over the store.
const readItems = async (
  store: FakeStore,
  collection: string,
  pathname: string,
): Promise<unknown> => {
  const query = new URL(pathname, 'https://fake.invalid').searchParams;
  const filter = query.get('filter');
  const rows = await storeReader(store)({
    collection,
    fields: (query.get('fields') ?? 'id').split(','),
    ...(filter !== null && {
      filter: filterParameter.parse(JSON.parse(filter)),
    }),
    sort: ['id'],
  });
  const limit = Number(query.get('limit') ?? '-1');
  return limit < 0 ? rows : rows.slice(0, limit);
};

// A Directus for the import: the collection listing and record counts,
// filtered item reads and the presets, over the item store of the import
// tests, whose created rows carry every model column the insert left out
// as null. The setup stand-in creates every model collection empty (plus
// the coordination singleton row) as `npm run setup` would; the import
// itself touches no Flow.
export const fakeImportDirectus = (
  store: FakeStore,
  options: FakeOptions = {},
): ImportFake => {
  const items = fakeItemsDirectus(store);
  const calls: RecordedCall[] = [];
  const presets = [...(options.presets ?? [])];
  const schema = schemaHandler(store);
  const presetAnswer = presetsHandler(presets);
  let setups = 0;
  const request: DirectusRequest = async (pathname, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ body: bodyOf(init), method, pathname });
    await Promise.resolve();
    const answer = schema(pathname);
    if (answer !== unhandled) {
      return answer;
    }
    const preset = presetAnswer(pathname, init);
    if (preset !== unhandled) {
      return preset;
    }
    const collection = itemsPattern.exec(pathname)?.groups?.['collection'];
    if (method === 'GET' && collection !== undefined) {
      return readItems(store, collection, pathname);
    }
    if (method !== 'POST' || collection === undefined) {
      return items.request(pathname, init);
    }
    const filled = itemsBody
      .parse(bodyOf(init))
      .map((item) => withColumns(collection, filtered(collection, item)));
    return items.request(pathname, { ...init, body: JSON.stringify(filled) });
  };
  const setup = async (): Promise<SetupReport> => {
    setups += 1;
    await Promise.resolve();
    for (const key of dataModelCollectionKeys) {
      if (!store.items.has(key)) {
        store.items.set(key, key === 'data_operations' ? [{ id: 1 }] : []);
      }
    }
    return setupReport;
  };
  return {
    calls,
    io: {
      ...(options.batchSize !== undefined && {
        batchSize: options.batchSize,
      }),
      setup,
    },
    mutations: () => calls.filter(({ method }) => method !== 'GET'),
    presets,
    request,
    setups: () => setups,
    store,
  };
};
