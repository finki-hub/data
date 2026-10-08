import type { ModelCollection, ModelScalarKind } from '../schema.js';

import { enumField, labelledChoices, m2o, scalar } from './fields.js';

// The content the one-time workbook import fills and Studio edits
// maintain: the published courses, staff, rooms and students, and the
// equivalencies, assignments, council and dean's office rows beside them.
// The Moodle users are declared with the Moodle collections.

export const assignmentRoles = ['professor', 'assistant'] as const;

const roleChoices = labelledChoices(assignmentRoles, {
  assistant: 'Assistant',
  professor: 'Professor',
});

export const courseTemplate = '{{name}}';
const staffTemplate = '{{name}}';
const studentTemplate = '{{index_number}} - {{name}}';
export const curriculumEntryTemplate =
  '{{code}} - {{name}} ({{generation.code}})';
export const equivalencyTemplate = '{{course.name}}';

const required = (field: string, kind: ModelScalarKind = 'string') =>
  scalar(field, kind, { nullable: false });

export const contentCollections: readonly ModelCollection[] = [
  {
    collection: 'courses',
    displayTemplate: courseTemplate,
    fields: [
      required('name'),
      scalar('professors_override', 'text'),
      scalar('tags', 'string'),
    ],
    hidden: false,
    icon: 'school',
    note: 'Canonical course data published to courses.json in R2.',
    singleton: false,
    sort: 1,
  },
  {
    collection: 'staff',
    displayTemplate: staffTemplate,
    fields: [
      required('name'),
      required('active', 'boolean'),
      required('title'),
      required('position'),
      required('email'),
      scalar('cabinet', 'string'),
      scalar('profile', 'text'),
      scalar('courses', 'string'),
      scalar('consultations', 'text'),
    ],
    hidden: false,
    icon: 'group',
    note: 'Canonical staff data published to staff.json in R2.',
    singleton: false,
    sort: 2,
  },
  {
    collection: 'rooms',
    displayTemplate: '{{location}} / {{name}}',
    fields: [
      required('name'),
      required('type'),
      required('location'),
      scalar('description', 'text'),
      scalar('floor', 'integer'),
      scalar('capacity', 'integer'),
      scalar('mrbs', 'string'),
    ],
    hidden: false,
    icon: 'meeting_room',
    note: 'Canonical room data published to rooms.json in R2.',
    singleton: false,
    sort: 3,
  },
  {
    collection: 'students',
    displayTemplate: studentTemplate,
    fields: [
      required('index_number'),
      required('name'),
      required('source_group'),
    ],
    hidden: false,
    icon: 'badge',
    note: 'Private student directory; only its R2 export is published.',
    singleton: false,
    sort: 4,
  },
  {
    collection: 'course_equivalencies',
    displayTemplate: equivalencyTemplate,
    fields: [
      // The equivalency is the group of its members (course_equivalency_
      // members), one literal label per generation; the course form lists
      // each equivalency's member generations and labels.
      m2o('course', 'courses', {
        alias: {
          field: 'equivalencies',
          fields: ['members.generation.code', 'members.label'],
          template: '{{id}}',
        },
        note: 'The course the equivalency belongs to, when its 2023 label names exactly one course.',
        template: courseTemplate,
      }),
    ],
    hidden: false,
    icon: 'compare_arrows',
    note: 'Course-name equivalencies across curriculum generations.',
    singleton: false,
    sort: 7,
  },
  {
    collection: 'teaching_assignments',
    displayTemplate: '{{course.name}} ({{role}})',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'assignments',
          fields: ['role', 'staff', 'display_override', 'sort'],
          template: '{{role}}: {{staff.name}}',
        },
        note: 'The course the staff member teaches.',
        sortField: 'sort',
        template: courseTemplate,
      }),
      m2o('staff', 'staff', {
        alias: {
          field: 'assignments',
          fields: ['course', 'role'],
          template: '{{course.name}} ({{role}})',
        },
        note: 'The staff member; a label no staff row carries stays in display_override.',
        template: staffTemplate,
      }),
      enumField('role', roleChoices),
      scalar('sort', 'integer'),
      // `text`, not `string`: an unresolved imported label is the whole
      // professors or assistants cell of the workbook, an unbounded text.
      scalar('display_override', 'text', {
        note: 'Literal label shown instead of the staff name, or the imported label no staff row carries.',
      }),
    ],
    hidden: false,
    icon: 'co_present',
    note: 'Professor and assistant assignments by course.',
    singleton: false,
    sort: 8,
  },
  {
    collection: 'discord_channels',
    displayTemplate: '{{semester}} - {{channel}}',
    fields: [
      required('semester', 'integer'),
      required('channel'),
      required('course_names', 'text'),
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
