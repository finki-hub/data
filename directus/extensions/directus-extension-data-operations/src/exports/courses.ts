import {
  assistants,
  availability,
  channel,
  curriculum,
  enrollmentCount,
  level,
  professors,
  programState,
} from './course-values.js';
import { publishedThrough } from './key-sources.js';
import {
  type BlockField,
  type BlockPart,
  defaultMaxBytes,
  type ExportDefinition,
  type NestedKeys,
} from './types.js';

// courses.json: one row per course in id order, projected from the
// relational rows on read, with the keys and value forms its consumers
// read. Its curriculum keys come from published rows: every published
// generation with a curriculum adds its availability key and a block of
// keys, and every published program of it a state key. A new generation
// or program needs no change here. The name, the professors and every
// availability key are required: the consumers reject a file with a row
// lacking one. The professors and assistants come from the published
// timetables, else the accreditation, else the hand-kept links
// (course-values.ts).

// name, code, level, semester, channel and prerequisite of a generation,
// from the course's linked entry of that generation; the level is the one
// its code gives.
const entryFields: readonly BlockField[] = [
  { rule: 'text', suffix: 'name', value: curriculum('entry.name') },
  { rule: 'text', suffix: 'code', value: curriculum('entry.code') },
  { rule: 'number', suffix: 'level', value: level },
  { rule: 'number', suffix: 'semester', value: curriculum('entry.semester') },
  {
    rule: 'numeric_boolean',
    suffix: 'channel',
    value: curriculum('entry.channel'),
  },
  {
    rule: 'text',
    suffix: 'prerequisite',
    value: curriculum('entry.prerequisites'),
  },
];

// The state-key rule: `<generation>-state-<program>` for every published
// program of the generation, in program code order.
const states: NestedKeys = {
  infix: 'state',
  nested: 'published_programs',
  rule: 'text',
  value: programState,
};

// Credits and availability live on the link, not on the entry.
const credits: BlockField = {
  rule: 'number',
  suffix: 'credits',
  value: curriculum('credits'),
};

// The 2018 block lists its credits before its states, as the committed
// file does; every other generation (2023 today, and any new
// one) lists its states first.
const creditsFirst = '2018';

const generationLayout: readonly BlockPart[] = [
  ...entryFields,
  states,
  credits,
];

// The curriculum entry columns and program states the blocks publish.
const entryColumns = [
  'generation',
  'name',
  'code',
  'semester',
  'prerequisites',
  'channel',
  'program_states.program',
  'program_states.state',
];

export const courses: ExportDefinition = {
  fields: [
    { key: 'name', required: true, rule: 'text', value: 'name' },
    // The official English name (FINKI's English subject page).
    { key: 'name-en', rule: 'text', value: 'name_en' },
    { key: 'abbreviation', rule: 'text', value: 'abbreviation' },
    { key: 'professors', required: true, rule: 'text', value: professors },
    // The published-year rule: one key per published academic year, its
    // label, newest first, valued by the course's count for that year.
    { keys: 'published_years', rule: 'number', value: enrollmentCount },
    // One availability key per published generation, newest first, FALSE
    // for a course without a link of that generation.
    {
      keys: 'published_generations',
      required: true,
      rule: 'boolean',
      suffix: 'available',
      value: availability,
    },
    { key: 'channel', rule: 'boolean', value: channel },
    { key: 'tags', rule: 'text', value: 'tags' },
    { key: 'assistants', rule: 'text', value: assistants },
    // One block per published generation, newest first.
    {
      blocks: 'published_generations',
      layouts: {
        byKey: { [creditsFirst]: [...entryFields, credits, states] },
        default: generationLayout,
      },
    },
  ],
  filename: 'courses.json',
  maxBytes: defaultMaxBytes,
  orderBy: 'id',
  related: {
    // The syllabus's "Наставник" list, the fallback without a published
    // timetable.
    accreditation: {
      by: 'course',
      collection: 'course_accreditation_staff',
      fields: ['id', 'course', 'sort', 'generation.code', 'staff.name'],
      sort: ['course', 'sort', 'id'],
    },
    // The hand-kept links, the fallback without either.
    assignments: {
      by: 'course',
      collection: 'teaching_assignments',
      fields: ['id', 'course', 'role', 'sort', 'staff.name'],
      filter: { course: { _nnull: true } },
      sort: ['course', 'sort', 'id'],
    },
    // The links of published generations only: an unpublished
    // generation's links change nothing in the file.
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
      filter: publishedThrough('generation'),
      sort: ['course', 'generation'],
    },
    enrollments: {
      by: 'course',
      collection: 'course_enrollments',
      fields: ['course', 'count', 'academic_year'],
      filter: publishedThrough('academic_year'),
      sort: ['course', 'academic_year'],
    },
    // Who taught the course in the published timetables (the six latest
    // main ones), the first source of its teaching staff.
    teaching: {
      by: 'course',
      collection: 'course_teaching',
      fields: [
        'id',
        'course',
        'role',
        'periods',
        'staff.name',
        'timetable.date_from',
      ],
      filter: { timetable: { recent: { _eq: true } } },
      sort: ['course', 'id'],
    },
  },
  rows: {
    collection: 'courses',
    fields: ['id', 'name', 'name_en', 'abbreviation', 'tags', 'status'],
    sort: ['id'],
  },
};
