import { assignmentCheck } from './assignment-checks.js';
import {
  assistants,
  channel,
  curriculum,
  enrollmentCount,
  type Generation,
  legacyName,
  professors,
} from './course-values.js';
import { curriculumCheck, importedValuesCheck } from './curriculum-checks.js';
import { enrollmentCheck, mappingCheck } from './enrollment-checks.js';
import {
  defaultMaxBytes,
  type ExportDefinition,
  type FieldEntry,
} from './types.js';

// courses.json: one row per course in id order, with the keys, order and
// value forms of the reference serializer (serialize-assets.cjs), projected
// from the relational rows on read.

// The public academic-year keys, newest first: the explicit configuration
// of this file. A new academic_years row adds no public key until its
// label is listed here, and every exported course needs a count for every
// year listed.
export const exportedYears = [
  '2025/2026',
  '2024/2025',
  '2023/2024',
  '2022/2023',
  '2021/2022',
  '2020/2021',
  '2019/2020',
  '2018/2019',
  '2017/2018',
  '2016/2017',
  '2015/2016',
  '2014/2015',
  '2013/2014',
  '2012/2013',
  '2011/2012',
] as const;

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
  checks: [
    enrollmentCheck(exportedYears),
    curriculumCheck,
    importedValuesCheck,
    assignmentCheck,
    mappingCheck,
  ],
  fields: [
    { key: 'name', rule: 'text', value: 'name' },
    { key: 'professors', rule: 'text', value: professors },
    ...exportedYears.map((year): FieldEntry => ({
      key: year,
      rule: 'number',
      value: enrollmentCount(year),
    })),
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
      fields: ['course', 'count', 'academic_year.label'],
      filter: { academic_year: { label: { _in: [...exportedYears] } } },
      sort: ['course', 'academic_year'],
    },
  },
  rows: {
    collection: 'courses',
    fields: ['id', 'name', 'tags', 'professors_override', 'name_2018_override'],
    sort: ['id'],
  },
};
