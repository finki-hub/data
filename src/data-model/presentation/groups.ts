import type { FieldGroup } from './types.js';

import { findModelCollection } from '../collections.js';

const derivedFields = (collection: string): readonly string[] =>
  (findModelCollection(collection)?.fields ?? []).flatMap(
    ({ field, readOnly }) => (readOnly === true ? [field] : []),
  );

// The six per-generation course columns the one-time import copies into
// course_curricula once: read-only import input that no export reads,
// dropped in the deferred cleanup.
export const legacyImportColumns = [
  'name_2023',
  'credits_2023',
  'available_2023',
  'name_2018_override',
  'credits_2018',
  'available_2018',
] as const;

// The course form: relational sections first, the checkpoint's derived
// columns and the import input last, collapsed and read-only, never
// deleted.
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
    members: ['curricula', 'equivalencies'],
    note: 'Curriculum links carry the generation, entry, credits and availability; equivalencies list their members, one label per generation.',
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
    note: 'Moodle history entries mapped to this course per academic year; edited here or from the entry, kept across every re-index.',
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
    note: 'Columns the removed checkpoint derivation computed. Nothing fills or publishes them any more; kept until the cleanup drops them, not edited by hand.',
    readOnly: true,
    sort: 6,
    start: 'closed',
  },
  {
    collection: 'courses',
    field: 'legacy_import',
    headerIcon: 'input',
    members: legacyImportColumns,
    note: 'The 2023 and 2018 columns of the workbook, copied once into the curriculum links by the import. Read-only import input: edit the curriculum links instead; no public file reads these.',
    readOnly: true,
    sort: 7,
    start: 'closed',
  },
  // The history entry form: the exact label with its review state first,
  // the mappings that make it count, then the derived users read-only.
  {
    collection: 'moodle_course_entries',
    field: 'review',
    headerIcon: 'history_edu',
    members: ['label', 'review_state', 'review_reason'],
    note: 'One exact Moodle history line and its review state. New lines arrive as "Needs mapping" from the index run.',
    sort: 1,
    start: 'open',
  },
  {
    collection: 'moodle_course_entries',
    field: 'mapping',
    headerIcon: 'alt_route',
    members: ['mappings'],
    note: 'Courses and academic years this entry stands for: independent source data that no re-index deletes.',
    sort: 2,
    start: 'open',
  },
  {
    collection: 'moodle_course_entries',
    field: 'usage',
    headerIcon: 'account_tree',
    members: ['memberships'],
    note: 'Moodle users carrying this entry: the derived index, replaced by every index run and never edited.',
    readOnly: true,
    sort: 3,
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
      'history_index_input_revision',
      'enrollments_input_revision',
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
      'claim_retries',
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
      'last_error_message',
      'last_error_at',
      'last_failed_revision',
      'last_failed_domain',
      'last_failed_fingerprint',
      'last_error_retries',
    ],
    note: 'The last failure stays recorded after a later success; it holds its domain back only while the source and Flow graph are still at its revision (the status reports this as blocking).',
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
      'last_run_retries',
      'publication_outcomes',
    ],
    sort: 4,
    start: 'closed',
  },
  {
    collection: 'data_operations',
    field: 'snapshot',
    headerIcon: 'upload_file',
    members: [
      'import_file',
      'import_rows',
      'import_fingerprint',
      'import_warnings',
      'import_error',
      'import_started_at',
      'import_finished_at',
      'import_backup_file',
      'import_backup_rows',
      'import_backup_fingerprint',
      'import_promoted_rows',
      'import_promoted_fingerprint',
      'import_promoted_at',
      'import_token',
    ],
    note: 'The controlled Moodle snapshot import: upload the CSV to the File Library, then run "Data / Import Moodle snapshot". Written by the import and promotion only.',
    readOnly: true,
    sort: 5,
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
