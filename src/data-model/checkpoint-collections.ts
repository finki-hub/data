import type { CollectionSpec, ModelCollection, ModelField } from '../schema.js';

import { collectionSpecs } from '../model.js';
import { enumField, fromCheckpointField, m2o, scalar } from './fields.js';

export const assignmentRoles = ['professor', 'assistant'] as const;

export const courseTemplate = '{{name}}';
export const staffTemplate = '{{name}}';
export const studentTemplate = '{{index_number}} - {{name}}';
export const curriculumEntryTemplate = '{{code}} - {{name}} ({{generation}})';

const provenanceFields = (): readonly ModelField[] => [
  scalar('source_collection', 'string', {
    note: 'Checkpoint collection this row was migrated from, if any.',
    readOnly: true,
  }),
  scalar('source_id', 'integer', {
    note: 'Row id inside the checkpoint source collection, if any.',
    readOnly: true,
  }),
];

const additions: Readonly<Partial<Record<string, readonly ModelField[]>>> = {
  course_equivalencies: [
    m2o('entry_2023', 'curriculum_entries', {
      alias: {
        field: 'equivalencies_2023',
        fields: ['course_2023', 'course_2018', 'course_2013'],
        template: '{{course_2023}} / {{course_2018}} / {{course_2013}}',
      },
      note: 'Resolved 2023 curriculum entry, when the label is unambiguous.',
      template: curriculumEntryTemplate,
    }),
    m2o('entry_2018', 'curriculum_entries', {
      alias: {
        field: 'equivalencies_2018',
        fields: ['course_2023', 'course_2018', 'course_2013'],
        template: '{{course_2023}} / {{course_2018}} / {{course_2013}}',
      },
      note: 'Resolved 2018 curriculum entry, when the label is unambiguous.',
      template: curriculumEntryTemplate,
    }),
    m2o('course', 'courses', {
      alias: {
        field: 'equivalencies',
        fields: ['course_2023', 'course_2018', 'course_2013'],
        template: '{{course_2023}} / {{course_2018}} / {{course_2013}}',
      },
      note: 'Resolved course, when the labels point at exactly one course.',
      template: courseTemplate,
    }),
  ],
  student_council: [
    m2o('student', 'students', {
      alias: {
        field: 'council_memberships',
        fields: ['year', 'position'],
        template: '{{year}} - {{position}}',
      },
      note: 'Resolved student record; empty links need review.',
      template: studentTemplate,
    }),
  ],
  teaching_assignments: [
    m2o('course', 'courses', {
      alias: {
        field: 'assignments',
        fields: ['role', 'staff', 'display_override', 'sort'],
        template: '{{role}}: {{staff.name}}',
      },
      note: 'Resolved course; empty on unconverted checkpoint rows.',
      sortField: 'sort',
      template: courseTemplate,
    }),
    m2o('staff', 'staff', {
      alias: {
        field: 'assignments',
        fields: ['course', 'role'],
        template: '{{course.name}} ({{role}})',
      },
      note: 'Resolved staff member; unresolved labels stay in display_override.',
      template: staffTemplate,
    }),
    enumField('role', assignmentRoles, {
      note: 'professor or assistant; empty on unconverted checkpoint rows.',
    }),
    scalar('sort', 'integer'),
    scalar('display_override', 'string', {
      note: 'Literal label shown instead of the staff name, or the unresolved imported label.',
    }),
    ...provenanceFields(),
  ],
};

const fromSpec = (spec: CollectionSpec): ModelCollection => ({
  collection: spec.key,
  displayTemplate: spec.displayTemplate,
  fields: [
    ...spec.fields.map(fromCheckpointField),
    ...(additions[spec.key] ?? []),
  ],
  hidden: false,
  icon: spec.icon,
  note: spec.note,
  origin: 'checkpoint',
  singleton: false,
  sort: spec.sort,
});

// The thirteen checkpoint collections exactly as the legacy importer creates
// them, extended with the nullable relation columns of the relational model.
// A populated deployment adopts them in place; a fresh project gets them
// created schema-only.
export const checkpointCollections: readonly ModelCollection[] =
  collectionSpecs.map(fromSpec);

export { provenanceFields };
