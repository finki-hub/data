import type { ModelCollection } from '../schema.js';

import {
  courseTemplate,
  curriculumEntryTemplate,
  provenanceFields,
} from './checkpoint-collections.js';
import { enumField, m2o, scalar } from './fields.js';

export const generations = ['2018', '2023'] as const;

export const academicYearTemplate = '{{label}}';

const studyProgramStates = [
  'kn',
  'siis',
  'pit',
  'imb',
  'ki',
  'ie',
  'ssp',
  'ke',
  'seis',
] as const;

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
      scalar('sort', 'integer'),
    ],
    hidden: false,
    icon: 'calendar_month',
    note: 'Academic years referenced by enrollment rules, counts and Moodle mappings. A new year is a new row.',
    origin: 'relational',
    singleton: false,
    sort: 14,
  },
  {
    collection: 'curriculum_entries',
    displayTemplate: curriculumEntryTemplate,
    fields: [
      enumField('generation', generations, { nullable: false }),
      scalar('name', 'string', { nullable: false }),
      scalar('catalog_order', 'integer'),
      scalar('url', 'text'),
      scalar('code', 'string'),
      scalar('level', 'integer'),
      scalar('semester', 'integer'),
      scalar('prerequisites', 'text'),
      scalar('channel', 'boolean'),
      ...studyProgramStates.map((state) => scalar(`state_${state}`, 'string')),
      ...provenanceFields(),
    ],
    hidden: false,
    icon: 'menu_book',
    note: 'One row per 2018 or 2023 curriculum source row, including orphans and duplicates.',
    origin: 'relational',
    singleton: false,
    sort: 15,
  },
  {
    collection: 'course_curricula',
    displayTemplate: '{{course.name}} - {{entry.name}} ({{generation}})',
    fields: [
      m2o('course', 'courses', {
        alias: {
          field: 'curricula',
          fields: ['generation', 'entry', 'credits', 'available'],
          template: '{{generation}}: {{entry.name}}',
        },
        nullable: false,
        sortField: 'sort',
        template: courseTemplate,
      }),
      m2o('entry', 'curriculum_entries', {
        alias: {
          field: 'course_links',
          fields: ['course', 'generation', 'credits', 'available'],
          template: '{{course.name}} ({{generation}})',
        },
        nullable: false,
        template: curriculumEntryTemplate,
      }),
      enumField('generation', generations, {
        note: 'Must match the generation of the linked curriculum entry.',
        nullable: false,
      }),
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
