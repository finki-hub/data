import { z } from 'zod';

import type { ImportIo, SetupReport } from '../src/directus.js';

import {
  dataModelCollectionKeys,
  findModelCollection,
} from '../src/data-model/collections.js';
import {
  type DirectusModeRequest,
  DirectusRequestError,
} from '../src/directus-request.js';
import {
  type FakeItem,
  fakeItemsDirectus,
  type FakeStore,
  type RecordedCall,
} from './migration-test-helpers.js';

export const clockValue = '2026-09-22T12:00:00.000Z';

export const setupReport: SetupReport = { setup: 'stand-in' };

export const emptyStore = (): FakeStore => ({
  flows: [],
  items: new Map(),
  limitMax: null,
  operations: [],
});

const aggregatePattern =
  /^\/items\/(?<collection>[^/?]+)\?aggregate\[count\]=\*$/u;
const flowFilterPattern = /^\/flows\?.*filter\[id\]\[_eq\]=(?<id>[0-9a-f-]+)$/u;
const flowPattern = /^\/flows\/(?<id>[0-9a-f-]+)$/u;
const triggerPattern = /^\/flows\/trigger\/(?<id>[0-9a-f-]+)$/u;
const itemsPattern = /^\/items\/(?<collection>[^/?]+)(?:\?|$)/u;

const flowBody = z.looseObject({ id: z.string() });
const itemsBody = z.union([
  z.array(z.record(z.string(), z.unknown())),
  z.record(z.string(), z.unknown()),
]);

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

export type ImportFake = {
  readonly calls: RecordedCall[];
  readonly io: ImportIo;
  readonly mutations: () => readonly RecordedCall[];
  readonly request: DirectusModeRequest;
  readonly setups: () => number;
  readonly store: FakeStore;
  readonly triggers: Array<{ readonly id: string; readonly mode: string }>;
};

type FakeOptions = {
  readonly batchSize?: number;
  readonly triggerResult?: unknown;
};

// What a handler answers for a request it does not serve.
const unhandled = Symbol('unhandled');

type Handler = (
  pathname: string,
  init: Parameters<typeof fetch>[1],
  mode: string,
) => unknown;

// Answers the Flow endpoints the installer and the trigger use.
const flowHandler =
  (
    store: FakeStore,
    triggers: Array<{ readonly id: string; readonly mode: string }>,
    options: FakeOptions,
  ): Handler =>
  (pathname, init, mode) => {
    const method = init?.method ?? 'GET';
    const filtered = flowFilterPattern.exec(pathname)?.groups?.['id'];
    if (filtered !== undefined) {
      return store.flows
        .filter(({ id }) => id === filtered)
        .map(({ id, operation }) => ({ id, operation: operation ?? null }));
    }
    const triggered = triggerPattern.exec(pathname)?.groups?.['id'];
    if (triggered !== undefined) {
      triggers.push({ id: triggered, mode });
      return options.triggerResult ?? { courses: 0, studentCouncilMembers: 0 };
    }
    if (method === 'POST' && ['/flows', '/operations'].includes(pathname)) {
      const created: FakeItem = flowBody.parse(bodyOf(init));
      (pathname === '/flows' ? store.flows : store.operations).push(created);
      return created;
    }
    const patched = flowPattern.exec(pathname)?.groups?.['id'];
    if (method !== 'PATCH' || patched === undefined) {
      return unhandled;
    }
    const index = store.flows.findIndex(({ id }) => id === patched);
    const existing = store.flows[index];
    if (existing === undefined) {
      throw forbidden(`flow ${patched}`);
    }
    store.flows[index] = {
      ...existing,
      ...z.record(z.string(), z.unknown()).parse(bodyOf(init)),
      id: existing.id,
    };
    return store.flows[index];
  };

// Answers the collection listing and the record counts.
const schemaHandler =
  (store: FakeStore): Handler =>
  (pathname) => {
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

// A Directus for the import: the collection listing, record counts, the
// Flow and operation endpoints and the manual trigger, over the paged item
// store of the migration tests, whose created rows carry every model column
// the insert left out as null. The setup stand-in creates every model
// collection empty (plus the coordination singleton row) as `npm run setup`
// would.
export const fakeImportDirectus = (
  store: FakeStore,
  options: FakeOptions = {},
): ImportFake => {
  const items = fakeItemsDirectus(store);
  const calls: RecordedCall[] = [];
  const triggers: Array<{ readonly id: string; readonly mode: string }> = [];
  const handlers = [
    schemaHandler(store),
    flowHandler(store, triggers, options),
  ];
  let setups = 0;
  const request: DirectusModeRequest = async (pathname, init, mode) => {
    const method = init?.method ?? 'GET';
    calls.push({ body: bodyOf(init), method, pathname });
    await Promise.resolve();
    for (const handler of handlers) {
      const answer = handler(pathname, init, mode ?? 'data');
      if (answer !== unhandled) {
        return answer;
      }
    }
    const collection = itemsPattern.exec(pathname)?.groups?.['collection'];
    if (method !== 'POST' || collection === undefined) {
      return items.request(pathname, init);
    }
    const body = itemsBody.parse(bodyOf(init));
    const filled = Array.isArray(body)
      ? body.map((item) => withColumns(collection, item))
      : withColumns(collection, body);
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
      now: () => clockValue,
      runToken: () => 'import-run',
      setup,
    },
    mutations: () => calls.filter(({ method }) => method !== 'GET'),
    request,
    setups: () => setups,
    store,
    triggers,
  };
};
