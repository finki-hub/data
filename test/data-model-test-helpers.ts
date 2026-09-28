import type {
  ModelCollection,
  ModelField,
  ModelRelation,
  ModelRelationAlias,
} from '../src/schema.js';

import { dataModelCollections } from '../src/data-model/collections.js';
import {
  toAliasPayload,
  toFieldPayload,
} from '../src/data-model/field-payloads.js';
import { expectedColumnType } from '../src/data-model/fields.js';
import { aliasesFor, relationsOf } from '../src/data-model/relations.js';
import {
  type DirectusRequest,
  DirectusRequestError,
} from '../src/directus-request.js';

type FakeColumn = {
  default_value?: unknown;
  foreign_key_table?: null | string;
  is_indexed: boolean;
  is_nullable: boolean;
  is_primary_key: boolean;
  is_unique: boolean;
};

// The `directus_fields` row as `GET /fields/:collection` reports it: every
// meta column is present, unset ones as null.
export type FakeMeta = {
  [key: string]: unknown;
  special?: null | readonly string[];
};

type FakeField = {
  field: string;
  meta: FakeMeta | null;
  schema: FakeColumn | null;
  type: null | string;
};

export type FakeRelation = {
  collection: string;
  field: string;
  meta: null | {
    junction_field?: null | string;
    one_deselect_action?: null | string;
    one_field: null | string;
    sort_field?: null | string;
  };
  related_collection: null | string;
  schema?: null | { on_delete: null | string };
};

type FakeCollection = {
  collection: string;
  meta: null | Record<string, unknown>;
  schema: unknown;
};

type FakePreset = {
  bookmark: null | string;
  collection: null | string;
  role: null | string;
  user: null | string;
};

export type FakeState = {
  collections: FakeCollection[];
  fields: Record<string, FakeField[]>;
  presets?: FakePreset[];
  relations: Record<string, FakeRelation[]>;
  // The stored values of a field, keyed `collection.field`, for the reads
  // that check a realignment.
  values?: Record<string, readonly unknown[]>;
};

export type RecordedRequest = {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
};

const primaryKeyField: FakeField = {
  field: 'id',
  meta: { special: null },
  schema: {
    is_indexed: false,
    is_nullable: false,
    is_primary_key: true,
    is_unique: true,
  },
  type: 'integer',
};

// Meta columns Directus reports as null or false when the installer payload
// leaves them unset.
const metaDefaults: FakeMeta = {
  conditions: null,
  display: null,
  display_options: null,
  group: null,
  hidden: false,
  note: null,
  options: null,
  special: null,
  translations: null,
  validation: null,
};

// The column Directus would report after the installer created the field,
// carrying the exact meta the installer payload wrote.
const installedField = (field: ModelField, sort = 1): FakeField => ({
  field: field.field,
  meta: {
    ...metaDefaults,
    ...toFieldPayload(field, sort).meta,
    special: field.kind === 'm2o' ? ['m2o'] : null,
  },
  schema: {
    default_value: field.kind === 'm2o' ? null : (field.defaultValue ?? null),
    foreign_key_table: field.kind === 'm2o' ? field.related : null,
    is_indexed:
      field.kind === 'm2o' || (field.kind !== 'enum' && field.indexed === true),
    is_nullable: field.nullable,
    is_primary_key: false,
    is_unique:
      field.kind !== 'm2o' && field.kind !== 'enum' && field.unique === true,
  },
  type: expectedColumnType(field),
});

const installedAlias = (alias: ModelRelationAlias, sort = 1): FakeField => ({
  field: alias.field,
  meta: { ...metaDefaults, ...toAliasPayload(alias, sort).meta },
  schema: null,
  type: 'alias',
});

// The relation Directus would report after the installer created it.
export const installedRelation = (relation: ModelRelation): FakeRelation => ({
  collection: relation.collection,
  field: relation.field,
  meta: {
    junction_field: relation.junction,
    one_deselect_action: relation.nullable ? 'nullify' : 'delete',
    one_field: relation.alias?.field ?? null,
    sort_field: relation.sortField,
  },
  related_collection: relation.related,
  schema: { on_delete: relation.onDelete },
});

// Everything `GET /collections`, `GET /fields/:c` and `GET /relations/:c`
// return once a collection has been installed exactly as declared.
const installedCollection = (
  collection: ModelCollection,
): {
  collection: FakeCollection;
  fields: FakeField[];
  relations: FakeRelation[];
} => ({
  collection: { collection: collection.collection, meta: {}, schema: {} },
  fields: [
    primaryKeyField,
    ...collection.fields.map((field, index) =>
      installedField(field, index + 1),
    ),
    ...aliasesFor(collection.collection).map(({ alias }, index) =>
      installedAlias(alias, collection.fields.length + index + 1),
    ),
  ],
  relations: relationsOf(collection.collection).map(installedRelation),
});

export const emptyState = (): FakeState => ({
  collections: [],
  fields: {},
  relations: {},
});

export const installedState = (
  collections: readonly ModelCollection[] = dataModelCollections,
): FakeState => {
  const state = emptyState();
  for (const collection of collections) {
    const installed = installedCollection(collection);
    state.collections.push(installed.collection);
    state.fields[collection.collection] = installed.fields;
    state.relations[collection.collection] = installed.relations;
  }
  return state;
};

export const findCollection = (name: string): ModelCollection => {
  const collection = dataModelCollections.find(
    (candidate) => candidate.collection === name,
  );
  if (collection === undefined) {
    throw new Error(`Collection ${name} is not part of the model`);
  }
  return collection;
};

export const findField = (collection: string, field: string): ModelField => {
  const found = findCollection(collection).fields.find(
    (candidate) => candidate.field === field,
  );
  if (found === undefined) {
    throw new Error(`Field ${collection}.${field} is not part of the model`);
  }
  return found;
};

const forbidden = (pathname: string): DirectusRequestError =>
  new DirectusRequestError(`GET ${pathname} returned 403`, {
    code: 'FORBIDDEN',
    reason: null,
    status: 403,
  });

const listPattern = /^\/(?<kind>fields|relations)\/(?<collection>[^/]+)$/u;
const itemsPattern =
  /^\/items\/(?<collection>[^/?]+)\?(?:fields=(?<only>[^&]+)$|aggregate\[count\]=\*&groupBy\[\]=(?<grouped>[^&]+)&limit=-1$)/u;

// What `GET /items` answers to the value reads of a realignment: one count
// per distinct value, or the singleton's one value.
const itemsAnswer = (state: FakeState, pathname: string): unknown => {
  const groups = itemsPattern.exec(pathname)?.groups;
  const collection = groups?.['collection'] ?? '';
  const field = decodeURIComponent(
    groups?.['only'] ?? groups?.['grouped'] ?? '',
  );
  const values = state.values?.[`${collection}.${field}`] ?? [];
  if (groups?.['only'] !== undefined) {
    return { [field]: values[0] ?? null };
  }
  return [...new Set(values)].map((value) => ({
    count: String(values.filter((item) => item === value).length),
    [field]: value,
  }));
};

// A DirectusRequest over an in-memory schema that records every call.
// Mutations never change the state: the installer must decide from the
// listings alone, exactly like it does against a live project.
export const fakeDirectus = (
  state: FakeState,
  failures: ReadonlyMap<string, DirectusRequestError> = new Map(),
): { request: DirectusRequest; requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  const request: DirectusRequest = async (pathname, init) => {
    const method = init?.method ?? 'GET';
    requests.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      method,
      pathname,
    });
    if (method === 'GET') {
      if (pathname === '/collections') {
        return state.collections;
      }
      if (pathname.startsWith('/presets')) {
        return state.presets ?? [];
      }
      if (pathname.startsWith('/items/')) {
        return itemsAnswer(state, pathname);
      }
      const match = listPattern.exec(pathname);
      const collection = match?.groups?.['collection'];
      if (match === null || collection === undefined) {
        throw forbidden(pathname);
      }
      const listing =
        match.groups?.['kind'] === 'fields'
          ? state.fields[collection]
          : state.relations[collection];
      if (listing === undefined) {
        throw forbidden(pathname);
      }
      return listing;
    }
    const failure = failures.get(`${method} ${pathname}`);
    if (failure !== undefined) {
      throw failure;
    }
    return {};
  };
  return { request, requests };
};

export const mutations = (
  requests: readonly RecordedRequest[],
): readonly RecordedRequest[] =>
  requests.filter(({ method }) => method !== 'GET');
