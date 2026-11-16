import type { CompositeKey } from '../schema-relations.js';
import type { ModelCollection } from '../schema.js';

import {
  committeeRoles,
  thesisLevels,
} from '../../directus/extensions/directus-extension-data-operations/src/theses/vocabulary.js';
import { staffTemplate } from './content-collections.js';
import { enumField, labelledChoices, m2o, required, scalar } from './fields.js';

// FCSE's bachelor's and master's theses: Data / Import theses reads them
// from the theses APIs of theses-listing (bachelors-api and
// masters-api.finki-hub.com) and derives thesis_committee from their
// mentor and committee names, matched to staff as the timetables' teachers
// are (by name and through staff_aliases).

export const thesisTemplate = '{{title}}';

const levelChoices = labelledChoices(thesisLevels, {
  bachelor: 'Bachelor',
  master: 'Master',
});

const roleChoices = labelledChoices(committeeRoles, {
  member: 'Member',
  mentor: 'Mentor',
  president: 'President',
});

// What a derived field says about where it comes from.
const imported = { readOnly: true } as const;

// A name as the thesis gives it.
const committeeName = (field: string, label: string, note?: string) =>
  scalar(field, 'string', {
    ...imported,
    label,
    ...(note !== undefined && { note }),
  });

export const thesisCollections: readonly ModelCollection[] = [
  {
    collection: 'theses',
    displayTemplate: thesisTemplate,
    fields: [
      enumField('level', levelChoices, {
        ...imported,
        label: 'Level',
        nullable: false,
      }),
      required('title', 'text', { ...imported, label: 'Title' }),
      scalar('description', 'text', { ...imported, label: 'Abstract' }),
      scalar('student_index', 'string', {
        ...imported,
        label: 'Index number',
      }),
      scalar('student_name', 'string', { ...imported, label: 'Student' }),
      scalar('status', 'string', {
        ...imported,
        label: 'Status',
        note: 'The step the thesis is at, as the faculty system names it.',
      }),
      scalar('date', 'string', {
        ...imported,
        label: 'Date',
        note: 'YYYY-MM-DD: the submission of a bachelor thesis, the defence of a master thesis (empty until it is set).',
      }),
      scalar('file_id', 'string', {
        ...imported,
        label: 'Document id',
        note: 'The id theses-listing downloads the document by.',
      }),
      committeeName('mentor', 'Mentor'),
      committeeName('president', 'Committee president', 'Master theses only.'),
      committeeName('member_1', 'Committee member'),
      committeeName(
        'member_2',
        'Second committee member',
        'Bachelor theses only.',
      ),
      scalar('imported_at', 'timestamp', {
        ...imported,
        label: 'Imported',
        note: 'Every import replaces every thesis; the host alerts when it gets old.',
      }),
    ],
    hidden: false,
    icon: 'history_edu',
    label: { plural: 'Theses', singular: 'Thesis' },
    singleton: false,
    sort: 38,
  },
  {
    collection: 'thesis_committee',
    displayTemplate: '{{thesis.title}}: {{staff.name}} ({{role}})',
    fields: [
      m2o('thesis', 'theses', {
        ...imported,
        alias: {
          field: 'committee',
          fields: ['staff', 'role'],
          label: 'Staff',
          readOnly: true,
          template: '{{staff.name}} ({{role}})',
        },
        label: 'Thesis',
        nullable: false,
        template: thesisTemplate,
      }),
      m2o('staff', 'staff', {
        ...imported,
        alias: {
          field: 'theses',
          fields: ['thesis', 'role'],
          label: 'Theses',
          readOnly: true,
          template: '{{thesis.title}} ({{role}})',
        },
        label: 'Staff member',
        nullable: false,
        template: staffTemplate,
      }),
      enumField('role', roleChoices, {
        ...imported,
        label: 'Role',
        nullable: false,
      }),
    ],
    hidden: false,
    icon: 'groups',
    label: { plural: 'Thesis committees', singular: 'Thesis committee' },
    singleton: false,
    sort: 39,
  },
];

// The keys of the thesis data, applied by the schema-constraints
// migration.
export const thesisKeys: readonly CompositeKey[] = [
  {
    collection: 'thesis_committee',
    columns: ['thesis', 'staff', 'role'],
    kind: 'unique',
    name: 'thesis_committee_thesis_staff_role_unique',
  },
  {
    collection: 'thesis_committee',
    columns: ['staff'],
    kind: 'index',
    name: 'thesis_committee_staff_index',
  },
];
