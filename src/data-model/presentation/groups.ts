import type { FieldGroup } from './types.js';

import { findModelCollection } from '../collections.js';

const derivedFields = (collection: string): readonly string[] =>
  (findModelCollection(collection)?.fields ?? []).flatMap(
    ({ field, readOnly }) => (readOnly === true ? [field] : []),
  );

// The course form: relational sections first, the checkpoint's derived
// columns last, collapsed and read-only, never deleted.
export const fieldGroups: readonly FieldGroup[] = [
  {
    collection: 'courses',
    field: 'overview',
    headerIcon: 'school',
    members: ['name', 'tags'],
    sort: 1,
    start: 'open',
  },
  {
    collection: 'courses',
    field: 'curriculum',
    headerIcon: 'menu_book',
    members: [
      'curricula',
      'equivalencies',
      'name_2023',
      'credits_2023',
      'available_2023',
      'name_2018_override',
      'credits_2018',
      'available_2018',
    ],
    note: 'Curriculum links carry the generation, entry, credits and availability; the 2023 and 2018 columns are the checkpoint sources they replace.',
    sort: 2,
    start: 'open',
  },
  {
    collection: 'courses',
    field: 'staff',
    headerIcon: 'co_present',
    members: ['assignments', 'professors_override'],
    sort: 3,
    start: 'open',
  },
  {
    collection: 'courses',
    field: 'moodle',
    headerIcon: 'history_edu',
    members: ['history_mappings'],
    sort: 4,
    start: 'open',
  },
  {
    collection: 'courses',
    field: 'enrollment',
    headerIcon: 'functions',
    members: ['enrollment_rules', 'enrollments'],
    sort: 5,
    start: 'open',
  },
  {
    collection: 'courses',
    field: 'legacy_calculated',
    headerIcon: 'history',
    members: derivedFields('courses'),
    note: 'Columns the checkpoint derivation computes for the published JSON. Kept for compatibility; not edited by hand.',
    readOnly: true,
    sort: 6,
    start: 'closed',
  },
  {
    collection: 'teaching_assignments',
    field: 'legacy_imported',
    headerIcon: 'history',
    members: ['professors', 'assistants', 'source_collection', 'source_id'],
    note: 'Imported checkpoint labels and migration provenance, kept until every row is converted into course, staff and role links.',
    sort: 20,
    start: 'closed',
  },
];

export const findFieldGroup = (
  collection: string,
  field: string,
): FieldGroup | undefined =>
  fieldGroups.find(
    (group) => group.collection === collection && group.field === field,
  );
