import type { ModelCollection } from '../schema.js';

import {
  type SnapshotField,
  type SnapshotFieldDeclaration,
  snapshotFieldTable,
} from '../../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { courseTemplate } from './content-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { labelledFields, m2o, scalar } from './fields.js';

const moodleUserTemplate = '{{Name}}';
const historyEntryTemplate = '{{label}}';

// One history line mapped by hand to a course and academic year; its
// aliases on the line, the course and the year carry the same name.
const explicitMappings = {
  plural: 'Explicit mappings',
  singular: 'Explicit mapping',
} as const;

// The label of each scraper field; "(old)" and "(new)" name the two
// Moodle instances. A new field of the snapshot contract needs one.
const snapshotLabels: Readonly<Record<SnapshotField, string>> = {
  AIM_new: 'AIM (new)',
  AIM_old: 'AIM (old)',
  Avatar_new: 'Avatar (new)',
  Avatar_old: 'Avatar (old)',
  City_new: 'City (new)',
  City_old: 'City (old)',
  Country_new: 'Country (new)',
  Country_old: 'Country (old)',
  Courses: 'Course history',
  'Courses Count': 'Course count',
  Description_new: 'Description (new)',
  Description_old: 'Description (old)',
  ICQ_new: 'ICQ (new)',
  ICQ_old: 'ICQ (old)',
  ID_new: 'Moodle ID (new)',
  ID_old: 'Moodle ID (old)',
  Images_new: 'Images (new)',
  Images_old: 'Images (old)',
  Interests_new: 'Interests (new)',
  Interests_old: 'Interests (old)',
  'Last Access_new': 'Last access (new)',
  'Last Access_old': 'Last access (old)',
  Mail: 'Email',
  MoodleNet_new: 'MoodleNet (new)',
  MoodleNet_old: 'MoodleNet (old)',
  MSN_new: 'MSN (new)',
  MSN_old: 'MSN (old)',
  Name: 'Name',
  Profile_new: 'Profile (new)',
  Profile_old: 'Profile (old)',
  Skype_new: 'Skype (new)',
  Skype_old: 'Skype (old)',
  Timezone_new: 'Timezone (new)',
  Timezone_old: 'Timezone (old)',
  Web_new: 'Website (new)',
  Web_old: 'Website (old)',
  Yahoo_new: 'Yahoo (new)',
  Yahoo_old: 'Yahoo (old)',
};

// The Moodle user columns: the scraper fields of the snapshot contract,
// with the same names, kinds and labels in the snapshot staging rows.
const moodleUserFields = labelledFields(
  snapshotFieldTable.map(
    ({
      field,
      kind,
      ...declaration
    }: SnapshotFieldDeclaration & { readonly field: SnapshotField }) => ({
      field,
      kind,
      nullable: declaration.required !== true,
    }),
  ),
  snapshotLabels,
);

export const moodleCollections: readonly ModelCollection[] = [
  {
    collection: 'moodle_users',
    displayTemplate: moodleUserTemplate,
    fields: moodleUserFields,
    hidden: false,
    icon: 'person',
    label: { plural: 'Moodle users', singular: 'Moodle user' },
    singleton: false,
    sort: 13,
  },
  {
    collection: 'moodle_import_rows',
    displayTemplate: moodleUserTemplate,
    fields: moodleUserFields,
    hidden: true,
    icon: 'upload_file',
    label: {
      plural: 'Snapshot staging rows',
      singular: 'Snapshot staging row',
    },
    note: 'Written only by the Moodle snapshot import; nothing else reads it.',
    singleton: false,
    sort: 17,
  },
  {
    collection: 'moodle_course_entries',
    displayTemplate: historyEntryTemplate,
    fields: [
      scalar('label', 'text', {
        label: 'Line',
        nullable: false,
        readOnly: true,
        unique: true,
      }),
      // Written once, in the history index's INSERT that creates the
      // entry; an entry created any other way keeps it empty.
      scalar('first_seen', 'timestamp', {
        label: 'First seen',
        note: 'When the history index first created this line.',
        readOnly: true,
      }),
    ],
    hidden: false,
    icon: 'history_edu',
    label: { plural: 'History lines', singular: 'History line' },
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
          // Each raw history line with the courses and years the last
          // count counted it for, so a user opened from Search shows where
          // their lines count without Search itself matching through them.
          fields: [
            'entry',
            'entry.counted_for.course',
            'entry.counted_for.academic_year',
            'sort',
          ],
          label: 'History lines',
          readOnly: true,
          template: '{{entry.label}}',
        },
        label: 'Moodle user',
        nullable: false,
        readOnly: true,
        sortField: 'sort',
        template: moodleUserTemplate,
      }),
      m2o('entry', 'moodle_course_entries', {
        alias: {
          field: 'memberships',
          fields: ['moodle_user', 'sort'],
          label: 'Users',
          readOnly: true,
          template: '{{moodle_user.Name}}',
        },
        label: 'History line',
        nullable: false,
        readOnly: true,
        template: historyEntryTemplate,
      }),
      scalar('sort', 'integer', {
        label: 'Order',
        readOnly: true,
      }),
    ],
    hidden: true,
    icon: 'account_tree',
    label: { plural: 'History memberships', singular: 'History membership' },
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
          label: explicitMappings.plural,
          note: 'An explicit mapping replaces every pattern for this line.',
          template: '{{course.name}} ({{academic_year.label}})',
        },
        label: 'History line',
        nullable: false,
        template: historyEntryTemplate,
      }),
      m2o('course', 'courses', {
        alias: {
          field: 'history_mappings',
          fields: ['entry', 'academic_year'],
          label: explicitMappings.plural,
          template: '{{entry.label}} ({{academic_year.label}})',
        },
        label: 'Course',
        nullable: false,
        template: courseTemplate,
      }),
      m2o('academic_year', 'academic_years', {
        alias: {
          field: 'mappings',
          fields: ['course', 'entry'],
          label: explicitMappings.plural,
          template: '{{course.name}}: {{entry.label}}',
        },
        label: 'Academic year',
        nullable: false,
        template: academicYearTemplate,
      }),
    ],
    hidden: false,
    icon: 'alt_route',
    label: explicitMappings,
    singleton: false,
    sort: 20,
  },
];
