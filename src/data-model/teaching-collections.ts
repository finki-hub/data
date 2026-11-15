import type { CompositeKey } from '../schema-relations.js';
import type { ModelCollection } from '../schema.js';

import { assignmentRoles } from '../../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import {
  matchStates,
  timetableTerms,
} from '../../directus/extensions/directus-extension-data-operations/src/teaching/vocabulary.js';
import { courseTemplate, staffTemplate } from './content-collections.js';
import { academicYearTemplate } from './curriculum-collections.js';
import { enumField, labelledChoices, m2o, required, scalar } from './fields.js';
import { generationReference } from './generation-collections.js';

// Who teaches each course, from FCSE's timetables: Data / Import
// timetables reads timetables-api.finki-hub.com into timetables and their
// lessons and derives course_teaching from them, matching the timetables'
// names to courses and staff by name and through the two alias lists.
// The accreditation teachers are the syllabus's "Наставник" list.

export const timetableTemplate = '{{title}}';

const termChoices = labelledChoices(timetableTerms, {
  summer: 'Summer',
  winter: 'Winter',
});

const matchChoices = labelledChoices(matchStates, {
  ignored: 'Ignored',
  matched: 'Matched',
  unmatched: 'Unmatched',
});

const roleChoices = labelledChoices(assignmentRoles, {
  assistant: 'Assistant',
  professor: 'Professor',
});

// What a derived field says about where it comes from.
const imported = { readOnly: true } as const;

export const teachingCollections: readonly ModelCollection[] = [
  {
    collection: 'timetables',
    displayTemplate: timetableTemplate,
    fields: [
      required('edupage_id', 'string', {
        ...imported,
        label: 'EduPage id',
        unique: true,
      }),
      required('title', 'string', { ...imported, label: 'Title' }),
      required('date_from', 'string', {
        ...imported,
        label: 'Starts',
      }),
      m2o('academic_year', 'academic_years', {
        ...imported,
        label: 'Academic year',
        template: academicYearTemplate,
      }),
      enumField('term', termChoices, {
        ...imported,
        label: 'Semester',
        nullable: false,
      }),
      required('main', 'boolean', {
        ...imported,
        defaultValue: false,
        label: 'Main timetable',
        note: 'The last timetable of its semester; only main timetables count.',
      }),
      required('hidden', 'boolean', {
        ...imported,
        defaultValue: false,
        label: 'Hidden on EduPage',
      }),
      scalar('fingerprint', 'string', { ...imported, label: 'Fingerprint' }),
      scalar('imported_at', 'timestamp', { ...imported, label: 'Imported' }),
    ],
    hidden: false,
    icon: 'calendar_view_week',
    label: { plural: 'Timetables', singular: 'Timetable' },
    singleton: false,
    sort: 32,
  },
  {
    collection: 'timetable_lessons',
    displayTemplate: '{{subject}} ({{kind}}): {{teacher}}',
    fields: [
      m2o('timetable', 'timetables', {
        ...imported,
        alias: {
          field: 'lessons',
          fields: ['subject', 'kind', 'teacher', 'periods'],
          label: 'Lessons',
          readOnly: true,
          template: '{{subject}} ({{kind}}): {{teacher}}',
        },
        label: 'Timetable',
        nullable: false,
        template: timetableTemplate,
      }),
      required('subject', 'string', {
        ...imported,
        label: 'Subject',
        note: 'As the timetable names it, without the class type.',
      }),
      scalar('kind', 'string', {
        ...imported,
        label: 'Class type',
        note: 'п lecture, ав exercises; empty before summer 2022/23.',
      }),
      required('teacher', 'string', { ...imported, label: 'Teacher' }),
      required('periods', 'integer', {
        ...imported,
        label: 'Weekly periods',
        minimum: 0,
      }),
      enumField('course_match', matchChoices, {
        ...imported,
        label: 'Course match',
        nullable: false,
      }),
      enumField('teacher_match', matchChoices, {
        ...imported,
        label: 'Teacher match',
        nullable: false,
      }),
    ],
    hidden: false,
    icon: 'view_timeline',
    label: { plural: 'Timetable lessons', singular: 'Timetable lesson' },
    singleton: false,
    sort: 33,
  },
  {
    collection: 'course_teaching',
    displayTemplate: '{{course.name}}: {{staff.name}} ({{role}})',
    fields: [
      m2o('course', 'courses', {
        ...imported,
        alias: {
          field: 'teaching',
          fields: ['timetable', 'staff', 'role', 'periods'],
          label: 'Taught by (timetables)',
          readOnly: true,
          template: '{{timetable.title}}: {{staff.name}} ({{role}})',
        },
        label: 'Course',
        nullable: false,
        template: courseTemplate,
      }),
      m2o('staff', 'staff', {
        ...imported,
        alias: {
          field: 'teaching',
          fields: ['timetable', 'course', 'role', 'periods'],
          label: 'Teaches (timetables)',
          readOnly: true,
          template: '{{timetable.title}}: {{course.name}} ({{role}})',
        },
        label: 'Staff member',
        nullable: false,
        template: staffTemplate,
      }),
      m2o('timetable', 'timetables', {
        ...imported,
        alias: {
          field: 'teaching',
          fields: ['course', 'staff', 'role', 'periods'],
          label: 'Teaching',
          readOnly: true,
          template: '{{course.name}}: {{staff.name}} ({{role}})',
        },
        label: 'Timetable',
        nullable: false,
        template: timetableTemplate,
      }),
      enumField('role', roleChoices, {
        ...imported,
        label: 'Role',
        nullable: false,
      }),
      required('periods', 'integer', {
        ...imported,
        label: 'Weekly periods',
        minimum: 0,
      }),
    ],
    hidden: false,
    icon: 'co_present',
    label: { plural: 'Course teaching', singular: 'Course teaching' },
    singleton: false,
    sort: 34,
  },
  {
    collection: 'course_aliases',
    displayTemplate: '{{name}} - {{course.name}}',
    fields: [
      required('name', 'string', {
        label: 'Timetable name',
        note: 'As the timetables name the subject, without the class type. A combined slot takes one row per course.',
      }),
      m2o('course', 'courses', {
        label: 'Course',
        note: 'Empty: the name is ignored.',
        template: courseTemplate,
      }),
    ],
    hidden: false,
    icon: 'label',
    label: {
      plural: 'Timetable course names',
      singular: 'Timetable course name',
    },
    singleton: false,
    sort: 35,
  },
  {
    collection: 'staff_aliases',
    displayTemplate: '{{name}} - {{staff.name}}',
    fields: [
      required('name', 'string', {
        label: 'Timetable name',
        unique: true,
      }),
      m2o('staff', 'staff', {
        label: 'Staff member',
        note: 'Empty: the name is ignored, such as a demonstrator slot.',
        template: staffTemplate,
      }),
    ],
    hidden: false,
    icon: 'badge',
    label: {
      plural: 'Timetable staff names',
      singular: 'Timetable staff name',
    },
    singleton: false,
    sort: 36,
  },
  {
    collection: 'course_accreditation_staff',
    displayTemplate: '{{course.name}}: {{staff.name}} ({{generation.code}})',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'accreditation_staff',
          fields: ['generation', 'staff'],
          label: 'Accreditation teachers',
          template: '{{generation.code}}: {{staff.name}}',
        },
        label: 'Course',
        nullable: false,
        sortField: 'sort',
        template: courseTemplate,
      }),
      m2o('staff', 'staff', {
        alias: {
          field: 'accreditation_courses',
          fields: ['generation', 'course'],
          label: 'Accreditation courses',
          template: '{{generation.code}}: {{course.name}}',
        },
        label: 'Staff member',
        nullable: false,
        template: staffTemplate,
      }),
      generationReference(),
      scalar('sort', 'integer', { label: 'Order' }),
    ],
    hidden: false,
    icon: 'workspace_premium',
    label: {
      plural: 'Accreditation teachers',
      singular: 'Accreditation teacher',
    },
    singleton: false,
    sort: 37,
  },
];

// The keys of the teaching data, applied by the schema-constraints
// migration.
export const teachingKeys: readonly CompositeKey[] = [
  // One lesson per subject, class type and teacher of a timetable; a
  // subject of an older timetable has no class type.
  {
    collection: 'timetable_lessons',
    columns: ['timetable', 'subject', 'kind', 'teacher'],
    kind: 'unique',
    name: 'timetable_lessons_timetable_subject_kind_teacher_unique',
    nullsNotDistinct: true,
  },
  {
    collection: 'course_teaching',
    columns: ['course', 'staff', 'timetable', 'role'],
    kind: 'unique',
    name: 'course_teaching_course_staff_timetable_role_unique',
  },
  {
    collection: 'course_teaching',
    columns: ['timetable'],
    kind: 'index',
    name: 'course_teaching_timetable_index',
  },
  // A name maps to a course once; a row without a course ignores it.
  {
    collection: 'course_aliases',
    columns: ['name', 'course'],
    kind: 'unique',
    name: 'course_aliases_name_course_unique',
    nullsNotDistinct: true,
  },
  {
    collection: 'course_accreditation_staff',
    columns: ['course', 'staff', 'generation'],
    kind: 'unique',
    name: 'course_accreditation_staff_course_staff_generation_unique',
  },
];
