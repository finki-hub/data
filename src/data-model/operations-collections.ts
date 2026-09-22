import type { ModelCollection } from '../schema.js';

import { courseTemplate, provenanceFields } from './checkpoint-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { enumField, m2o, scalar } from './fields.js';

export const enrollmentRuleModes = ['mapped_entries', 'legacy_regex'] as const;

export const importStates = [
  'idle',
  'importing',
  'validating',
  'ready',
  'promoting',
  'completed',
  'failed',
] as const;

export const publicationStates = [
  'idle',
  'running',
  'completed',
  'failed',
] as const;

export const publishedFiles = [
  'courses',
  'rooms',
  'staff',
  'students',
] as const;

// The enumerated work domains of the coordinator, in dependency order.
export const coordinationDomains = [
  'history_index',
  'enrollments',
  'publication',
] as const;

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
      enumField('mode', enrollmentRuleModes, {
        note: 'mapped_entries counts explicit mappings; legacy_regex applies the retained pattern.',
        nullable: false,
      }),
      scalar('pattern', 'text', {
        note: 'Literal regular expression retained from the checkpoint; only used by legacy_regex.',
      }),
      scalar('review_note', 'text'),
      ...provenanceFields(),
    ],
    hidden: false,
    icon: 'rule',
    note: 'One active enrollment rule per course and academic year.',
    origin: 'relational',
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
    origin: 'relational',
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
      scalar('last_error_code', 'string'),
      enumField('import_state', importStates, {
        defaultValue: 'idle',
        nullable: false,
      }),
      enumField('publication_state', publicationStates, {
        defaultValue: 'idle',
        nullable: false,
      }),
      ...publishedFiles.map((file) =>
        scalar(`publish_${file}_outcome`, 'string', {
          note: `Outcome of the last ${file}.json publication.`,
        }),
      ),
      // Coordination status written by the finki-hub-data-coordinate
      // operation and the source-invalidation trigger; appended after the
      // original columns so an installed project gains them additively.
      scalar('source_revision', 'integer', {
        defaultValue: 0,
        note: 'Incremented by the source-invalidation trigger inside every source transaction.',
        nullable: false,
        readOnly: true,
      }),
      enumField('claim_domain', coordinationDomains, { readOnly: true }),
      scalar('claim_revision', 'integer', { readOnly: true }),
      scalar('claim_fingerprint', 'string', { readOnly: true }),
      scalar('claim_started_at', 'timestamp', { readOnly: true }),
      scalar('claim_heartbeat_at', 'timestamp', {
        note: 'Refreshed by the running job; a claim silent for longer than the documented window is abandoned.',
        readOnly: true,
      }),
      scalar('claim_pages', 'json', {
        note: 'Page tokens planned under the current claim.',
        readOnly: true,
      }),
      scalar('claim_staged', 'json', {
        note: 'Page tokens staged so far under the current claim.',
        readOnly: true,
      }),
      scalar('last_error_at', 'timestamp', { readOnly: true }),
      scalar('last_failed_revision', 'integer', { readOnly: true }),
      enumField('last_failed_domain', coordinationDomains, { readOnly: true }),
      scalar('last_failed_fingerprint', 'string', { readOnly: true }),
      scalar('calculation_fingerprint', 'string', {
        note: 'Flow-graph fingerprint of the last accepted calculation.',
        readOnly: true,
      }),
      scalar('publication_fingerprint', 'string', {
        note: 'Flow-graph fingerprint of the last accepted publication.',
        readOnly: true,
      }),
    ],
    hidden: true,
    icon: 'settings_suggest',
    note: 'Private coordination singleton for derivation, import and publication status. Mutated by administrators only.',
    origin: 'relational',
    singleton: true,
    sort: 23,
  },
  {
    collection: 'data_operation_results',
    displayTemplate: '{{claim_token}} / {{page_token}}',
    fields: [
      scalar('claim_token', 'string', {
        indexed: true,
        nullable: false,
        readOnly: true,
      }),
      scalar('page_token', 'string', { nullable: false, readOnly: true }),
      m2o('course', 'courses', {
        nullable: false,
        readOnly: true,
        template: courseTemplate,
      }),
      m2o('academic_year', 'academic_years', {
        nullable: false,
        readOnly: true,
        template: academicYearTemplate,
      }),
      scalar('count', 'integer', {
        minimum: 0,
        nullable: false,
        readOnly: true,
      }),
      scalar('revision', 'integer', { readOnly: true }),
    ],
    hidden: true,
    icon: 'pending_actions',
    note: 'Temporary candidate counts staged under a claim; partial counts only, never raw users.',
    origin: 'relational',
    singleton: false,
    sort: 24,
  },
];
