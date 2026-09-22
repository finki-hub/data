import type {
  CompositeKey,
  ModelCollectionKey,
  ModelRelation,
  ModelRelationAlias,
} from '../schema.js';

import { dataModelCollections } from './collections.js';

export type RelationPayload = {
  readonly collection: string;
  readonly field: string;
  readonly meta: {
    readonly junction_field: null;
    readonly one_deselect_action: 'delete' | 'nullify';
    readonly one_field: null | string;
    readonly sort_field: null | string;
  };
  readonly related_collection: string;
  readonly schema: { readonly on_delete: 'CASCADE' | 'SET NULL' };
};

// The body of `PATCH /relations/:collection/:field`. Directus drops and
// recreates the foreign key on every relation update and re-applies
// `on_delete` only from the payload, and it reads `collection` and
// `related_collection` from the payload while doing so; leaving any of them
// out silently strips the foreign key or its delete rule.
export type RelationAlignmentPayload = {
  readonly collection: string;
  readonly field: string;
  readonly meta: {
    readonly one_deselect_action: 'delete' | 'nullify';
    readonly one_field?: string;
    readonly sort_field: null | string;
  };
  readonly related_collection: string;
  readonly schema: { readonly on_delete: 'CASCADE' | 'SET NULL' };
};

export type AliasDeclaration = {
  readonly alias: ModelRelationAlias;
  readonly relation: ModelRelation;
};

// Every M2O relation of the model, derived from the collection definitions.
export const modelRelations: readonly ModelRelation[] =
  dataModelCollections.flatMap((collection) =>
    collection.fields.flatMap((field) =>
      field.kind === 'm2o'
        ? [
            {
              alias: field.alias ?? null,
              collection: collection.collection,
              field: field.field,
              nullable: field.nullable,
              onDelete: field.onDelete,
              related: field.related,
              sortField: field.sortField ?? null,
            },
          ]
        : [],
    ),
  );

export const toRelationPayload = (
  relation: ModelRelation,
): RelationPayload => ({
  collection: relation.collection,
  field: relation.field,
  meta: {
    junction_field: null,
    one_deselect_action: relation.nullable ? 'nullify' : 'delete',
    one_field: relation.alias?.field ?? null,
    sort_field: relation.sortField,
  },
  related_collection: relation.related,
  schema: { on_delete: relation.onDelete },
});

export const toRelationAlignmentPayload = (
  relation: ModelRelation,
): RelationAlignmentPayload => {
  const { collection, field, meta, related_collection, schema } =
    toRelationPayload(relation);
  return {
    collection,
    field,
    meta: {
      one_deselect_action: meta.one_deselect_action,
      ...(meta.one_field !== null && { one_field: meta.one_field }),
      sort_field: meta.sort_field,
    },
    related_collection,
    schema,
  };
};

// The O2M reverse aliases that belong on the given "one" side collection.
export const aliasesFor = (
  collection: ModelCollectionKey,
): readonly AliasDeclaration[] =>
  modelRelations.flatMap((relation) =>
    relation.related === collection && relation.alias !== null
      ? [{ alias: relation.alias, relation }]
      : [],
  );

// The M2O relations declared on the given "many" side collection.
export const relationsOf = (collection: string): readonly ModelRelation[] =>
  modelRelations.filter((relation) => relation.collection === collection);

export const findModelRelation = (
  collection: string,
  field: string,
): ModelRelation | undefined =>
  modelRelations.find(
    (relation) =>
      relation.collection === collection && relation.field === field,
  );

// Genuine domain keys and join indexes that Directus cannot create through
// its API. They are applied by the bundled `schema-constraints` migration of
// the data-operations extension; this list documents the intent and lets
// tests cross-check the shipped SQL.
export const compositeKeys: readonly CompositeKey[] = [
  {
    collection: 'course_curricula',
    columns: ['course', 'generation'],
    kind: 'unique',
    name: 'course_curricula_course_generation_unique',
  },
  {
    collection: 'moodle_history_memberships',
    columns: ['moodle_user', 'entry'],
    kind: 'unique',
    name: 'moodle_history_memberships_moodle_user_entry_unique',
  },
  {
    collection: 'moodle_course_mappings',
    columns: ['entry', 'course', 'academic_year'],
    kind: 'unique',
    name: 'moodle_course_mappings_entry_course_academic_year_unique',
  },
  {
    collection: 'moodle_course_mappings',
    columns: ['course', 'academic_year'],
    kind: 'index',
    name: 'moodle_course_mappings_course_academic_year_index',
  },
  {
    collection: 'course_enrollment_rules',
    columns: ['course', 'academic_year'],
    kind: 'unique',
    name: 'course_enrollment_rules_course_academic_year_unique',
  },
  {
    collection: 'course_enrollments',
    columns: ['course', 'academic_year'],
    kind: 'unique',
    name: 'course_enrollments_course_academic_year_unique',
  },
  {
    collection: 'data_operation_results',
    columns: ['claim_token', 'page_token', 'course', 'academic_year'],
    kind: 'unique',
    name: 'data_operation_results_claim_page_course_year_unique',
  },
];
