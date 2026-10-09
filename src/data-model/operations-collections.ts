import type { ModelCollection } from '../schema.js';

import { automaticProcessingFields } from './automatic-processing-fields.js';
import { courseTemplate } from './content-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { enumField, m2o, scalar } from './fields.js';
import {
  claimChoices,
  importChoices,
  modeChoices,
  modeNote,
  patternNote,
  publicationChoices,
  publicationStateNote,
} from './operations-vocabularies.js';
import { snapshotImportFields } from './snapshot-fields.js';

// The note of a retry counter: whose transactions ran again.
const retriesNote = (run: string): string =>
  `Transaction retries of ${run} (deadlock or serialization failure).`;

export const operationsCollections: readonly ModelCollection[] = [
  {
    collection: 'course_enrollment_rules',
    displayTemplate: '{{course.name}} - {{academic_year.label}} ({{mode}})',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'enrollment_rules',
          fields: ['academic_year', 'mode', 'pattern'],
          template: '{{academic_year.label}} ({{mode}})',
        },
        nullable: false,
        template: courseTemplate,
      }),
      m2o('academic_year', 'academic_years', {
        alias: {
          field: 'enrollment_rules',
          fields: ['course', 'mode', 'pattern'],
          template: '{{course.name}} ({{mode}})',
        },
        nullable: false,
        template: academicYearTemplate,
      }),
      enumField('mode', modeChoices, { note: modeNote, nullable: false }),
      scalar('pattern', 'text', { note: patternNote }),
      scalar('review_note', 'text'),
    ],
    hidden: false,
    icon: 'rule',
    note: 'One active enrollment rule per course and academic year.',
    singleton: false,
    sort: 21,
  },
  {
    collection: 'course_enrollments',
    displayTemplate: '{{course.name}} - {{academic_year.label}}: {{count}}',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'enrollments',
          fields: ['academic_year', 'count', 'computed_at'],
          readOnly: true,
          template: '{{academic_year.label}}: {{count}}',
        },
        nullable: false,
        readOnly: true,
        template: courseTemplate,
      }),
      m2o('academic_year', 'academic_years', {
        alias: {
          field: 'enrollments',
          fields: ['course', 'count', 'computed_at'],
          readOnly: true,
          template: '{{course.name}}: {{count}}',
        },
        nullable: false,
        readOnly: true,
        template: academicYearTemplate,
      }),
      scalar('count', 'integer', {
        minimum: 0,
        nullable: false,
        readOnly: true,
      }),
      scalar('computed_revision', 'integer', {
        nullable: false,
        readOnly: true,
      }),
      scalar('computed_at', 'timestamp', { nullable: false, readOnly: true }),
    ],
    hidden: false,
    icon: 'functions',
    note: 'Derived enrollment counts; rewritten by the calculation Flows, never edited by hand.',
    singleton: false,
    sort: 22,
  },
  {
    collection: 'data_operations',
    displayTemplate: 'Data operations',
    fields: [
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
        note: retriesNote('the last completed run'),
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
      scalar('publication_outcomes', 'json', {
        note: 'One outcome per declared public file of the last publication that recorded one, keyed by filename: uploaded, failed or skipped, its failure code, the bytes written and the source revision attempted.',
        readOnly: true,
      }),
      // Coordination status written by the finki-hub-data-coordinate
      // operation and the source-invalidation trigger.
      scalar('source_revision', 'integer', {
        defaultValue: 0,
        note: 'Incremented by the source-invalidation trigger inside every source transaction.',
        nullable: false,
        readOnly: true,
      }),
      enumField('claim_domain', claimChoices, { readOnly: true }),
      scalar('claim_revision', 'integer', { readOnly: true }),
      scalar('claim_fingerprint', 'string', { readOnly: true }),
      scalar('claim_started_at', 'timestamp', { readOnly: true }),
      scalar('claim_heartbeat_at', 'timestamp', {
        note: 'Heartbeat of the running job; a stale claim is released as abandoned.',
        readOnly: true,
      }),
      scalar('claim_pages', 'json', {
        note: 'Pages planned under the current claim: token, first and last source id, row count.',
        readOnly: true,
      }),
      scalar('claim_staged', 'json', {
        note: 'Page tokens staged so far under the current claim.',
        readOnly: true,
      }),
      scalar('claim_retries', 'integer', {
        defaultValue: 0,
        note: retriesNote('the current claim'),
        nullable: false,
        readOnly: true,
      }),
      scalar('last_error_at', 'timestamp', { readOnly: true }),
      scalar('last_failed_revision', 'integer', { readOnly: true }),
      enumField('last_failed_domain', claimChoices, { readOnly: true }),
      scalar('last_failed_fingerprint', 'string', { readOnly: true }),
      scalar('last_error_retries', 'integer', {
        defaultValue: 0,
        note: retriesNote('the last failed or discarded run'),
        nullable: false,
        readOnly: true,
      }),
      scalar('calculation_fingerprint', 'string', {
        note: 'Flow-graph fingerprint of the last accepted calculation.',
        readOnly: true,
      }),
      scalar('publication_fingerprint', 'string', {
        note: 'Flow-graph fingerprint of the last accepted publication.',
        readOnly: true,
      }),
      ...snapshotImportFields,
      ...automaticProcessingFields,
    ],
    hidden: true,
    icon: 'settings_suggest',
    note: 'Private coordination singleton for derivation, import and publication status.',
    singleton: true,
    sort: 23,
  },
];
