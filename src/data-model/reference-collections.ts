import type { ModelCollection } from '../schema.js';

import { studentTemplate } from './content-collections.js';
import { m2o, required, scalar } from './fields.js';

// The reference lists the one-time workbook import fills beside the
// content: the Discord channels the courses link to, and the council and
// dean's office histories. No published file reads them.
export const referenceCollections: readonly ModelCollection[] = [
  {
    collection: 'discord_channels',
    displayTemplate: '{{semester}} - {{channel}}',
    // A channel's courses link to it (courses.discord_channel).
    fields: [
      scalar('semester', 'integer', { minimum: 1, nullable: false }),
      required('channel'),
    ],
    hidden: false,
    icon: 'forum',
    note: 'Discord channel aliases grouped by semester.',
    singleton: false,
    sort: 10,
  },
  {
    collection: 'student_council',
    displayTemplate: '{{year}} - {{student.name}}',
    fields: [
      required('year', 'integer'),
      required('index_number'),
      required('position'),
      m2o('student', 'students', {
        alias: {
          field: 'council_memberships',
          fields: ['year', 'position'],
          template: '{{year}} - {{position}}',
        },
        note: 'Student record of the index. Empty: needs review; the index labels the member.',
        template: studentTemplate,
      }),
    ],
    hidden: false,
    icon: 'groups_3',
    note: 'Student council membership history.',
    singleton: false,
    sort: 11,
  },
  {
    collection: 'deans_office',
    displayTemplate: '{{year}} - {{name}}',
    fields: [
      required('year', 'integer'),
      required('name'),
      required('position'),
    ],
    hidden: false,
    icon: 'account_balance',
    note: "Dean's office membership history.",
    singleton: false,
    sort: 12,
  },
];
