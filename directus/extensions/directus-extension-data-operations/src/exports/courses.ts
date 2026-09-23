import {
  assistants,
  channel,
  curriculum,
  enrollmentCount,
  type Generation,
  legacyName,
  professors,
} from './course-values.js';
import { publishedYear } from './key-sources.js';
import {
  defaultMaxBytes,
  type ExportDefinition,
  type FieldEntry,
} from './types.js';

// courses.json: one row per course in id order, with the keys, order and
// value forms of the reference serializer (serialize-assets.cjs), projected
// from the relational rows on read.

const states2023 = ['kn', 'siis', 'pit', 'imb', 'ki', 'ie', 'ssp', 'seis'];
const states2018 = ['kn', 'siis', 'pit', 'imb', 'ki', 'ke', 'seis'];

// The curriculum entry columns the generation keys publish.
const entryColumns = [
  'generation',
  'name',
  'code',
  'level',
  'semester',
  'prerequisites',
  'channel',
  ...['kn', 'siis', 'pit', 'imb', 'ki', 'ie', 'ssp', 'ke', 'seis'].map(
    (state) => `state_${state}`,
  ),
];

// name, code, level, semester, channel and prerequisite of a generation,
// from its linked entry (2018-name prefers name_2018_override).
const entryFields = (generation: Generation): FieldEntry[] => [
  {
    key: `${generation}-name`,
    rule: 'text',
    value:
      generation === '2018' ? legacyName : curriculum(generation, 'entry.name'),
  },
  {
    key: `${generation}-code`,
    rule: 'text',
    value: curriculum(generation, 'entry.code'),
  },
  {
    key: `${generation}-level`,
    rule: 'number',
    value: curriculum(generation, 'entry.level'),
  },
  {
    key: `${generation}-semester`,
    rule: 'number',
    value: curriculum(generation, 'entry.semester'),
  },
  {
    key: `${generation}-channel`,
    rule: 'numeric_boolean',
    value: curriculum(generation, 'entry.channel'),
  },
  {
    key: `${generation}-prerequisite`,
    rule: 'text',
    value: curriculum(generation, 'entry.prerequisites'),
  },
];

const stateFields = (
  generation: Generation,
  states: readonly string[],
): FieldEntry[] =>
  states.map((state) => ({
    key: `${generation}-state-${state}`,
    rule: 'text',
    value: curriculum(generation, `entry.state_${state}`),
  }));

// Credits and availability live on the link, not on the entry.
const linkField = (
  generation: Generation,
  column: 'available' | 'credits',
): FieldEntry => ({
  key: `${generation}-${column}`,
  rule: column === 'credits' ? 'number' : 'boolean',
  value: curriculum(generation, column),
});

export const courses: ExportDefinition = {
  fields: [
    { key: 'name', rule: 'text', value: 'name' },
    { key: 'professors', rule: 'text', value: professors },
    // The published-year rule: one key per published academic year, its
    // label, newest first, valued by the course's count for that year.
    { keys: 'published_years', rule: 'number', value: enrollmentCount },
    linkField('2023', 'available'),
    linkField('2018', 'available'),
    { key: 'channel', rule: 'boolean', value: channel },
    { key: 'tags', rule: 'text', value: 'tags' },
    { key: 'assistants', rule: 'text', value: assistants },
    ...entryFields('2023'),
    ...stateFields('2023', states2023),
    linkField('2023', 'credits'),
    ...entryFields('2018'),
    linkField('2018', 'credits'),
    ...stateFields('2018', states2018),
  ],
  filename: 'courses.json',
  maxBytes: defaultMaxBytes,
  orderBy: 'id',
  related: {
    assignments: {
      by: 'course',
      collection: 'teaching_assignments',
      fields: [
        'id',
        'course',
        'role',
        'sort',
        'display_override',
        'staff.name',
      ],
      filter: { course: { _nnull: true } },
      sort: ['course', 'sort', 'id'],
    },
    curricula: {
      by: 'course',
      collection: 'course_curricula',
      fields: [
        'course',
        'generation',
        'credits',
        'available',
        ...entryColumns.map((column) => `entry.${column}`),
      ],
      sort: ['course', 'generation'],
    },
    enrollments: {
      by: 'course',
      collection: 'course_enrollments',
      fields: ['course', 'count', 'academic_year'],
      filter: publishedYear('academic_year'),
      sort: ['course', 'academic_year'],
    },
  },
  rows: {
    collection: 'courses',
    fields: ['id', 'name', 'tags', 'professors_override', 'name_2018_override'],
    sort: ['id'],
  },
};
