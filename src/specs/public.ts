import {
  field,
  literalField,
  requiredField,
  type WorkbookSpec,
} from '../schema.js';

// The course sheet also carries each course's 2023 and 2018 name, credits
// and availability: the import resolves them into curriculum links
// (src/migrations/course-links.ts), never into columns of the course.
const courseFields = [
  requiredField('name', 'name'),
  literalField('professors', 'professors_override', 'text'),
  field('2023-available', 'available_2023', 'boolean'),
  field('2018-available', 'available_2018', 'boolean'),
  field('tags', 'tags'),
  field('2023-name', 'name_2023'),
  field('2023-credits', 'credits_2023', 'integer'),
  literalField('2018-name', 'name_2018_override'),
  field('2018-credits', 'credits_2018', 'integer'),
] as const;

export const publicWorkbookSpecs = [
  {
    fields: courseFields,
    key: 'courses',
    source: { kind: 'rows', sheet: 'Предмети (Export)' },
  },
  {
    fields: [
      requiredField('name', 'name'),
      requiredField('active', 'active', 'boolean'),
      field('title', 'title'),
      field('position', 'position'),
      field('email', 'email'),
      field('cabinet', 'cabinet'),
      field('profile', 'profile', 'text'),
      field('courses', 'courses'),
      field('consultations', 'consultations', 'text'),
    ],
    key: 'staff',
    source: { kind: 'rows', sheet: 'Кадар (Export)' },
  },
  {
    fields: [
      requiredField('name', 'name'),
      field('type', 'type'),
      requiredField('location', 'location'),
      field('description', 'description', 'text'),
      field('floor', 'floor', 'integer'),
      field('capacity', 'capacity', 'integer'),
      field('mrbs', 'mrbs'),
    ],
    key: 'rooms',
    source: { kind: 'rows', sheet: 'Простории (Export)' },
  },
  {
    fields: [
      requiredField('index', 'index_number'),
      requiredField('name', 'name'),
      requiredField('source_group', 'source_group'),
    ],
    key: 'students',
    source: {
      kind: 'student-pairs',
      sheets: ['Индекси - Година', 'Индекси - Други'],
    },
  },
] as const satisfies readonly WorkbookSpec[];
