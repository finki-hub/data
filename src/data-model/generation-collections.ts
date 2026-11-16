import type { ModelCollection } from '../schema.js';

import { programStates } from './choice-lists.js';
import {
  curriculumEntryTemplate,
  equivalencyTemplate,
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
          template: '{{code}} - {{name}}',
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
    displayTemplate: '{{code}} - {{name}}',
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
      m2o('curriculum_program', 'study_programs', {
        alias: {
          field: 'degree_programs',
          fields: ['code', 'name', 'duration_years'],
          label: 'Degree programs',
          template: '{{code}} - {{name}}',
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
