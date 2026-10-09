import type { ModelCollection } from '../schema.js';

import {
  courseTemplate,
  curriculumEntryTemplate,
} from './content-collections.js';
import { m2o, scalar } from './fields.js';
import { generationReference, published } from './generation-collections.js';

export const academicYearTemplate = '{{label}}';

export const curriculumCollections: readonly ModelCollection[] = [
  {
    collection: 'academic_years',
    displayTemplate: academicYearTemplate,
    fields: [
      scalar('label', 'string', {
        label: 'Year',
        nullable: false,
        unique: true,
      }),
      published(),
    ],
    hidden: false,
    icon: 'calendar_month',
    label: { plural: 'Academic years', singular: 'Academic year' },
    singleton: false,
    sort: 14,
  },
  {
    collection: 'curriculum_entries',
    displayTemplate: curriculumEntryTemplate,
    fields: [
      generationReference(),
      scalar('name', 'string', { label: 'Name', nullable: false }),
      scalar('catalog_order', 'integer', { label: 'Catalog order' }),
      scalar('url', 'text', { label: 'Link' }),
      scalar('code', 'string', {
        label: 'Code',
        note: 'The digit after L is the level: F18L3W055 is level 3.',
      }),
      scalar('semester', 'integer', { label: 'Semester' }),
      scalar('prerequisites', 'text', { label: 'Prerequisites' }),
      scalar('channel', 'boolean', {
        label: 'Has a Discord channel',
        note: "Published as channel. Independent of the course's Discord channel.",
      }),
    ],
    hidden: false,
    icon: 'menu_book',
    label: { plural: 'Curriculum entries', singular: 'Curriculum entry' },
    singleton: false,
    sort: 15,
  },
  {
    collection: 'course_curricula',
    displayTemplate: '{{course.name}} - {{entry.name}} ({{generation.code}})',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'curricula',
          fields: ['generation', 'entry', 'credits', 'available'],
          label: 'Curriculum links',
          template: '{{generation.code}}: {{entry.name}}',
        },
        label: 'Course',
        nullable: false,
        template: courseTemplate,
      }),
      m2o('entry', 'curriculum_entries', {
        alias: {
          field: 'course_links',
          fields: ['course', 'generation', 'credits', 'available'],
          label: 'Linked courses',
          template: '{{course.name}} ({{generation.code}})',
        },
        label: 'Curriculum entry',
        nullable: false,
        template: curriculumEntryTemplate,
      }),
      generationReference(),
      scalar('credits', 'integer', { label: 'Credits' }),
      scalar('available', 'boolean', {
        defaultValue: true,
        label: 'Available',
        nullable: false,
      }),
    ],
    hidden: true,
    icon: 'link',
    label: { plural: 'Curriculum links', singular: 'Curriculum link' },
    singleton: false,
    sort: 16,
  },
];
