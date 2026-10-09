import type { ModelRelation } from '../schema-relations.js';
import type { ExistingRelation } from './directus-schema.js';

import {
  type Mismatch,
  type Refusal,
  refusalOf,
  type RelationAction,
  type Tally,
} from './plan-types.js';
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
): Mismatch | null => {
  if (existing.related_collection !== relation.related) {
    return {
      expected: relation.related,
      live: `target ${String(existing.related_collection)}`,
    };
  }
  const oneField = existing.meta?.one_field ?? null;
  if (
    relation.alias !== null &&
    oneField !== null &&
    oneField !== relation.alias.field
  ) {
    return {
      expected: relation.alias.field,
      live: `reverse alias ${oneField}`,
    };
  }
  return null;
};

// True when the alias, junction, sort field, deselect action or delete
// rule of the existing relation differ from the model, including a missing
// foreign key.
const diverges = (
  relation: ModelRelation,
  existing: ExistingRelation,
): boolean => {
  const { meta, schema } = toRelationAlignmentPayload(relation);
  const current = {
    junction_field: existing.meta?.junction_field ?? null,
    on_delete: existing.schema?.on_delete ?? null,
    one_deselect_action: existing.meta?.one_deselect_action ?? null,
    one_field: existing.meta?.one_field ?? null,
    sort_field: existing.meta?.sort_field ?? null,
  };
  return (
    current.on_delete !== schema.on_delete ||
    current.one_deselect_action !== meta.one_deselect_action ||
    current.sort_field !== meta.sort_field ||
    (meta.junction_field !== undefined &&
      current.junction_field !== meta.junction_field) ||
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
    context.actions.refusals.push(
      refusalOf(
        'Relation',
        { collection: relation.collection, field: relation.field },
        refusal,
      ),
    );
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
