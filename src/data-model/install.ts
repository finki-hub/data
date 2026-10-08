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
import { countText } from '../text.js';
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
import { outOfSetRefusals, withRefusals } from './live-choices.js';
import { planDataModel } from './plan.js';
import {
  aliasesFor,
  toRelationAlignmentPayload,
  toRelationPayload,
} from './relations.js';
import { collectionTranslations } from './translations.js';

// Existing definitions the model cannot carry: the message counts them,
// each refusal's reason names one (the commands print one line each).
export class SchemaRefusalError extends Error {
  public override readonly name = 'SchemaRefusalError';
  public readonly refusals: readonly Refusal[];
  public readonly summary: InstallSummary;

  public constructor(plan: InstallPlan, options?: ErrorOptions) {
    super(
      `data model: ${countText(plan.refusals.length, 'incompatible definition', 'incompatible definitions')}`,
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
      `collection ${collection} not created: licence collection limit (LIMIT_EXCEEDED); model collections: ${String(dataModelCollections.length)}`,
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
  ...(collection.label !== undefined && {
    translations: collectionTranslations(collection.label),
  }),
});

// The body of `POST /collections`: the collection with its fields and
// aliases inline.
export const toCollectionPayload = (collection: ModelCollection) => ({
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
  try {
    await request(
      '/collections',
      json(toCollectionPayload(action.collection), 'POST'),
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
      return;
    // Meta only: the column is never touched, and the keys Studio owns
    // (note, width, group, sort, conditions) are not in the body.
    case 'realign-choices':
      await request(
        fieldPath(action.collection, action.field.field),
        json({ meta: action.meta }, 'PATCH'),
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
// created; a unique or index flag a Studio edit removed is restored;
// relations whose alias, sort, deselect or delete rule diverge are aligned;
// a table or column Directus does not manage is refused; enum fields
// whose code-owned choices or rule drifted are realigned (`aligned`),
// unless a live value falls outside the declared choices; incompatible
// existing definitions and such values are refused before any mutation;
// nothing is deleted and no item is written.
export const installDataModel = async (
  request: DirectusRequest,
): Promise<InstallSummary> => {
  const planned = planDataModel(await readState(request));
  const plan = withRefusals(planned, await outOfSetRefusals(request, planned));
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
