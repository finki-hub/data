import type { CompositeKey } from '../schema-relations.js';
import type { ModelCollection, ModelField } from '../schema.js';

import {
  bodyNames,
  facultyBodies,
  issueKinds,
} from '../../directus/extensions/directus-extension-data-operations/src/faculty/vocabulary.js';
import { staffTemplate } from './content-collections.js';
import { enumField, labelledChoices, m2o, scalar } from './fields.js';

// FINKI's internal structure: the institutes with their heads and members,
// the centers with their heads, and the teaching and research council
// (a flag on staff, declared with staff in content-collections.ts). Data / Import faculty structure reads them from the
// public pages of finki.ukim.mk every day and matches the people to staff
// by their profile page, then email, then name. The photo and the biography
// of a staff member come from the same import.

export const instituteTemplate = '{{name}}';

// What a derived field says about where it comes from.
const imported = { readOnly: true } as const;

const text = (
  field: string,
  label: string,
  kind: 'string' | 'text' = 'string',
): ModelField => scalar(field, kind, { ...imported, label });

// Only the institutes carry the note: every table is replaced at once.
const importedAt = (noted = false) =>
  scalar('imported_at', 'timestamp', {
    ...imported,
    label: 'Imported',
    ...(noted && {
      note: 'Every import replaces the structure; the host alerts when it gets old.',
    }),
  });

export const facultyCollections: readonly ModelCollection[] = [
  {
    collection: 'faculty_body_members',
    displayTemplate: '{{body}}: {{staff.name}}',
    fields: [
      enumField(
        'body',
        labelledChoices(facultyBodies, {
          council: 'Наставно-научен совет',
          management_board: 'Деканатска управа',
        }),
        { ...imported, label: 'Body', nullable: false },
      ),
      scalar('position', 'string', { ...imported, label: 'Position' }),
      m2o('staff', 'staff', {
        ...imported,
        label: 'Staff member',
        nullable: false,
        template: staffTemplate,
      }),
      scalar('sort', 'integer', { ...imported, label: 'Page order' }),
    ],
    hidden: false,
    icon: 'diversity_3',
    label: { plural: 'Faculty bodies', singular: 'Faculty body member' },
    singleton: false,
    sort: 46,
  },
  {
    collection: 'institutes',
    displayTemplate: instituteTemplate,
    fields: [
      text('name', 'Name'),
      text('page', 'Page'),
      m2o('head', 'staff', {
        ...imported,
        alias: {
          field: 'headed_institutes',
          fields: ['name'],
          label: 'Heads institute',
          readOnly: true,
          template: instituteTemplate,
        },
        label: 'Head',
        note: "As the management board (Деканатска управа) page names the head of the institute; the institute's own page can disagree.",
        template: staffTemplate,
      }),
      importedAt(true),
    ],
    hidden: false,
    icon: 'hub',
    label: { plural: 'Institutes', singular: 'Institute' },
    singleton: false,
    sort: 42,
  },
  {
    collection: 'institute_members',
    displayTemplate: '{{institute.name}}: {{staff.name}}',
    fields: [
      m2o('institute', 'institutes', {
        ...imported,
        alias: {
          field: 'members',
          fields: ['staff'],
          label: 'Members',
          readOnly: true,
          template: '{{staff.name}}',
        },
        label: 'Institute',
        nullable: false,
        template: instituteTemplate,
      }),
      m2o('staff', 'staff', {
        ...imported,
        alias: {
          field: 'institutes',
          fields: ['institute'],
          label: 'Institutes',
          readOnly: true,
          template: '{{institute.name}}',
        },
        label: 'Staff member',
        nullable: false,
        template: staffTemplate,
      }),
    ],
    hidden: false,
    icon: 'groups',
    label: { plural: 'Institute members', singular: 'Institute member' },
    singleton: false,
    sort: 43,
  },
  {
    collection: 'faculty_centers',
    displayTemplate: '{{name}}',
    fields: [
      text('name', 'Name'),
      text('page', 'Page'),
      m2o('head', 'staff', {
        ...imported,
        alias: {
          field: 'headed_centers',
          fields: ['name'],
          label: 'Heads center',
          readOnly: true,
          template: '{{name}}',
        },
        label: 'Head',
        template: staffTemplate,
      }),
      importedAt(),
    ],
    hidden: false,
    icon: 'domain',
    label: { plural: 'Centers', singular: 'Center' },
    singleton: false,
    sort: 44,
  },
  {
    collection: 'faculty_import_issues',
    displayTemplate: '{{body}}: {{name}}',
    fields: [
      enumField(
        'kind',
        labelledChoices(issueKinds, {
          deans_office: "Dean's office",
          unmatched_person: 'Unmatched person',
        }),
        { ...imported, label: 'Kind', nullable: false },
      ),
      enumField(
        'body',
        Object.values(bodyNames).map((name) => ({ label: name, value: name })),
        { ...imported, label: 'Body', nullable: false },
      ),
      text('name', 'Name'),
      text('email', 'Email'),
      text('profile', 'Profile page'),
      text('detail', 'Detail', 'text'),
      importedAt(),
    ],
    hidden: true,
    icon: 'rule',
    label: {
      plural: 'Faculty import issues',
      singular: 'Faculty import issue',
    },
    singleton: false,
    sort: 45,
  },
];

// The keys of the faculty structure, applied by the schema-constraints
// migration.
export const facultyKeys: readonly CompositeKey[] = [
  {
    collection: 'institute_members',
    columns: ['institute', 'staff'],
    kind: 'unique',
    name: 'institute_members_institute_staff_unique',
  },
  {
    collection: 'institute_members',
    columns: ['staff'],
    kind: 'index',
    name: 'institute_members_staff_index',
  },
  {
    collection: 'faculty_body_members',
    columns: ['body', 'staff'],
    kind: 'unique',
    name: 'faculty_body_members_body_staff_unique',
  },
];
