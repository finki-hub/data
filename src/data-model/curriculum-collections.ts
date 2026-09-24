import type { ModelCollection } from '../schema.js';

import {
  courseTemplate,
  curriculumEntryTemplate,
  provenanceFields,
} from './checkpoint-collections.js';
import { m2o, scalar } from './fields.js';
import { generationReference } from './generation-collections.js';

export const academicYearTemplate = '{{label}}';

export const curriculumCollections: readonly ModelCollection[] = [
  {
    collection: 'academic_years',
    displayTemplate: academicYearTemplate,
    fields: [
      scalar('label', 'string', {
        note: 'Academic year label such as 2025/2026.',
        nullable: false,
        unique: true,
      }),
      scalar('sort', 'integer', {
        note: 'Chronological order: a later year sorts higher. courses.json lists the published years newest first.',
      }),
      scalar('published', 'boolean', {
        defaultValue: false,
        note: "Adds this year to courses.json as a key named by its label, valued by each course's enrollment count. A new year stays out until this is set; readiness then requires a count for every course.",
        nullable: false,
      }),
    ],
    hidden: false,
    icon: 'calendar_month',
    note: 'Academic years referenced by enrollment rules, counts and Moodle mappings. A new year is a new row; it reaches courses.json only once published.',
    origin: 'relational',
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
      scalar('name', 'string', { nullable: false }),
      scalar('catalog_order', 'integer'),
      scalar('url', 'text'),
      scalar('code', 'string'),
      scalar('level', 'integer'),
      scalar('semester', 'integer'),
      scalar('prerequisites', 'text'),
      scalar('channel', 'boolean'),
      ...provenanceFields(),
    ],
    hidden: false,
    icon: 'menu_book',
    note: 'One row per curriculum source row of a generation, including orphans and duplicates; its study-program states are rows of its own.',
    origin: 'relational',
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
          template: '{{generation.code}}: {{entry.name}}',
        },
        nullable: false,
        sortField: 'sort',
        template: courseTemplate,
      }),
      m2o('entry', 'curriculum_entries', {
        alias: {
          field: 'course_links',
          fields: ['course', 'generation', 'credits', 'available'],
          template: '{{course.name}} ({{generation.code}})',
        },
        nullable: false,
        template: curriculumEntryTemplate,
      }),
      generationReference(
        'Must match the generation of the linked curriculum entry.',
      ),
      scalar('credits', 'integer'),
      scalar('available', 'boolean'),
      scalar('sort', 'integer'),
    ],
    hidden: true,
    icon: 'link',
    note: 'Links a course to at most one curriculum entry per generation; credits and availability live on the link.',
    origin: 'relational',
    singleton: false,
    sort: 16,
  },
];
