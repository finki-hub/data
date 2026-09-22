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
  // The coordination singleton: status the operation and the trigger own
  // is shown read-only; only the run outcomes stay editable for an
  // operator's manual reset.
  {
    collection: 'data_operations',
    field: 'revisions',
    headerIcon: 'history_toggle_off',
    members: [
      'source_revision',
      'requested_revision',
      'completed_revision',
      'dirty_domains',
      'calculation_fingerprint',
      'publication_fingerprint',
    ],
    note: 'Source revision and the domains still pending; written by the source-invalidation trigger and the coordinator.',
    readOnly: true,
    sort: 1,
    start: 'open',
  },
  {
    collection: 'data_operations',
    field: 'claim',
    headerIcon: 'sync_lock',
    members: [
      'claim_token',
      'claim_owner',
      'claim_domain',
      'claim_revision',
      'claim_fingerprint',
      'claim_started_at',
      'claim_heartbeat_at',
      'claim_pages',
      'claim_staged',
    ],
    note: 'The one running job. A claim silent for longer than the documented window is released as abandoned.',
    readOnly: true,
    sort: 2,
    start: 'open',
  },
  {
    collection: 'data_operations',
    field: 'failure',
    headerIcon: 'error',
    members: [
      'last_error_code',
      'last_error_at',
      'last_failed_revision',
      'last_failed_domain',
      'last_failed_fingerprint',
    ],
    note: 'Kept until an explicit retry or a newer source or graph revision succeeds.',
    readOnly: true,
    sort: 3,
    start: 'closed',
  },
  {
    collection: 'data_operations',
    field: 'outcomes',
    headerIcon: 'task_alt',
    members: [
      'import_state',
      'publication_state',
      'started_at',
      'finished_at',
      'publish_courses_outcome',
      'publish_rooms_outcome',
      'publish_staff_outcome',
      'publish_students_outcome',
    ],
    sort: 4,
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
