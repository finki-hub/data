import type { ModelCollection } from '../schema.js';
import type {
  CollectionAction,
  FieldAction,
  InstallPlan,
  InstallSummary,
  Refusal,
  RelationAction,
} from './plan-types.js';

import {
  type DirectusRequest,
  DirectusRequestError,
} from '../directus-request.js';
import { dataModelCollections } from './collections.js';
import {
  existingCollectionsSchema,
  type ExistingField,
  existingFieldsSchema,
  type ExistingRelation,
  existingRelationsSchema,
  type ExistingState,
} from './directus-schema.js';
import { toAliasPayload, toFieldPayload } from './field-payloads.js';
import { planDataModel } from './plan.js';
import {
  aliasesFor,
  toRelationAlignmentPayload,
  toRelationPayload,
} from './relations.js';

export class SchemaRefusalError extends Error {
  public override readonly name = 'SchemaRefusalError';
  public readonly refusals: readonly Refusal[];
  public readonly summary: InstallSummary;

  public constructor(plan: InstallPlan, options?: ErrorOptions) {
    super(
      `Refusing to install the data model over incompatible existing definitions:\n${plan.refusals
        .map(({ reason }) => `- ${reason}`)
        .join('\n')}`,
      options,
    );
    this.refusals = plan.refusals;
    this.summary = plan.summary;
  }
}

export class CollectionLimitError extends Error {
  public override readonly name = 'CollectionLimitError';

  public constructor(public readonly collection: string) {
    super(
      `Directus refused to create collection ${collection} because the licence caps active collections (LIMIT_EXCEEDED). ` +
        `The relational model needs ${dataModelCollections.length} collections; remove unused collections or use a licence with a higher limit, then run setup again.`,
    );
  }
}

const json = (body: unknown, method: 'PATCH' | 'POST') => ({
  body: JSON.stringify(body),
  method,
});

const fieldPath = (collection: string, field: string): string =>
  `/fields/${collection}/${encodeURIComponent(field)}`;

const collectionMeta = (collection: ModelCollection) => ({
  display_template: collection.displayTemplate,
  hidden: collection.hidden,
  icon: collection.icon,
  note: collection.note,
  singleton: collection.singleton,
  sort: collection.sort,
});

const collectionPayload = (collection: ModelCollection) => ({
  collection: collection.collection,
  fields: [
    ...collection.fields.map((field, index) =>
      toFieldPayload(field, index + 1),
    ),
    ...aliasesFor(collection.collection).map(({ alias }, index) =>
      toAliasPayload(alias, collection.fields.length + index + 1),
    ),
  ],
  meta: collectionMeta(collection),
  schema: {},
});

const readState = async (request: DirectusRequest): Promise<ExistingState> => {
  const collections = existingCollectionsSchema.parse(
    await request('/collections'),
  );
  const known = new Map(
    collections.map((collection) => [collection.collection, collection]),
  );
  const fields = new Map<string, readonly ExistingField[]>();
  const relations = new Map<string, readonly ExistingRelation[]>();
  for (const { collection } of dataModelCollections) {
    const existing = known.get(collection);
    if (existing === undefined || existing.schema === null) {
      continue;
    }
    fields.set(
      collection,
      existingFieldsSchema.parse(await request(`/fields/${collection}`)),
    );
    relations.set(
      collection,
      existingRelationsSchema.parse(await request(`/relations/${collection}`)),
    );
  }
  return { collections: known, fields, relations };
};

const applyCollection = async (
  request: DirectusRequest,
  action: CollectionAction,
): Promise<void> => {
  if (action.kind === 'adopt-collection') {
    await request(
      `/collections/${action.collection.collection}`,
      json({ meta: collectionMeta(action.collection) }, 'PATCH'),
    );
    return;
  }
  try {
    await request(
      '/collections',
      json(collectionPayload(action.collection), 'POST'),
    );
  } catch (error) {
    if (
      error instanceof DirectusRequestError &&
      error.code === 'LIMIT_EXCEEDED'
    ) {
      throw new CollectionLimitError(action.collection.collection);
    }
    throw error;
  }
};

const applyField = async (
  request: DirectusRequest,
  action: FieldAction,
): Promise<void> => {
  switch (action.kind) {
    case 'add-flags':
      await request(
        fieldPath(action.collection, action.field),
        json({ schema: action.schema }, 'PATCH'),
      );
      return;
    case 'adopt-meta': {
      const { meta } = toFieldPayload(action.field, action.sort);
      await request(
        fieldPath(action.collection, action.field.field),
        json({ meta }, 'PATCH'),
      );
      return;
    }
    case 'create-alias':
      await request(
        `/fields/${action.collection}`,
        json(toAliasPayload(action.alias, action.sort), 'POST'),
      );
      return;
    case 'create-field':
      await request(
        `/fields/${action.collection}`,
        json(toFieldPayload(action.field, action.sort), 'POST'),
      );
  }
};

// Aligning an existing relation sends the full relation payload: a partial
// PATCH makes Directus recreate the foreign key without its delete rule.
const applyRelation = async (
  request: DirectusRequest,
  action: RelationAction,
): Promise<void> => {
  if (action.kind === 'create-relation') {
    await request(
      '/relations',
      json(toRelationPayload(action.relation), 'POST'),
    );
    return;
  }
  const payload = toRelationAlignmentPayload(action.relation);
  await request(
    `/relations/${payload.collection}/${encodeURIComponent(payload.field)}`,
    json(payload, 'PATCH'),
  );
};

// Installs the relational data model over REST, idempotently. Missing
// collections, fields, aliases, relations and single-column constraints are
// created; unmanaged existing columns are adopted meta-only; relations whose
// alias, sort, deselect or delete rule diverge are aligned; incompatible
// existing definitions are refused before any mutation; nothing is deleted
// and no item is written.
export const installDataModel = async (
  request: DirectusRequest,
): Promise<InstallSummary> => {
  const plan = planDataModel(await readState(request));
  if (plan.refusals.length > 0) {
    throw new SchemaRefusalError(plan);
  }
  for (const action of plan.collections) {
    await applyCollection(request, action);
  }
  for (const action of plan.fields) {
    await applyField(request, action);
  }
  for (const action of plan.relations) {
    await applyRelation(request, action);
  }
  return plan.summary;
};
