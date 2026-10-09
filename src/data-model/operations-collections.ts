import type { ModelCollection } from '../schema.js';

import { automaticProcessingFields } from './automatic-processing-fields.js';
import { courseTemplate } from './content-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { enumField, labelledFields, m2o, scalar } from './fields.js';
import {
  claimChoices,
  importChoices,
  publicationChoices,
  publicationStateNote,
} from './operations-vocabularies.js';
import { snapshotImportFields } from './snapshot-fields.js';

// The coordination singleton's fields, labelled below.
const dataOperationsFields = [
  scalar('requested_revision', 'integer', {
    defaultValue: 0,
    nullable: false,
  }),
  scalar('completed_revision', 'integer', {
    defaultValue: 0,
    nullable: false,
  }),
  scalar('dirty_domains', 'json'),
  scalar('claim_token', 'string'),
  scalar('claim_owner', 'string'),
  scalar('started_at', 'timestamp'),
  scalar('finished_at', 'timestamp'),
  scalar('last_run_retries', 'integer', {
    defaultValue: 0,
    nullable: false,
    readOnly: true,
  }),
  scalar('last_error_code', 'string'),
  enumField('import_state', importChoices, {
    defaultValue: 'idle',
    nullable: false,
  }),
  enumField('publication_state', publicationChoices, {
    defaultValue: 'idle',
    note: publicationStateNote,
    nullable: false,
  }),
  scalar('publication_outcomes', 'json', { readOnly: true }),
  // Coordination status written by the finki-hub-data-coordinate
  // operation and the source-invalidation trigger.
  scalar('source_revision', 'integer', {
    defaultValue: 0,
    nullable: false,
    readOnly: true,
  }),
  enumField('claim_domain', claimChoices, { readOnly: true }),
  scalar('claim_revision', 'integer', { readOnly: true }),
  scalar('claim_fingerprint', 'string', { readOnly: true }),
  scalar('claim_started_at', 'timestamp', { readOnly: true }),
  scalar('claim_heartbeat_at', 'timestamp', {
    note: 'A stale heartbeat releases the claim as abandoned.',
    readOnly: true,
  }),
  scalar('claim_pages', 'json', { readOnly: true }),
  scalar('claim_staged', 'json', { readOnly: true }),
  scalar('claim_retries', 'integer', {
    defaultValue: 0,
    nullable: false,
    readOnly: true,
  }),
  scalar('last_error_at', 'timestamp', { readOnly: true }),
  scalar('last_failed_revision', 'integer', { readOnly: true }),
  enumField('last_failed_domain', claimChoices, { readOnly: true }),
  scalar('last_failed_fingerprint', 'string', { readOnly: true }),
  scalar('last_error_retries', 'integer', {
    defaultValue: 0,
    nullable: false,
    readOnly: true,
  }),
  scalar('calculation_fingerprint', 'string', { readOnly: true }),
  scalar('publication_fingerprint', 'string', { readOnly: true }),
  ...snapshotImportFields,
  ...automaticProcessingFields,
];

type DataOperationsField = (typeof dataOperationsFields)[number]['field'];

// The label of each field of the singleton; a field without one does not
// compile. The form groups (presentation/groups.ts) name what they share.
const dataOperationsLabels: Readonly<Record<DataOperationsField, string>> = {
  calculation_fingerprint: 'Calculation fingerprint',
  claim_domain: 'Claim domain',
  claim_fingerprint: 'Claim fingerprint',
  claim_heartbeat_at: 'Claim heartbeat',
  claim_owner: 'Claim owner',
  claim_pages: 'Claim pages',
  claim_retries: 'Claim retries',
  claim_revision: 'Claim revision',
  claim_staged: 'Staged pages',
  claim_started_at: 'Claim started',
  claim_token: 'Claim token',
  completed_revision: 'Completed revision',
  dirty_domains: 'Pending domains',
  enrollments_input_revision: 'Enrollment input revision',
  finished_at: 'Finished',
  history_index_input_revision: 'History index input revision',
  import_backup_file: 'Backup file',
  import_backup_fingerprint: 'Backup fingerprint',
  import_backup_rows: 'Backup rows',
  import_error: 'Error',
  import_file: 'Staged file',
  import_fingerprint: 'Staged fingerprint',
  import_finished_at: 'Finished',
  import_promoted_at: 'Promoted at',
  import_promoted_fingerprint: 'Active fingerprint',
  import_promoted_rows: 'Active rows',
  import_rows: 'Staged rows',
  import_started_at: 'Started',
  import_state: 'Snapshot import',
  import_token: 'Guard token',
  import_warnings: 'Warnings',
  last_error_at: 'Failed at',
  last_error_code: 'Error code',
  last_error_message: 'Error message',
  last_error_retries: 'Failed run retries',
  last_failed_domain: 'Failed domain',
  last_failed_fingerprint: 'Failed fingerprint',
  last_failed_revision: 'Failed revision',
  last_run_retries: 'Retries',
  publication_fingerprint: 'Publication fingerprint',
  publication_outcomes: 'Publication outcomes',
  publication_state: 'Publication',
  requested_revision: 'Requested revision',
  source_revision: 'Source revision',
  started_at: 'Started',
};

export const operationsCollections: readonly ModelCollection[] = [
  {
    collection: 'course_enrollments',
    displayTemplate: '{{course.name}} - {{academic_year.label}}: {{count}}',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'enrollments',
          fields: ['academic_year', 'count', 'computed_at'],
          label: 'Enrollment counts',
          readOnly: true,
          template: '{{academic_year.label}}: {{count}}',
        },
        label: 'Course',
        nullable: false,
        readOnly: true,
        template: courseTemplate,
      }),
      m2o('academic_year', 'academic_years', {
        alias: {
          field: 'enrollments',
          fields: ['course', 'count', 'computed_at'],
          label: 'Enrollment counts',
          readOnly: true,
          template: '{{course.name}}: {{count}}',
        },
        label: 'Academic year',
        nullable: false,
        readOnly: true,
        template: academicYearTemplate,
      }),
      scalar('count', 'integer', {
        label: 'Count',
        minimum: 0,
        nullable: false,
        readOnly: true,
      }),
      scalar('computed_revision', 'integer', {
        label: 'Computed at revision',
        nullable: false,
        readOnly: true,
      }),
      scalar('computed_at', 'timestamp', {
        label: 'Computed at',
        nullable: false,
        readOnly: true,
      }),
    ],
    hidden: false,
    icon: 'functions',
    label: { plural: 'Enrollment counts', singular: 'Enrollment count' },
    singleton: false,
    sort: 22,
  },
  {
    collection: 'data_operations',
    displayTemplate: 'Data operations',
    fields: labelledFields(dataOperationsFields, dataOperationsLabels),
    hidden: true,
    icon: 'settings_suggest',
    label: { plural: 'Data operations', singular: 'Data operations' },
    singleton: true,
    sort: 23,
  },
];
