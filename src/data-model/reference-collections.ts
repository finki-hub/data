import type { ModelCollection } from '../schema.js';

import { deanPositions } from './choice-lists.js';
import {
  channelTemplate,
  staffTemplate,
  studentTemplate,
} from './content-collections.js';
import { enumField, m2o, required, scalar } from './fields.js';

// The reference lists the one-time workbook import fills beside the
// content: the Discord channels the courses link to, and the council and
// dean's office histories. No published file reads them.
export const referenceCollections: readonly ModelCollection[] = [
  {
    collection: 'discord_channels',
    displayTemplate: channelTemplate,
    // A channel's courses link to it (courses.discord_channel).
    fields: [
      scalar('semester', 'integer', {
        label: 'Semester',
        minimum: 1,
        nullable: false,
      }),
      required('channel', 'string', { label: 'Channel' }),
    ],
    hidden: false,
    icon: 'forum',
    label: { plural: 'Discord channels', singular: 'Discord channel' },
    singleton: false,
    sort: 10,
  },
  {
    collection: 'student_council',
    displayTemplate: '{{year}} - {{student.name}}',
    fields: [
      required('year', 'integer', { label: 'Year' }),
      required('index_number', 'string', { label: 'Index number' }),
      required('position', 'string', { label: 'Position' }),
      m2o('student', 'students', {
        alias: {
          field: 'council_memberships',
          fields: ['year', 'position'],
          label: 'Council memberships',
          template: '{{year}} - {{position}}',
        },
        label: 'Student',
        template: studentTemplate,
      }),
    ],
    hidden: false,
    icon: 'groups_3',
    label: { plural: 'Student council', singular: 'Council member' },
    singleton: false,
    sort: 11,
  },
  {
    collection: 'deans_office',
    displayTemplate: '{{year}} {{position}}: {{staff.name}}',
    fields: [
      required('year', 'integer', { label: 'Year' }),
      // The holder of a term: one per year and position
      // (deans_office_year_position_unique). A staff member who holds a
      // term cannot be deleted (NO ACTION), and taking a term out of the
      // staff form's list deletes it.
      m2o('staff', 'staff', {
        alias: {
          field: 'dean_terms',
          fields: ['year', 'position'],
          label: "Dean's office terms",
          template: '{{year}} {{position}}',
        },
        label: 'Staff member',
        nullable: false,
        onDelete: 'NO ACTION',
        template: staffTemplate,
      }),
      enumField('position', deanPositions, {
        label: 'Position',
        nullable: false,
      }),
    ],
    hidden: false,
    icon: 'account_balance',
    label: { plural: "Dean's office", singular: "Dean's office term" },
    singleton: false,
    sort: 12,
  },
];
