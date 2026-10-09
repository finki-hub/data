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

// What the two statuses that replace names publish.
const statusNote = `${statusLabels.all_professors} publishes "${teachingTexts.allProfessors}" as professors. ${statusLabels.inactive} publishes "${teachingTexts.inactive}" as professors and assistants.`;

export const courseTemplate = '{{name}}';
export const staffTemplate = '{{name}}';
export const studentTemplate = '{{index_number}} - {{name}}';
const channelTemplate = '{{channel}} (semester {{semester}})';
export const curriculumEntryTemplate =
  '{{code}} - {{name}} ({{generation.code}})';
export const equivalencyTemplate = '{{course.name}}';

// A required dropdown of today's values that also takes a new one.
const requiredChoice = (field: string, choices: readonly EnumChoice[]) =>
  enumField(field, choices, { allowOther: true, nullable: false });

export const contentCollections: readonly ModelCollection[] = [
  {
    collection: 'courses',
    displayTemplate: courseTemplate,
    fields: [
      required('name'),
      enumField('status', statusChoices, {
        defaultValue: 'active',
        label: 'Status',
        note: statusNote,
        nullable: false,
      }),
      scalar('tags', 'string'),
      // The one Discord channel of the course, picked from either form; it
      // publishes nothing (channel comes from the curriculum entries).
      m2o('discord_channel', 'discord_channels', {
        alias: { field: 'courses', fields: ['name'], template: courseTemplate },
        template: channelTemplate,
      }),
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
      requiredChoice('position', staffPositions),
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
      requiredChoice('type', roomTypes),
      requiredChoice('location', roomLocations),
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
        nullable: false,
        template: staffTemplate,
      }),
      enumField('role', roleChoices, { nullable: false }),
      scalar('sort', 'integer'),
    ],
    hidden: false,
    icon: 'co_present',
    label: { plural: 'Teaching staff', singular: 'Teaching assignment' },
    singleton: false,
    sort: 8,
  },
];
