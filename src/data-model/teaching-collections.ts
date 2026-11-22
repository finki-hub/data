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

const staffMemberLabel = 'Staff member';

type ImportedLink = {
  readonly alias: string;
  readonly fields: readonly string[];
  readonly label: string;
  readonly listLabel: string;
  readonly listTemplate: string;
  readonly template: string;
};

// A required link of a derived row, listed read-only on the row it points
// at.
const importedLink = (
  field: string,
  related: 'courses' | 'staff' | 'timetable_slots' | 'timetables',
  link: ImportedLink,
) =>
  m2o(field, related, {
    ...imported,
    alias: {
      field: link.alias,
      fields: link.fields,
      label: link.listLabel,
      readOnly: true,
      template: link.listTemplate,
    },
    label: link.label,
    nullable: false,
    template: link.template,
  });

// The weekly periods of a lesson or a teaching row.
const weeklyPeriods = () =>
  required('periods', 'integer', {
    ...imported,
    label: 'Weekly periods',
    minimum: 0,
  });

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
      required('recent', 'boolean', {
        ...imported,
        defaultValue: false,
        label: 'Published',
        note: 'One of the six latest main timetables, the three years courses.json reads its teaching staff from.',
      }),
      required('hidden', 'boolean', {
        ...imported,
        defaultValue: false,
        label: 'Hidden on EduPage',
      }),
      scalar('fingerprint', 'string', { ...imported, label: 'Fingerprint' }),
      scalar('imported_at', 'timestamp', { ...imported, label: 'Imported' }),
      scalar('checked_at', 'timestamp', {
        ...imported,
        label: 'Last import',
        note: 'Every successful import sets it on each listed timetable; the host alerts when it gets old.',
      }),
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
      importedLink('timetable', 'timetables', {
        alias: 'lessons',
        fields: ['subject', 'kind', 'teacher', 'periods'],
        label: 'Timetable',
        listLabel: 'Lessons',
        listTemplate: '{{subject}} ({{kind}}): {{teacher}}',
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
      weeklyPeriods(),
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
      importedLink('course', 'courses', {
        alias: 'teaching',
        fields: ['timetable', 'staff', 'role', 'periods'],
        label: 'Course',
        listLabel: 'Taught by (timetables)',
        listTemplate: '{{timetable.title}}: {{staff.name}} ({{role}})',
        template: courseTemplate,
      }),
      importedLink('staff', 'staff', {
        alias: 'teaching',
        fields: ['timetable', 'course', 'role', 'periods'],
        label: staffMemberLabel,
        listLabel: 'Teaches (timetables)',
        listTemplate: '{{timetable.title}}: {{course.name}} ({{role}})',
        template: staffTemplate,
      }),
      importedLink('timetable', 'timetables', {
        alias: 'teaching',
        fields: ['course', 'staff', 'role', 'periods'],
        label: 'Timetable',
        listLabel: 'Teaching',
        listTemplate: '{{course.name}}: {{staff.name}} ({{role}})',
        template: timetableTemplate,
      }),
      enumField('role', roleChoices, {
        ...imported,
        label: 'Role',
        nullable: false,
      }),
      weeklyPeriods(),
    ],
    hidden: false,
    icon: 'co_present',
    label: { plural: 'Timetable teaching', singular: 'Timetable teaching' },
    singleton: false,
    sort: 34,
  },
  {
    collection: 'timetable_slots',
    displayTemplate: '{{subject}}: {{day}} {{starts}} ({{classroom}})',
    fields: [
      importedLink('timetable', 'timetables', {
        alias: 'slots',
        fields: ['day', 'starts', 'subject', 'classroom'],
        label: 'Timetable',
        listLabel: 'Slots',
        listTemplate: '{{day}} {{starts}}: {{subject}} ({{classroom}})',
        template: timetableTemplate,
      }),
      required('subject', 'string', {
        ...imported,
        label: 'Subject',
        note: 'As the timetable names it, without the class type.',
      }),
      scalar('kind', 'string', { ...imported, label: 'Class type' }),
      m2o('course', 'courses', {
        ...imported,
        alias: {
          field: 'slots',
          fields: ['timetable', 'day', 'starts', 'room'],
          label: 'Timetable slots',
          readOnly: true,
          template: '{{timetable.title}}: {{day}} {{starts}} {{room.name}}',
        },
        label: 'Course',
        note: 'Empty when the subject stands for no course or for several.',
        template: courseTemplate,
      }),
      scalar('day', 'integer', {
        ...imported,
        label: 'Day',
        note: '1 Monday to 5 Friday.',
      }),
      scalar('starts', 'string', { ...imported, label: 'Starts' }),
      scalar('ends', 'string', { ...imported, label: 'Ends' }),
      weeklyPeriods(),
      scalar('teachers', 'text', {
        ...imported,
        label: 'Teachers',
        note: 'As the timetable names them.',
      }),
      scalar('groups', 'text', {
        ...imported,
        label: 'Classes',
        note: 'The timetable classes that attend, such as 4г-СИИС.',
      }),
      scalar('classroom', 'string', {
        ...imported,
        label: 'Classroom',
        note: 'As the timetable names the room.',
      }),
      m2o('room', 'rooms', {
        ...imported,
        alias: {
          field: 'slots',
          fields: ['timetable', 'day', 'starts', 'subject'],
          label: 'Timetable slots',
          readOnly: true,
          template: '{{timetable.title}}: {{day}} {{starts}} {{subject}}',
        },
        label: 'Room',
        template: '{{name}} ({{location}})',
      }),
      enumField('room_match', matchChoices, {
        ...imported,
        label: 'Room match',
        nullable: false,
      }),
    ],
    hidden: false,
    icon: 'event_seat',
    label: { plural: 'Timetable slots', singular: 'Timetable slot' },
    singleton: false,
    sort: 34,
  },
  // Who teaches each slot: every name of the slot's teachers that stands
  // for a staff member, matched like the lessons' teachers.
  {
    collection: 'timetable_slot_staff',
    displayTemplate: '{{staff.name}}: {{slot.subject}}',
    fields: [
      importedLink('slot', 'timetable_slots', {
        alias: 'staff',
        fields: ['staff', 'teacher'],
        label: 'Slot',
        listLabel: 'Staff',
        listTemplate: '{{staff.name}}',
        template: '{{subject}}: {{day}} {{starts}} ({{classroom}})',
      }),
      importedLink('staff', 'staff', {
        alias: 'slots',
        fields: ['slot'],
        label: staffMemberLabel,
        listLabel: 'Timetable slots',
        listTemplate:
          '{{slot.timetable.title}}: {{slot.day}} {{slot.starts}} {{slot.subject}}',
        template: staffTemplate,
      }),
      required('teacher', 'string', {
        ...imported,
        label: 'Teacher',
        note: 'As the timetable names them.',
      }),
    ],
    hidden: false,
    icon: 'person_pin_circle',
    label: { plural: 'Timetable slot staff', singular: 'Timetable slot staff' },
    singleton: false,
    sort: 34,
  },
  // Every course a slot is held for: one, or each part of a joint class
  // ("Избрани теми од математика / Дискретна математика"), matched like
  // the lessons' subjects. The slot's own course is set only when there
  // is exactly one.
  {
    collection: 'timetable_slot_courses',
    displayTemplate: '{{course.name}}: {{slot.subject}}',
    fields: [
      importedLink('slot', 'timetable_slots', {
        alias: 'courses',
        fields: ['course'],
        label: 'Slot',
        listLabel: 'Courses',
        listTemplate: '{{course.name}}',
        template: '{{subject}}: {{day}} {{starts}} ({{classroom}})',
      }),
      importedLink('course', 'courses', {
        alias: 'slot_links',
        fields: ['slot'],
        label: 'Course',
        listLabel: 'All timetable slots',
        listTemplate:
          '{{slot.timetable.title}}: {{slot.day}} {{slot.starts}} {{slot.subject}}',
        template: courseTemplate,
      }),
    ],
    hidden: false,
    icon: 'event_note',
    label: {
      plural: 'Timetable slot courses',
      singular: 'Timetable slot course',
    },
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
      plural: 'Course names',
      singular: 'Course name',
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
        label: staffMemberLabel,
        note: 'Empty: the name is ignored, such as a demonstrator slot.',
        template: staffTemplate,
      }),
    ],
    hidden: false,
    icon: 'badge',
    label: {
      plural: 'Staff names',
      singular: 'Staff name',
    },
    singleton: false,
    sort: 36,
  },
  {
    collection: 'staff_openalex_profiles',
    displayTemplate: '{{openalex_id}} - {{staff.name}}',
    fields: [
      required('openalex_id', 'string', {
        label: 'OpenAlex author',
        note: 'The author id, such as A5026548328. A staff member can have several.',
        unique: true,
      }),
      m2o('staff', 'staff', {
        label: staffMemberLabel,
        nullable: false,
        template: staffTemplate,
      }),
      scalar('written_name', 'string', {
        label: 'Written name',
        note: 'Empty: every FINKI paper of the profile counts. Set for a profile that mixes people: only papers written this way count.',
      }),
    ],
    hidden: false,
    icon: 'school',
    label: {
      plural: 'Staff OpenAlex profiles',
      singular: 'Staff OpenAlex profile',
    },
    singleton: false,
    sort: 36,
  },
  {
    collection: 'room_aliases',
    displayTemplate: '{{name}} - {{room.name}}',
    fields: [
      required('name', 'string', {
        label: 'Timetable name',
        unique: true,
      }),
      m2o('room', 'rooms', {
        label: 'Room',
        note: 'Empty: the name is ignored, such as online.',
        template: '{{name}} ({{location}})',
      }),
    ],
    hidden: false,
    icon: 'meeting_room',
    label: {
      plural: 'Room names',
      singular: 'Room name',
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
        label: staffMemberLabel,
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
  ...(['timetable', 'course', 'room'] as const).map((column): CompositeKey => ({
    collection: 'timetable_slots',
    columns: [column],
    kind: 'index',
    name: `timetable_slots_${column}_index`,
  })),
  {
    collection: 'timetable_slot_staff',
    columns: ['slot', 'staff'],
    kind: 'unique',
    name: 'timetable_slot_staff_slot_staff_unique',
  },
  {
    collection: 'timetable_slot_staff',
    columns: ['staff'],
    kind: 'index',
    name: 'timetable_slot_staff_staff_index',
  },
  {
    collection: 'timetable_slot_courses',
    columns: ['slot', 'course'],
    kind: 'unique',
    name: 'timetable_slot_courses_slot_course_unique',
  },
  {
    collection: 'timetable_slot_courses',
    columns: ['course'],
    kind: 'index',
    name: 'timetable_slot_courses_course_index',
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
