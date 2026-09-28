import type { ExistingCollection, ExistingState } from './directus-schema.js';

import { dataModelCollections } from './collections.js';
import { type PlanActions, planExistingCollection } from './plan-fields.js';
import {
  type CollectionAction,
  type FieldAction,
  type InstallPlan,
  Tally,
} from './plan-types.js';
import { aliasesFor, relationsOf } from './relations.js';

// Why an existing collection cannot carry a declared one, or null when it
// can.
const collectionRefusal = ({
  meta,
  schema,
}: ExistingCollection): null | string => {
  if (schema === null) {
    return 'exists as a folder without a table';
  }
  return meta === null ? 'exists as a table Directus does not manage' : null;
};

// Diffs the declared model against the live schema. The plan only ever adds
// or repairs; incompatible existing definitions, and tables or fields
// Directus does not manage (no meta), become refusals and nothing is
// planned for deletion.
export const planDataModel = (state: ExistingState): InstallPlan => {
  const tally = new Tally();
  const collections: CollectionAction[] = [];
  const actions: PlanActions = { fields: [], refusals: [], relations: [] };

  for (const collection of dataModelCollections) {
    const existing = state.collections.get(collection.collection);
    if (existing === undefined) {
      collections.push({ collection, kind: 'create-collection' });
      tally.addCollection('created');
      tally.add(
        'fields',
        'created',
        collection.fields.length + aliasesFor(collection.collection).length,
      );
      for (const relation of relationsOf(collection.collection)) {
        actions.relations.push({ kind: 'create-relation', relation });
        tally.add('relations', 'created');
      }
      continue;
    }
    const refusal = collectionRefusal(existing);
    if (refusal !== null) {
      actions.refusals.push({
        collection: collection.collection,
        field: null,
        reason: `Collection ${collection.collection} ${refusal}`,
      });
      tally.addCollection('refused');
      continue;
    }
    tally.addCollection('skipped');
    planExistingCollection(collection, state, { actions, tally });
  }

  const byKind = (kind: FieldAction['kind']) =>
    actions.fields.filter((action) => action.kind === kind);

  return {
    collections,
    fields: [
      ...byKind('create-field'),
      ...byKind('add-flags'),
      ...byKind('realign-choices'),
      ...byKind('create-alias'),
    ],
    refusals: actions.refusals,
    relations: [
      ...actions.relations.filter(
        (action) => action.kind === 'create-relation',
      ),
      ...actions.relations.filter((action) => action.kind === 'align-relation'),
    ],
    summary: tally.summary(),
  };
};
