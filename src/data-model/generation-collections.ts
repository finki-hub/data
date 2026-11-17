import type { CompositeKey } from '../schema-relations.js';
import type { ModelCollection } from '../schema.js';

import { programStates } from './choice-lists.js';
import {
  courseTemplate,
  curriculumEntryTemplate,
  equivalencyTemplate,
  staffTemplate,
} from './content-collections.js';
import { enumField, labelledChoices, m2o, scalar } from './fields.js';

// Curriculum generations and their study programs are rows added in
// Studio, never a code list: a new generation or program is a new row,
// and it reaches courses.json only once its `published` flag is set.
// Program states and equivalency members are rows too, so a new program or
// generation adds rows, not columns.

const generationTemplate = '{{code}}';
const programTemplate = '{{name}} ({{generation.code}})';

// A generation reference: required, and a generation that still has
// entries, links, programs or members cannot be deleted.
export const generationReference = () =>
  m2o('generation', 'curriculum_generations', {
    label: 'Generation',
    nullable: false,
    onDelete: 'NO ACTION',
    template: generationTemplate,
  });

// The `published` flag of a row that reaches courses.json, the same on
// every key source; an unpublished row stays out by the flag's default.
export const published = () =>
  scalar('published', 'boolean', {
    defaultValue: false,
    label: 'Published',
    nullable: false,
  });

// The cycles of study a degree program belongs to.
export const degreeCycles = ['first', 'second', 'third'] as const;

const cycleChoices = labelledChoices(degreeCycles, {
  first: 'First cycle (undergraduate)',
  second: 'Second cycle (master)',
  third: 'Third cycle (doctoral)',
});

// A course's place in a degree program: mandatory in a semester, or
// elective in one of the program's groups.
export const programCourseKinds = ['mandatory', 'elective'] as const;

const programCourseKindChoices = labelledChoices(programCourseKinds, {
  elective: 'Elective',
  mandatory: 'Mandatory',
});

// The elective groups a master's program page lists: the program's own
// and the faculty's, each for the winter or the summer semester, and a
// group of the program's own name.
export const electiveGroups = [
  'program_winter',
  'program_summer',
  'faculty_winter',
  'faculty_summer',
  'named',
] as const;

const electiveGroupChoices = labelledChoices(electiveGroups, {
  faculty_summer: 'Faculty, summer',
  faculty_winter: 'Faculty, winter',
  named: 'A named group',
  program_summer: 'Study program, summer',
  program_winter: 'Study program, winter',
});

// What an elective slot of a semester may be filled with.
export const electiveSlotKinds = ['program', 'program_or_faculty'] as const;

const electiveSlotKindChoices = labelledChoices(electiveSlotKinds, {
  program: 'From the study program',
  program_or_faculty: 'From the study program or the faculty',
});

const degreeProgramTemplate = '{{code}} - {{name}}';

export const generationCollections: readonly ModelCollection[] = [
  {
    collection: 'curriculum_generations',
    displayTemplate: '{{code}} - {{label}}',
    fields: [
      scalar('code', 'string', {
        label: 'Code',
        note: "Prefixes the generation's keys in courses.json, such as 2023-name.",
        nullable: false,
        unique: true,
      }),
      scalar('label', 'string', { label: 'Name', nullable: false }),
      scalar('has_curriculum', 'boolean', {
        defaultValue: false,
        label: 'Has a curriculum',
        note: 'Off for a generation known only from equivalency labels, such as 2013.',
        nullable: false,
      }),
      published(),
    ],
    hidden: false,
    icon: 'timeline',
    label: { plural: 'Generations', singular: 'Generation' },
    singleton: false,
    sort: 26,
  },
  {
    collection: 'study_programs',
    displayTemplate: programTemplate,
    fields: [
      m2o('generation', 'curriculum_generations', {
        alias: {
          field: 'programs',
          fields: ['code', 'name', 'published'],
          label: 'Study programs',
          template: degreeProgramTemplate,
        },
        label: 'Generation',
        nullable: false,
        onDelete: 'NO ACTION',
        template: generationTemplate,
      }),
      scalar('code', 'string', {
        label: 'Code',
        note: "Names the program's state key in courses.json, such as 2023-state-kn.",
        nullable: false,
      }),
      scalar('name', 'string', { label: 'Name', nullable: false }),
      scalar('description', 'text', { label: 'Description' }),
      published(),
    ],
    hidden: false,
    icon: 'workspaces',
    label: { plural: 'Study programs', singular: 'Study program' },
    singleton: false,
    sort: 27,
  },
  // The degree programs FCSE offers, as finki.ukim.mk lists them: each
  // official code (KN23, KN23_3, BKK23_2, KNID) with its names, cycle,
  // duration and accreditation. A first-cycle program links the curriculum
  // column its courses' states are kept under; several programs (a four- and
  // a three-year variant) share one.
  {
    collection: 'degree_programs',
    displayTemplate: degreeProgramTemplate,
    fields: [
      scalar('code', 'string', {
        label: 'Code',
        note: 'As finki.ukim.mk names the program, such as KN23_3.',
        nullable: false,
        unique: true,
      }),
      scalar('name', 'string', { label: 'Name', nullable: false }),
      scalar('name_en', 'string', { label: 'English name' }),
      enumField('cycle', cycleChoices, { label: 'Cycle', nullable: false }),
      scalar('duration_years', 'integer', { label: 'Duration (years)' }),
      scalar('accreditation', 'string', {
        label: 'Accreditation',
        note: 'The year of the accreditation, such as 2023.',
      }),
      scalar('language', 'string', {
        label: 'Language',
        note: 'Only when an official page states it.',
      }),
      scalar('url', 'string', { label: 'Program page' }),
      scalar('title', 'string', {
        label: 'Degree title',
        note: 'The title awarded on completion, as the program page writes it.',
      }),
      scalar('title_en', 'string', { label: 'English degree title' }),
      scalar('ects', 'integer', {
        label: 'ECTS',
        note: 'The credits the program awards in total.',
      }),
      m2o('coordinator', 'staff', {
        alias: {
          field: 'coordinated_programs',
          fields: ['code', 'name'],
          label: 'Coordinated programs',
          template: degreeProgramTemplate,
        },
        label: 'Coordinator',
        template: staffTemplate,
      }),
      scalar('description', 'text', {
        label: 'Description',
        note: 'In the language the program page has it.',
      }),
      scalar('rules', 'text', {
        label: 'Curriculum rules',
        note: 'Course counts, elective limits and extracurricular credits, as the program page states them.',
      }),
      m2o('curriculum_program', 'study_programs', {
        alias: {
          field: 'degree_programs',
          fields: ['code', 'name', 'duration_years'],
          label: 'Degree programs',
          template: degreeProgramTemplate,
        },
        label: 'Curriculum program',
        note: 'The curriculum column whose course states apply; first cycle only.',
        template: programTemplate,
      }),
    ],
    hidden: false,
    icon: 'school',
    label: { plural: 'Degree programs', singular: 'Degree program' },
    singleton: false,
    sort: 27,
  },
  // The courses of a degree program, as its finki.ukim.mk page lists them:
  // each mandatory course with its semester, each elective with its group
  // and recommended semester. Kept for the master's programs; a course
  // listed under two codes has a row for each.
  {
    collection: 'degree_program_courses',
    displayTemplate: '{{program.code}}: {{code}} {{course.name}}',
    fields: [
      m2o('program', 'degree_programs', {
        alias: {
          field: 'courses',
          fields: ['code', 'course', 'kind', 'semester', 'group'],
          label: 'Courses',
          template: '{{semester}} {{kind}}: {{code}} {{course.name}}',
        },
        label: 'Degree program',
        nullable: false,
        template: degreeProgramTemplate,
      }),
      m2o('course', 'courses', {
        alias: {
          field: 'degree_programs',
          fields: ['program', 'kind', 'semester', 'group'],
          label: 'In degree programs',
          template: '{{program.code}}: {{kind}} {{semester}}',
        },
        label: 'Course',
        nullable: false,
        template: courseTemplate,
      }),
      scalar('code', 'string', {
        label: 'Code',
        note: 'As the program page lists it, such as DCS-Z-02.',
        nullable: false,
      }),
      enumField('kind', programCourseKindChoices, {
        label: 'Kind',
        nullable: false,
      }),
      scalar('semester', 'integer', {
        label: 'Semester',
        note: 'Of a mandatory course; the recommended one of an elective.',
      }),
      enumField('group', electiveGroupChoices, {
        label: 'Elective group',
        note: 'Empty for a mandatory course.',
      }),
      scalar('group_name', 'string', {
        label: 'Group name',
        note: 'As the program page names the group.',
      }),
      scalar('credits', 'integer', { label: 'ECTS' }),
      scalar('requires', 'text', {
        label: 'Prerequisites',
        note: 'As the program page writes them.',
      }),
    ],
    hidden: false,
    icon: 'format_list_numbered',
    label: {
      plural: 'Degree program courses',
      singular: 'Degree program course',
    },
    singleton: false,
    sort: 27,
  },
  // The elective slots of a degree program's semesters: how many electives
  // a student picks there, and from which lists.
  {
    collection: 'degree_program_slots',
    displayTemplate: '{{program.code}}: {{semester}} {{kind}} x{{count}}',
    fields: [
      m2o('program', 'degree_programs', {
        alias: {
          field: 'elective_slots',
          fields: ['semester', 'kind', 'count'],
          label: 'Elective slots',
          template: '{{semester}}: {{count}} x {{kind}}',
        },
        label: 'Degree program',
        nullable: false,
        template: degreeProgramTemplate,
      }),
      scalar('semester', 'integer', { label: 'Semester', nullable: false }),
      enumField('kind', electiveSlotKindChoices, {
        label: 'Kind',
        nullable: false,
      }),
      scalar('count', 'integer', {
        label: 'Electives',
        minimum: 1,
        nullable: false,
      }),
    ],
    hidden: false,
    icon: 'playlist_add',
    label: {
      plural: 'Degree program slots',
      singular: 'Degree program slot',
    },
    singleton: false,
    sort: 27,
  },
  {
    collection: 'curriculum_entry_program_states',
    displayTemplate: '{{program.code}}: {{state}}',
    fields: [
      m2o('entry', 'curriculum_entries', {
        alias: {
          field: 'program_states',
          fields: ['program', 'state'],
          junction: 'program',
          label: 'Study programs',
          template: '{{program.name}}: {{state}}',
        },
        label: 'Curriculum entry',
        nullable: false,
        template: curriculumEntryTemplate,
      }),
      m2o('program', 'study_programs', {
        label: 'Study program',
        nullable: false,
        onDelete: 'NO ACTION',
        template: programTemplate,
      }),
      enumField('state', programStates, {
        allowOther: true,
        label: 'State',
      }),
    ],
    hidden: true,
    icon: 'fact_check',
    label: { plural: 'Program states', singular: 'Program state' },
    singleton: false,
    sort: 28,
  },
  {
    collection: 'course_equivalency_members',
    displayTemplate: '{{generation.code}}: {{label}}',
    fields: [
      m2o('equivalency', 'course_equivalencies', {
        alias: {
          field: 'members',
          // The entry's code and name as their own columns, so a label
          // linked to no entry shows empty cells rather than its entry
          // template filled with placeholders (follow-up 61).
          fields: ['generation', 'label', 'entry.code', 'entry.name'],
          label: 'Members',
          template: '{{generation.code}}: {{label}}',
        },
        label: 'Equivalency',
        nullable: false,
        template: equivalencyTemplate,
      }),
      generationReference(),
      scalar('label', 'string', {
        label: 'Label',
        readOnly: true,
      }),
      m2o('entry', 'curriculum_entries', {
        alias: {
          field: 'equivalency_memberships',
          fields: ['equivalency', 'generation', 'label'],
          label: 'Equivalencies',
          template: '{{generation.code}}: {{label}}',
        },
        label: 'Curriculum entry',
        template: curriculumEntryTemplate,
      }),
    ],
    hidden: false,
    icon: 'join_inner',
    label: { plural: 'Equivalency members', singular: 'Equivalency member' },
    singleton: false,
    sort: 29,
  },
];

// One row per program, course and code; a course's programs are found by
// it.
export const degreeProgramKeys: readonly CompositeKey[] = [
  {
    collection: 'degree_program_courses',
    columns: ['program', 'course', 'code'],
    kind: 'unique',
    name: 'degree_program_courses_program_course_code_unique',
  },
  {
    collection: 'degree_program_courses',
    columns: ['course'],
    kind: 'index',
    name: 'degree_program_courses_course_index',
  },
  {
    collection: 'degree_program_slots',
    columns: ['program', 'semester', 'kind'],
    kind: 'unique',
    name: 'degree_program_slots_program_semester_kind_unique',
  },
];
