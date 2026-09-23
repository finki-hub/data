import type { ModelCollection, ModelField } from '../schema.js';
import type {
  FieldAction,
  Refusal,
  RelationAction,
  Tally,
} from './plan-types.js';

import {
  alterableColumn,
  type ExistingField,
  type ExistingState,
} from './directus-schema.js';
import { expectedColumnType } from './fields.js';
import { realignedChoices } from './plan-choices.js';
import { planRelation } from './plan-relations.js';
import { aliasesFor, relationsOf } from './relations.js';

export type PlanActions = {
  readonly fields: FieldAction[];
  readonly refusals: Refusal[];
  readonly relations: RelationAction[];
};

export type PlanContext = {
  readonly actions: PlanActions;
  readonly tally: Tally;
};

// Why an existing column cannot carry the declared field, or null when it can.
const columnRefusal = (
  field: ModelField,
  existing: ExistingField,
): null | string => {
  if (existing.schema === null) {
    return 'exists as an alias field but the model declares a column';
  }
  const expected = expectedColumnType(field);
  if (existing.type !== expected) {
    return `has type ${String(existing.type)} but the model declares ${expected}`;
  }
  if (
    field.nullable &&
    !existing.schema.is_nullable &&
    (existing.schema.default_value ?? null) === null
  ) {
    return 'is NOT NULL without a default but the model declares it nullable';
  }
  if (!field.nullable && existing.schema.is_nullable) {
    return 'is nullable but the model declares it required';
  }
  const foreignTable = existing.schema.foreign_key_table ?? null;
  if (
    field.kind === 'm2o' &&
    foreignTable !== null &&
    foreignTable !== field.related
  ) {
    return `references ${foreignTable} but the model relates it to ${field.related}`;
  }
  return null;
};

const wantsUnique = (field: ModelField): boolean =>
  field.kind !== 'm2o' && field.kind !== 'enum' && field.unique === true;

const wantsIndex = (field: ModelField): boolean =>
  field.kind === 'm2o' || (field.kind !== 'enum' && field.indexed === true);

// The full alter payload when a declared unique or index is missing, else null.
const missingFlags = (
  field: ModelField,
  existing: ExistingField,
): null | Readonly<Record<string, unknown>> => {
  if (existing.schema === null) {
    return null;
  }
  const needsUnique = wantsUnique(field) && !existing.schema.is_unique;
  const needsIndex = wantsIndex(field) && !existing.schema.is_indexed;
  if (!needsUnique && !needsIndex) {
    return null;
  }
  return {
    ...alterableColumn(existing.schema),
    is_indexed: existing.schema.is_indexed || needsIndex,
    is_unique: existing.schema.is_unique || needsUnique,
  };
};

type ColumnTarget = {
  readonly existing: ExistingField | undefined;
  readonly field: ModelField;
  readonly singleton: boolean;
  readonly sort: number;
};

// An installed enum field whose code-owned choices or rule drifted from the
// declaration is realigned; whether a live value falls outside the new set
// is checked before anything is written (install.ts).
const planChoices = (
  collection: string,
  { existing, field, singleton }: ColumnTarget,
  context: PlanContext,
): boolean => {
  const live = existing?.meta ?? null;
  if (field.kind !== 'enum' || live === null) {
    return false;
  }
  const meta = realignedChoices(field, live);
  if (meta === null) {
    return false;
  }
  context.actions.fields.push({
    collection,
    field,
    kind: 'realign-choices',
    meta,
    singleton,
  });
  return true;
};

const planColumn = (
  collection: string,
  target: ColumnTarget,
  context: PlanContext,
): void => {
  const { existing, field, sort } = target;
  if (existing === undefined) {
    context.actions.fields.push({
      collection,
      field,
      kind: 'create-field',
      sort,
    });
    context.tally.add('fields', 'created');
    return;
  }
  const refusal = columnRefusal(field, existing);
  if (refusal !== null) {
    context.actions.refusals.push({
      collection,
      field: field.field,
      reason: `Field ${collection}.${field.field} ${refusal}`,
    });
    context.tally.add('fields', 'refused');
    return;
  }
  const flags = missingFlags(field, existing);
  if (existing.meta === null) {
    context.actions.fields.push({
      collection,
      field,
      kind: 'adopt-meta',
      sort,
    });
  }
  if (flags !== null) {
    context.actions.fields.push({
      collection,
      field: field.field,
      kind: 'add-flags',
      schema: flags,
    });
  }
  const realigned = planChoices(collection, target, context);
  if (existing.meta === null || flags !== null) {
    context.tally.add('fields', 'adopted');
  } else if (realigned) {
    context.tally.align();
  } else {
    context.tally.add('fields', 'skipped');
  }
};

const planAliases = (
  collection: ModelCollection,
  byName: ReadonlyMap<string, ExistingField>,
  context: PlanContext,
): void => {
  const name = collection.collection;
  for (const [index, { alias }] of aliasesFor(name).entries()) {
    const existing = byName.get(alias.field);
    if (existing === undefined) {
      context.actions.fields.push({
        alias,
        collection: name,
        kind: 'create-alias',
        sort: collection.fields.length + index + 1,
      });
      context.tally.add('fields', 'created');
    } else if (
      existing.type === 'alias' &&
      (existing.meta?.special ?? []).includes('o2m')
    ) {
      context.tally.add('fields', 'skipped');
    } else {
      context.actions.refusals.push({
        collection: name,
        field: alias.field,
        reason: `Field ${name}.${alias.field} is not an O2M alias but the model declares one`,
      });
      context.tally.add('fields', 'refused');
    }
  }
};

// Plans the additive changes for a collection that already has a table.
export const planExistingCollection = (
  collection: ModelCollection,
  state: ExistingState,
  context: PlanContext,
): void => {
  const name = collection.collection;
  const byName = new Map(
    (state.fields.get(name) ?? []).map((field) => [field.field, field]),
  );
  const existingRelations = state.relations.get(name) ?? [];
  for (const [index, field] of collection.fields.entries()) {
    planColumn(
      name,
      {
        existing: byName.get(field.field),
        field,
        singleton: collection.singleton,
        sort: index + 1,
      },
      context,
    );
  }
  planAliases(collection, byName, context);
  for (const relation of relationsOf(name)) {
    planRelation(
      relation,
      existingRelations.find((candidate) => candidate.field === relation.field),
      context,
    );
  }
};
