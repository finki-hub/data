import type { CompositeKey } from '../schema-relations.js';
import type { ModelCollection, ModelField } from '../schema.js';

import {
  bachelorRoles,
  masterRoles,
} from '../../directus/extensions/directus-extension-data-operations/src/theses/vocabulary.js';
import { staffTemplate } from './content-collections.js';
import { enumField, m2o, scalar } from './fields.js';

// FCSE's bachelor's and master's theses, each kind in its own tables so
// either can grow fields of its own: Data / Import theses reads them from
// the theses APIs of theses-listing (bachelors-api and
// masters-api.finki-hub.com) and derives the staff tables from their
// mentor and committee names, matched to staff as the timetables' teachers
// are (by name and through staff_aliases).

export const thesisTemplate = '{{title}}';

const roleLabels = {
  member: 'Member',
  mentor: 'Mentor',
  president: 'President',
} as const;

// What a derived field says about where it comes from.
const imported = { readOnly: true } as const;

const text = (field: string, label: string, note?: string): ModelField =>
  scalar(field, 'string', {
    ...imported,
    label,
    ...(note !== undefined && { note }),
  });

// The fields both kinds share, before their own.
const sharedFields = (): ModelField[] => [
  scalar('title', 'text', { ...imported, label: 'Title' }),
  scalar('description', 'text', { ...imported, label: 'Abstract' }),
  text('student_index', 'Index number'),
  text('student_name', 'Student'),
  text(
    'status',
    'Status',
    'The step the thesis is at, as the faculty system names it.',
  ),
];

const documentField = () =>
  text(
    'file_id',
    'Document id',
    'The id theses-listing downloads the document by.',
  );

const importedAt = () =>
  scalar('imported_at', 'timestamp', {
    ...imported,
    label: 'Imported',
    note: 'Every import replaces every thesis; the host alerts when it gets old.',
  });

type StaffTable = {
  readonly collection: 'bachelor_thesis_staff' | 'master_thesis_staff';
  readonly label: string;
  readonly roles: ReadonlyArray<'member' | 'mentor' | 'president'>;
  readonly sort: number;
  readonly staffAlias: string;
  readonly staffAliasLabel: string;
  readonly thesis: 'bachelor_theses' | 'master_theses';
};

// The staff members' roles on the theses of one kind.
const staffTable = (table: StaffTable): ModelCollection => ({
  collection: table.collection,
  displayTemplate: '{{thesis.title}}: {{staff.name}} ({{role}})',
  fields: [
    m2o('thesis', table.thesis, {
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
        field: table.staffAlias,
        fields: ['thesis', 'role'],
        label: table.staffAliasLabel,
        readOnly: true,
        template: '{{thesis.title}} ({{role}})',
      },
      label: 'Staff member',
      nullable: false,
      template: staffTemplate,
    }),
    enumField(
      'role',
      table.roles.map((role) => ({ label: roleLabels[role], value: role })),
      { ...imported, label: 'Role', nullable: false },
    ),
  ],
  hidden: false,
  icon: 'groups',
  label: { plural: table.label, singular: table.label },
  singleton: false,
  sort: table.sort,
});

export const thesisCollections: readonly ModelCollection[] = [
  {
    collection: 'bachelor_theses',
    displayTemplate: thesisTemplate,
    fields: [
      ...sharedFields(),
      text('submitted', 'Submitted', 'YYYY-MM-DD.'),
      documentField(),
      text('mentor', 'Mentor'),
      text('member_1', 'Committee member'),
      text('member_2', 'Second committee member'),
      importedAt(),
    ],
    hidden: false,
    icon: 'school',
    label: { plural: 'Bachelor theses', singular: 'Bachelor thesis' },
    singleton: false,
    sort: 38,
  },
  staffTable({
    collection: 'bachelor_thesis_staff',
    label: 'Bachelor thesis staff',
    roles: bachelorRoles,
    sort: 39,
    staffAlias: 'bachelor_theses',
    staffAliasLabel: 'Bachelor theses',
    thesis: 'bachelor_theses',
  }),
  {
    collection: 'master_theses',
    displayTemplate: thesisTemplate,
    fields: [
      ...sharedFields(),
      text('presented', 'Defended', 'YYYY-MM-DD; empty until it is set.'),
      documentField(),
      text('mentor', 'Mentor'),
      text('president', 'Committee president'),
      text('member', 'Committee member'),
      importedAt(),
    ],
    hidden: false,
    icon: 'history_edu',
    label: { plural: 'Master theses', singular: 'Master thesis' },
    singleton: false,
    sort: 40,
  },
  staffTable({
    collection: 'master_thesis_staff',
    label: 'Master thesis staff',
    roles: masterRoles,
    sort: 41,
    staffAlias: 'master_theses',
    staffAliasLabel: 'Master theses',
    thesis: 'master_theses',
  }),
];

// The keys of the thesis data, applied by the schema-constraints
// migration.
export const thesisKeys: readonly CompositeKey[] = (
  ['bachelor_thesis_staff', 'master_thesis_staff'] as const
).flatMap((collection): CompositeKey[] => [
  {
    collection,
    columns: ['thesis', 'staff', 'role'],
    kind: 'unique',
    name: `${collection}_thesis_staff_role_unique`,
  },
  {
    collection,
    columns: ['staff'],
    kind: 'index',
    name: `${collection}_staff_index`,
  },
]);
