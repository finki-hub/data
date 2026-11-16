import type { EnumChoice, ModelCollection } from '../schema.js';

import {
  assignmentRoles,
  courseStatuses,
  teachingTexts,
} from '../../directus/extensions/directus-extension-data-operations/src/exports/teaching-values.js';
import { roomLocations, roomTypes, staffPositions } from './choice-lists.js';
import { enumField, labelledChoices, m2o, required, scalar } from './fields.js';

// The content the one-time workbook import fills and Studio edits
// maintain: the published courses, staff, rooms and students, and the
// equivalencies and assignments beside them. The Discord channels, council
// and dean's office are declared with the reference lists
// (reference-collections.ts), the Moodle users with the Moodle
// collections.

const roleChoices = labelledChoices(assignmentRoles, {
  assistant: 'Assistant',
  professor: 'Professor',
});

const statusLabels = {
  active: 'Active',
  all_professors: 'All professors',
  inactive: 'Inactive',
} as const;

const statusChoices = labelledChoices(courseStatuses, statusLabels);

// The study cycle of FINKI's subject page (field 5), so second-cycle
// courses can join later.
export const degreeCycles = ['first', 'second', 'third'] as const;

const degreeCycleChoices = labelledChoices(degreeCycles, {
  first: 'First cycle',
  second: 'Second cycle',
  third: 'Third cycle',
});

// What the two statuses that replace names publish.
const statusNote = `${statusLabels.all_professors} publishes "${teachingTexts.allProfessors}" as professors. ${statusLabels.inactive} publishes "${teachingTexts.inactive}" as professors and assistants.`;

export const courseTemplate = '{{name}}';
export const staffTemplate = '{{name}}';
export const studentTemplate = '{{index_number}} - {{name}}';
export const channelTemplate = '{{channel}} (semester {{semester}})';
export const curriculumEntryTemplate =
  '{{code}} - {{name}} ({{generation.code}})';
// The labels of an equivalency's members, one per generation; an
// equivalency without a course reads by them too.
export const equivalencyTemplate = '{{members.label}}';

// A required dropdown of today's values that also takes a new one.
const requiredChoice = (
  field: string,
  choices: readonly EnumChoice[],
  label: string,
) => enumField(field, choices, { allowOther: true, label, nullable: false });

export const contentCollections: readonly ModelCollection[] = [
  {
    collection: 'courses',
    displayTemplate: courseTemplate,
    fields: [
      required('name', 'string', { label: 'Name' }),
      scalar('name_en', 'string', { label: 'English name' }),
      scalar('abbreviation', 'string', { label: 'Abbreviation' }),
      enumField('status', statusChoices, {
        defaultValue: 'active',
        label: 'Status',
        note: statusNote,
        nullable: false,
      }),
      scalar('tags', 'string', { label: 'Tags' }),
      // From FINKI's subject page of the course's 2023 curriculum entry
      // (2018 when it has none), Macedonian and English.
      enumField('degree_cycle', degreeCycleChoices, { label: 'Degree cycle' }),
      scalar('objectives', 'text', { label: 'Objectives' }),
      scalar('objectives_en', 'text', { label: 'English objectives' }),
      scalar('content', 'text', { label: 'Content' }),
      scalar('content_en', 'text', { label: 'English content' }),
    ],
    hidden: false,
    icon: 'school',
    label: { plural: 'Courses', singular: 'Course' },
    singleton: false,
    sort: 1,
  },
  {
    collection: 'staff',
    displayTemplate: staffTemplate,
    fields: [
      required('name', 'string', { label: 'Name' }),
      required('active', 'boolean', { label: 'Active' }),
      required('finki', 'boolean', {
        defaultValue: true,
        label: 'FINKI staff',
        note: 'Off for other faculties, visiting professors and external collaborators: they stay active unless there is a reason not to.',
      }),
      required('title', 'string', { label: 'Title' }),
      requiredChoice('position', staffPositions, 'Position'),
      required('email', 'string', { label: 'Email' }),
      scalar('cabinet', 'string', { label: 'Office' }),
      scalar('profile', 'text', { label: 'Profile page' }),
      // The staff member's Moodle profile link, published as courses.
      scalar('courses', 'string', { label: 'Moodle profile' }),
      scalar('consultations', 'text', { label: 'Consultations page' }),
    ],
    hidden: false,
    icon: 'group',
    label: { plural: 'Staff', singular: 'Staff member' },
    singleton: false,
    sort: 2,
  },
  {
    collection: 'rooms',
    displayTemplate: '{{name}} ({{location}})',
    fields: [
      required('name', 'string', { label: 'Name' }),
      requiredChoice('type', roomTypes, 'Type'),
      requiredChoice('location', roomLocations, 'Location'),
      scalar('description', 'text', { label: 'Description' }),
      scalar('floor', 'integer', { label: 'Floor' }),
      scalar('capacity', 'integer', { label: 'Capacity' }),
      scalar('mrbs', 'string', { label: 'Booking page' }),
    ],
    hidden: false,
    icon: 'meeting_room',
    label: { plural: 'Rooms', singular: 'Room' },
    singleton: false,
    sort: 3,
  },
  {
    collection: 'students',
    displayTemplate: studentTemplate,
    fields: [
      required('index_number', 'string', { label: 'Index number' }),
      required('name', 'string', { label: 'Name' }),
      required('source_group', 'string', { label: 'Group' }),
    ],
    hidden: false,
    icon: 'badge',
    label: { plural: 'Students', singular: 'Student' },
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
          label: 'Equivalencies',
          template: equivalencyTemplate,
        },
        label: 'Course',
        template: courseTemplate,
      }),
    ],
    hidden: false,
    icon: 'compare_arrows',
    label: { plural: 'Equivalencies', singular: 'Equivalency' },
    singleton: false,
    sort: 7,
  },
  {
    collection: 'teaching_assignments',
    displayTemplate: '{{course.name}}: {{staff.name}} ({{role}})',
    fields: [
      // One link per person, role and course
      // (teaching_assignments_course_staff_role_unique); deleting the
      // course or the staff member deletes the link.
      m2o('course', 'courses', {
        alias: {
          field: 'assignments',
          fields: ['role', 'staff'],
          label: 'Teaching staff',
          template: '{{role}}: {{staff.name}}',
        },
        label: 'Course',
        nullable: false,
        sortField: 'sort',
        template: courseTemplate,
      }),
      m2o('staff', 'staff', {
        alias: {
          field: 'assignments',
          fields: ['course', 'role'],
          label: 'Teaches',
          template: '{{course.name}} ({{role}})',
        },
        label: 'Staff member',
        nullable: false,
        template: staffTemplate,
      }),
      enumField('role', roleChoices, { label: 'Role', nullable: false }),
      // The drag order of the course's lists, which orders the published
      // names.
      scalar('sort', 'integer', { label: 'Order' }),
    ],
    hidden: false,
    icon: 'co_present',
    label: { plural: 'Teaching staff', singular: 'Teaching assignment' },
    singleton: false,
    sort: 8,
  },
];

// What the bots publish beside the course data: the exam session
// schedules and the Anto quotes, each a plain list edited in Studio.
export const botContentCollections: readonly ModelCollection[] = [
  {
    collection: 'exam_sessions',
    displayTemplate: '{{name}}',
    fields: [
      // Published as the key of sessions.json, for example
      // "2025/2026 Јуни"; the file is published by its file name.
      required('name', 'string', { label: 'Name', unique: true }),
      m2o('file', 'directus_files', {
        label: 'Schedule file',
        note: 'The PDF or Excel schedule, published under its file name.',
        nullable: false,
      }),
    ],
    hidden: false,
    icon: 'event_note',
    label: { plural: 'Exam sessions', singular: 'Exam session' },
    singleton: false,
    sort: 5,
  },
  {
    collection: 'anto_quotes',
    displayTemplate: '{{quote}}',
    fields: [required('quote', 'text', { label: 'Quote' })],
    hidden: false,
    icon: 'format_quote',
    label: { plural: 'Anto quotes', singular: 'Anto quote' },
    singleton: false,
    sort: 9,
  },
];
