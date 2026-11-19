import type { CompositeKey, ModelRelation } from '../schema-relations.js';
import type {
  ModelCollection,
  ModelRelationAlias,
  OnDelete,
  RelatedCollection,
} from '../schema.js';

import { dataModelCollections } from './collections.js';
import { degreeProgramKeys } from './generation-collections.js';
import { mappingKeys } from './mapping-collections.js';
import { teachingKeys } from './teaching-collections.js';
import { thesisKeys } from './thesis-collections.js';

type RelationPayload = {
  readonly collection: string;
  readonly field: string;
  readonly meta: {
    readonly junction_field: null | string;
    readonly one_deselect_action: 'delete' | 'nullify';
    readonly one_field: null | string;
    readonly sort_field: null | string;
  };
  readonly related_collection: string;
  readonly schema: { readonly on_delete: OnDelete };
};

// The body of `PATCH /relations/:collection/:field`. Directus drops and
// recreates the foreign key on every relation update and re-applies
// `on_delete` only from the payload, and it reads `collection` and
// `related_collection` from the payload while doing so; leaving any of them
// out silently strips the foreign key or its delete rule.
type RelationAlignmentPayload = {
  readonly collection: string;
  readonly field: string;
  readonly meta: {
    readonly junction_field?: string;
    readonly one_deselect_action: 'delete' | 'nullify';
    readonly one_field?: string;
    readonly sort_field: null | string;
  };
  readonly related_collection: string;
  readonly schema: { readonly on_delete: OnDelete };
};

export type AliasDeclaration = {
  readonly alias: ModelRelationAlias;
  readonly relation: ModelRelation;
};

// The other relation of a junction: the one this field's alias lists
// through the collection, or the one whose alias lists this field's rows.
const junctionOf = (
  collection: ModelCollection,
  field: string,
): null | string => {
  for (const candidate of collection.fields) {
    if (candidate.kind !== 'm2o') {
      continue;
    }
    const junction = candidate.alias?.junction;
    if (candidate.field === field && junction !== undefined) {
      return junction;
    }
    if (junction === field) {
      return candidate.field;
    }
  }
  return null;
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
              junction: junctionOf(collection, field.field),
              nullable: field.nullable,
              onDelete: field.onDelete,
              related: field.related,
              sortField: field.sortField ?? null,
            },
          ]
        : [],
    ),
  );

// Removing a row from the "one" side's list does what deleting that side
// does to it: a required or CASCADE link deletes the row, an optional one
// is nullified. An only-in-year pattern mapping cannot lose its year.
export const toRelationPayload = (
  relation: ModelRelation,
): RelationPayload => ({
  collection: relation.collection,
  field: relation.field,
  meta: {
    junction_field: relation.junction,
    one_deselect_action:
      relation.nullable && relation.onDelete !== 'CASCADE'
        ? 'nullify'
        : 'delete',
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
      ...(meta.junction_field !== null && {
        junction_field: meta.junction_field,
      }),
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
  collection: RelatedCollection,
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
    collection: 'teaching_assignments',
    columns: ['course', 'staff', 'role'],
    kind: 'unique',
    name: 'teaching_assignments_course_staff_role_unique',
  },
  // One holder per year and position of the dean's office.
  {
    collection: 'deans_office',
    columns: ['year', 'position'],
    kind: 'unique',
    name: 'deans_office_year_position_unique',
  },
  {
    collection: 'course_curricula',
    columns: ['course', 'generation'],
    kind: 'unique',
    name: 'course_curricula_course_generation_unique',
  },
  {
    collection: 'study_programs',
    columns: ['generation', 'code'],
    kind: 'unique',
    name: 'study_programs_generation_code_unique',
  },
  {
    collection: 'curriculum_entry_program_states',
    columns: ['entry', 'program'],
    kind: 'unique',
    name: 'curriculum_entry_program_states_entry_program_unique',
  },
  {
    collection: 'course_equivalency_members',
    columns: ['equivalency', 'generation'],
    kind: 'unique',
    name: 'course_equivalency_members_equivalency_generation_unique',
  },
  // A channel links a course once.
  {
    collection: 'discord_channel_courses',
    columns: ['discord_channel', 'course'],
    kind: 'unique',
    name: 'discord_channel_courses_discord_channel_course_unique',
  },
  {
    collection: 'moodle_history_memberships',
    columns: ['moodle_user', 'entry'],
    kind: 'unique',
    name: 'moodle_history_memberships_moodle_user_entry_unique',
  },
  // The users of a line. Directus gives an indexed column an index of this
  // name, so the statement adds it only where that index is missing.
  {
    collection: 'moodle_history_memberships',
    columns: ['entry'],
    kind: 'index',
    name: 'moodle_history_memberships_entry_index',
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
    collection: 'moodle_left_uncounted',
    columns: ['entry'],
    kind: 'unique',
    name: 'moodle_left_uncounted_entry_unique',
  },
  ...mappingKeys,
  {
    collection: 'course_enrollments',
    columns: ['course', 'academic_year'],
    kind: 'unique',
    name: 'course_enrollments_course_academic_year_unique',
  },
  ...teachingKeys,
  ...thesisKeys,
  ...degreeProgramKeys,
];
