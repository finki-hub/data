import type { ModelCollection, ModelScalarField } from '../schema.js';

import {
  type SnapshotFieldDeclaration,
  snapshotFieldTable,
} from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { courseTemplate } from './content-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { enumField, labelledChoices, m2o, scalar } from './fields.js';

const reviewStates = ['needs_mapping', 'mapped', 'ignored'] as const;

const reviewChoices = labelledChoices(reviewStates, {
  ignored: 'Ignored',
  mapped: 'Mapped',
  needs_mapping: 'Needs mapping',
});

const moodleUserTemplate = '{{Name}}';
const historyEntryTemplate = '{{label}}';

// The Moodle user columns: the scraper fields of the snapshot contract,
// with the same names and kinds in the snapshot staging rows.
const moodleUserFields: readonly ModelScalarField[] = snapshotFieldTable.map(
  ({ field, kind, ...declaration }: SnapshotFieldDeclaration) => ({
    field,
    kind,
    nullable: declaration.required !== true,
  }),
);

export const moodleCollections: readonly ModelCollection[] = [
  {
    collection: 'moodle_users',
    displayTemplate: moodleUserTemplate,
    fields: moodleUserFields,
    hidden: false,
    icon: 'person',
    note: 'Private Moodle profile snapshot. Use Studio search and filters instead of the Пребарување sheet.',
    singleton: false,
    sort: 13,
  },
  {
    collection: 'moodle_import_rows',
    displayTemplate: moodleUserTemplate,
    fields: moodleUserFields,
    hidden: true,
    icon: 'upload_file',
    note: 'Replaceable staging rows written only by the controlled Moodle snapshot import. Never read by Search, derivation or publication.',
    singleton: false,
    sort: 17,
  },
  {
    collection: 'moodle_course_entries',
    displayTemplate: historyEntryTemplate,
    fields: [
      scalar('label', 'text', {
        note: 'Exact history entry text of at most 2048 bytes (the unique index bound); no trimming, case folding or transliteration. Written by the history index run only.',
        nullable: false,
        readOnly: true,
        unique: true,
      }),
      enumField('review_state', reviewChoices, {
        defaultValue: 'needs_mapping',
        nullable: false,
      }),
      scalar('review_reason', 'text', {
        note: 'Why this entry is ignored or otherwise needs attention.',
      }),
    ],
    hidden: false,
    icon: 'history_edu',
    note: 'Distinct Moodle course history entries with their mapping review state.',
    singleton: false,
    sort: 18,
  },
  {
    collection: 'moodle_history_memberships',
    displayTemplate: '{{moodle_user.Name}} - {{entry.label}}',
    fields: [
      m2o('moodle_user', 'moodle_users', {
        alias: {
          field: 'history_memberships',
          // Each raw history line with its review state and the course
          // and year of its mappings, so a user opened from Search leads
          // to the mappings of their lines without Search itself matching
          // through them.
          fields: [
            'entry',
            'entry.review_state',
            'entry.mappings.course',
            'entry.mappings.academic_year',
            'sort',
          ],
          readOnly: true,
          template: '{{entry.label}}',
        },
        nullable: false,
        readOnly: true,
        sortField: 'sort',
        template: moodleUserTemplate,
      }),
      m2o('entry', 'moodle_course_entries', {
        alias: {
          field: 'memberships',
          fields: ['moodle_user', 'sort'],
          readOnly: true,
          template: '{{moodle_user.Name}}',
        },
        nullable: false,
        readOnly: true,
        template: historyEntryTemplate,
      }),
      scalar('sort', 'integer', {
        note: 'Position of the first occurrence inside the raw history.',
        readOnly: true,
      }),
    ],
    hidden: true,
    icon: 'account_tree',
    note: 'Replaceable derived index of which history entries each Moodle user carries.',
    singleton: false,
    sort: 19,
  },
  {
    collection: 'moodle_course_mappings',
    displayTemplate:
      '{{entry.label}} - {{course.name}} ({{academic_year.label}})',
    fields: [
      m2o('entry', 'moodle_course_entries', {
        alias: {
          field: 'mappings',
          fields: ['course', 'academic_year'],
          template: '{{course.name}} ({{academic_year.label}})',
        },
        nullable: false,
        template: historyEntryTemplate,
      }),
      m2o('course', 'courses', {
        alias: {
          field: 'history_mappings',
          fields: ['entry', 'academic_year'],
          template: '{{entry.label}} ({{academic_year.label}})',
        },
        nullable: false,
        template: courseTemplate,
      }),
      m2o('academic_year', 'academic_years', {
        alias: {
          field: 'mappings',
          fields: ['course', 'entry'],
          template: '{{course.name}}: {{entry.label}}',
        },
        nullable: false,
        template: academicYearTemplate,
      }),
    ],
    hidden: false,
    icon: 'alt_route',
    note: 'Explicit mapping of a history entry to a course and academic year; edited from either side.',
    singleton: false,
    sort: 20,
  },
];
