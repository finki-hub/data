import type { ExistingState } from './directus-schema.js';

import { dataModelCollections } from './collections.js';
import { type PlanActions, planExistingCollection } from './plan-fields.js';
import {
  type CollectionAction,
  type FieldAction,
  type InstallPlan,
  Tally,
} from './plan-types.js';
import { aliasesFor, relationsOf } from './relations.js';

// Diffs the declared model against the live schema. The plan only ever adds
// or adopts; incompatible existing definitions become refusals and nothing is
// planned for deletion.
export const planDataModel = (state: ExistingState): InstallPlan => {
  const tally = new Tally();
  const collections: CollectionAction[] = [];
  const actions: PlanActions = { fields: [], refusals: [], relations: [] };

  for (const collection of dataModelCollections) {
    const existing = state.collections.get(collection.collection);
    if (existing === undefined) {
      collections.push({ collection, kind: 'create-collection' });
      tally.add('collections', 'created');
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
    if (existing.schema === null) {
      actions.refusals.push({
        collection: collection.collection,
        field: null,
        reason: `Collection ${collection.collection} exists as a folder without a table`,
      });
      tally.add('collections', 'refused');
      continue;
    }
    if (existing.meta === null) {
      collections.push({ collection, kind: 'adopt-collection' });
      tally.add('collections', 'adopted');
    } else {
      tally.add('collections', 'skipped');
    }
    planExistingCollection(collection, state, { actions, tally });
  }

  const byKind = (kind: FieldAction['kind']) =>
    actions.fields.filter((action) => action.kind === kind);

  return {
    collections,
    fields: [
      ...byKind('create-field'),
      ...byKind('adopt-meta'),
      ...byKind('add-flags'),
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
