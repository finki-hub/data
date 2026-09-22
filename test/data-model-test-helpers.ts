import type {
  ModelCollection,
  ModelField,
  ModelRelation,
} from '../src/schema.js';

import { dataModelCollections } from '../src/data-model/collections.js';
import { expectedColumnType } from '../src/data-model/fields.js';
import { aliasesFor, relationsOf } from '../src/data-model/relations.js';
import {
  type DirectusRequest,
  DirectusRequestError,
} from '../src/directus-request.js';

export type FakeColumn = {
  default_value?: unknown;
  foreign_key_table?: null | string;
  is_indexed: boolean;
  is_nullable: boolean;
  is_primary_key: boolean;
  is_unique: boolean;
};

export type FakeField = {
  field: string;
  meta: null | { special?: null | string[] };
  schema: FakeColumn | null;
  type: null | string;
};

export type FakeRelation = {
  collection: string;
  field: string;
  meta: null | {
    one_deselect_action?: null | string;
    one_field: null | string;
    sort_field?: null | string;
  };
  related_collection: null | string;
  schema?: null | { on_delete: null | string };
};

export type FakeCollection = {
  collection: string;
  meta: unknown;
  schema: unknown;
};

export type FakeState = {
  collections: FakeCollection[];
  fields: Record<string, FakeField[]>;
  relations: Record<string, FakeRelation[]>;
};

export type RecordedRequest = {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
};

export const primaryKeyField: FakeField = {
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

// The column Directus would report after the installer created the field.
export const installedField = (field: ModelField): FakeField => ({
  field: field.field,
  meta: { special: field.kind === 'm2o' ? ['m2o'] : null },
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

export const installedAlias = (field: string): FakeField => ({
  field,
  meta: { special: ['o2m'] },
  schema: null,
  type: 'alias',
});

// The relation Directus would report after the installer created it.
export const installedRelation = (relation: ModelRelation): FakeRelation => ({
  collection: relation.collection,
  field: relation.field,
  meta: {
    one_deselect_action: relation.nullable ? 'nullify' : 'delete',
    one_field: relation.alias?.field ?? null,
    sort_field: relation.sortField,
  },
  related_collection: relation.related,
  schema: { on_delete: relation.onDelete },
});

// Everything `GET /collections`, `GET /fields/:c` and `GET /relations/:c`
// return once a collection has been installed exactly as declared.
export const installedCollection = (
  collection: ModelCollection,
): {
  collection: FakeCollection;
  fields: FakeField[];
  relations: FakeRelation[];
} => ({
  collection: { collection: collection.collection, meta: {}, schema: {} },
  fields: [
    primaryKeyField,
    ...collection.fields.map(installedField),
    ...aliasesFor(collection.collection).map(({ alias }) =>
      installedAlias(alias.field),
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
