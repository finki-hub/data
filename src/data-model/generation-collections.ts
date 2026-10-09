import type { ModelCollection } from '../schema.js';

import { programStates } from './choice-lists.js';
import {
  curriculumEntryTemplate,
  equivalencyTemplate,
} from './content-collections.js';
import { enumField, m2o, scalar } from './fields.js';

// Curriculum generations and their study programs are rows added in
// Studio, never a code list: a new generation or program is a new row,
// and it reaches courses.json only once its `published` flag is set.
// Program states and equivalency members are rows too, so a new program or
// generation adds rows, not columns.

const generationTemplate = '{{code}}';
const programTemplate = '{{name}} ({{generation.code}})';

// A generation reference: required, and a generation that still has
// entries, links, programs or members cannot be deleted.
export const generationReference = (note: string) =>
  m2o('generation', 'curriculum_generations', {
    label: 'Generation',
    note,
    nullable: false,
    onDelete: 'NO ACTION',
    template: generationTemplate,
  });

type Publication = {
  // What publishing requires or implies.
  readonly condition?: string;
  // What publishing adds besides the subject's keys.
  readonly detail?: string;
};

// The `published` flag of a row that reaches courses.json: one note shape
// for every key source, `Adds <subject> to courses.json[ (<detail>)][;
// <condition>].` An unpublished row stays out by the flag's default.
export const published = (
  subject: string,
  { condition, detail }: Publication = {},
) =>
  scalar('published', 'boolean', {
    defaultValue: false,
    label: 'Published',
    note: [
      `Adds ${subject} to courses.json`,
      detail === undefined ? '' : ` (${detail})`,
      condition === undefined ? '' : `; ${condition}`,
      '.',
    ].join(''),
    nullable: false,
  });

export const generationCollections: readonly ModelCollection[] = [
  {
    collection: 'curriculum_generations',
    displayTemplate: '{{code}} - {{label}}',
    fields: [
      scalar('code', 'string', {
        label: 'Code',
        note: 'Short code such as 2023. It prefixes the public keys of the generation in courses.json (2023-name, 2023-state-kn).',
        nullable: false,
        unique: true,
      }),
      scalar('label', 'string', { label: 'Name', nullable: false }),
      scalar('has_curriculum', 'boolean', {
        defaultValue: false,
        label: 'Has a curriculum',
        note: 'Set for a generation with curriculum entries; a label-only generation (such as 2013) names equivalency members only.',
        nullable: false,
      }),
      published('the generation', {
        detail: 'availability key; key block when it has a curriculum',
      }),
    ],
    hidden: false,
    icon: 'timeline',
    label: { plural: 'Generations', singular: 'Generation' },
    note: 'Curriculum generations.',
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
        note: 'Short code such as kn, unique within the generation. courses.json names the state key after the generation code and this code, such as 2023-state-kn.',
        nullable: false,
      }),
      scalar('name', 'string', { label: 'Name', nullable: false }),
      scalar('description', 'text', { label: 'Description' }),
      published("the program's state key", {
        condition: 'requires a published generation',
      }),
    ],
    hidden: false,
    icon: 'workspaces',
    label: { plural: 'Study programs', singular: 'Study program' },
    note: 'Study programs, one row per program and generation.',
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
        note: "A program of the entry's generation; the database refuses another.",
        nullable: false,
        onDelete: 'NO ACTION',
        template: programTemplate,
      }),
      enumField('state', programStates, {
        allowOther: true,
        label: 'State',
        note: 'The state of the entry in the program, as the curriculum sheet wrote it.',
      }),
    ],
    hidden: true,
    icon: 'fact_check',
    label: { plural: 'Program states', singular: 'Program state' },
    note: 'The state of a curriculum entry in each study program of its generation, edited from the entry form.',
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
      generationReference(
        'One member per generation of an equivalency; a linked entry must be of this generation.',
      ),
      scalar('label', 'string', {
        label: 'Label',
        note: 'Literal label from the imported equivalency sheet.',
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
        note: 'The curriculum entry the label names, when it names exactly one of that generation.',
        template: curriculumEntryTemplate,
      }),
    ],
    hidden: false,
    icon: 'join_inner',
    label: { plural: 'Equivalency members', singular: 'Equivalency member' },
    note: 'Members of a course equivalency: one literal label per generation, linked to its curriculum entry when unambiguous.',
    singleton: false,
    sort: 29,
  },
];
