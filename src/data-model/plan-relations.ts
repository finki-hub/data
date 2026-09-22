import type { ModelRelation } from '../schema.js';
import type { ExistingRelation } from './directus-schema.js';
import type { Refusal, RelationAction, Tally } from './plan-types.js';

import { toRelationAlignmentPayload } from './relations.js';

type RelationContext = {
  readonly actions: {
    readonly refusals: Refusal[];
    readonly relations: RelationAction[];
  };
  readonly tally: Tally;
};

// Why an existing relation cannot carry the declared one, or null when it
// can. A reverse alias that already points elsewhere would be orphaned by a
// re-attachment, so it is refused rather than moved.
const relationRefusal = (
  relation: ModelRelation,
  existing: ExistingRelation,
): null | string => {
  if (existing.related_collection !== relation.related) {
    return `targets ${String(existing.related_collection)} but the model targets ${relation.related}`;
  }
  const oneField = existing.meta?.one_field ?? null;
  if (
    relation.alias !== null &&
    oneField !== null &&
    oneField !== relation.alias.field
  ) {
    return `has reverse alias ${oneField} but the model declares ${relation.alias.field}`;
  }
  return null;
};

// True when the alias, sort field, deselect action or delete rule of the
// existing relation differ from the model, including a missing foreign key.
const diverges = (
  relation: ModelRelation,
  existing: ExistingRelation,
): boolean => {
  const { meta, schema } = toRelationAlignmentPayload(relation);
  const current = {
    on_delete: existing.schema?.on_delete ?? null,
    one_deselect_action: existing.meta?.one_deselect_action ?? null,
    one_field: existing.meta?.one_field ?? null,
    sort_field: existing.meta?.sort_field ?? null,
  };
  return (
    current.on_delete !== schema.on_delete ||
    current.one_deselect_action !== meta.one_deselect_action ||
    current.sort_field !== meta.sort_field ||
    (meta.one_field !== undefined && current.one_field !== meta.one_field)
  );
};

export const planRelation = (
  relation: ModelRelation,
  existing: ExistingRelation | undefined,
  context: RelationContext,
): void => {
  if (existing === undefined) {
    context.actions.relations.push({ kind: 'create-relation', relation });
    context.tally.add('relations', 'created');
    return;
  }
  const refusal = relationRefusal(relation, existing);
  if (refusal !== null) {
    context.actions.refusals.push({
      collection: relation.collection,
      field: relation.field,
      reason: `Relation ${relation.collection}.${relation.field} ${refusal}`,
    });
    context.tally.add('relations', 'refused');
    return;
  }
  if (diverges(relation, existing)) {
    context.actions.relations.push({ kind: 'align-relation', relation });
    context.tally.add('relations', 'adopted');
    return;
  }
  context.tally.add('relations', 'skipped');
};
