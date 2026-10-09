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
        note: 'Academic year label such as 2025/2026.',
        nullable: false,
        unique: true,
      }),
      published('the year', {
        condition: 'readiness then requires a count per course',
        detail: "key: label; value: each course's enrollment count",
      }),
    ],
    hidden: false,
    icon: 'calendar_month',
    label: { plural: 'Academic years', singular: 'Academic year' },
    note: 'Academic years referenced by enrollment counts and Moodle mappings.',
    singleton: false,
    sort: 14,
  },
  {
    collection: 'curriculum_entries',
    displayTemplate: curriculumEntryTemplate,
    fields: [
      generationReference(
        'Only a generation with a curriculum takes entries; the database refuses the others.',
      ),
      scalar('name', 'string', { label: 'Name', nullable: false }),
      scalar('catalog_order', 'integer', { label: 'Catalog order' }),
      scalar('url', 'text', { label: 'Link' }),
      scalar('code', 'string', {
        label: 'Code',
        note: 'The digit after L is the level: F18L3W055 is level 3.',
      }),
      scalar('semester', 'integer', { label: 'Semester' }),
      scalar('prerequisites', 'text', { label: 'Prerequisites' }),
      scalar('channel', 'boolean', { label: 'Has a Discord channel' }),
    ],
    hidden: false,
    icon: 'menu_book',
    label: { plural: 'Curriculum entries', singular: 'Curriculum entry' },
    note: "One row per row of a generation's curriculum sheet, including orphans and duplicates; its study-program states are rows of its own.",
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
      generationReference(
        'Must match the generation of the linked curriculum entry.',
      ),
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
    note: 'Links a course to at most one curriculum entry per generation; credits and availability live on the link.',
    singleton: false,
    sort: 16,
  },
];
