import type { ModelCollection } from '../schema.js';

import { curriculumEntryTemplate } from './checkpoint-collections.js';
import { m2o, scalar } from './fields.js';

// Curriculum generations and their study programs are rows administrators
// add in Studio, never a code list: a new generation or program is a new
// row, and it reaches courses.json only once its `published` flag is set.
// Program states and equivalency members are rows too, so a new program or
// generation adds rows, not columns.

export const generationTemplate = '{{code}}';
export const programTemplate = '{{name}} ({{generation.code}})';

// A generation reference: required, and a generation that still has
// entries, links, programs or members cannot be deleted.
export const generationReference = (note: string) =>
  m2o('generation', 'curriculum_generations', {
    note,
    nullable: false,
    onDelete: 'NO ACTION',
    template: generationTemplate,
  });

const published = (what: string) =>
  scalar('published', 'boolean', {
    defaultValue: false,
    note: `Publishes ${what} in courses.json. A new row stays out until this is set.`,
    nullable: false,
  });

export const generationCollections: readonly ModelCollection[] = [
  {
    collection: 'curriculum_generations',
    displayTemplate: '{{code}} - {{label}}',
    fields: [
      scalar('code', 'string', {
        note: 'Short code such as 2023. It prefixes the public keys of the generation in courses.json (2023-name, 2023-state-kn).',
        nullable: false,
        unique: true,
      }),
      scalar('label', 'string', { nullable: false }),
      scalar('has_curriculum', 'boolean', {
        defaultValue: false,
        note: 'Set for a generation with curriculum entries; a label-only generation (such as 2013) names equivalency members only.',
        nullable: false,
      }),
      published(
        'the generation (its availability key and its block of keys, when it has a curriculum)',
      ),
      scalar('sort', 'integer', {
        note: 'Chronological order: a later generation sorts higher. courses.json lists the published generations newest first.',
      }),
    ],
    hidden: false,
    icon: 'timeline',
    note: 'Curriculum generations. A new generation is a new row; it reaches courses.json only once published.',
    origin: 'relational',
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
          fields: ['code', 'name', 'published', 'sort'],
          template: '{{code}} - {{name}}',
        },
        nullable: false,
        onDelete: 'NO ACTION',
        sortField: 'sort',
        template: generationTemplate,
      }),
      scalar('code', 'string', {
        note: 'Short code such as kn, unique within the generation. courses.json names the state key after the generation code and this code, such as 2023-state-kn.',
        nullable: false,
      }),
      scalar('name', 'string', { nullable: false }),
      scalar('description', 'text'),
      published(
        "the program's state key, once its generation is published too",
      ),
      scalar('sort', 'integer', {
        note: 'Order of the state keys within the generation.',
      }),
    ],
    hidden: false,
    icon: 'workspaces',
    note: 'Study programs, one row per program and generation.',
    origin: 'relational',
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
          template: '{{program.name}}: {{state}}',
        },
        nullable: false,
        template: curriculumEntryTemplate,
      }),
      m2o('program', 'study_programs', {
        note: 'A program of the entry’s generation; the database refuses another.',
        nullable: false,
        onDelete: 'NO ACTION',
        template: programTemplate,
      }),
      scalar('state', 'string', {
        note: 'The state of the entry in the program, as the curriculum sheet wrote it.',
      }),
    ],
    hidden: true,
    icon: 'fact_check',
    note: 'The state of a curriculum entry in each study program of its generation, edited from the entry form.',
    origin: 'relational',
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
          template: '{{generation.code}}: {{label}}',
        },
        nullable: false,
        sortField: 'sort',
        template: '{{course_2023}}',
      }),
      generationReference(
        'One member per generation of an equivalency; a linked entry must be of this generation.',
      ),
      scalar('label', 'string', {
        note: 'The literal label of the imported equivalency sheet; kept as imported.',
        readOnly: true,
      }),
      m2o('entry', 'curriculum_entries', {
        alias: {
          field: 'equivalency_memberships',
          fields: ['equivalency', 'generation', 'label'],
          template: '{{generation.code}}: {{label}}',
        },
        note: 'The curriculum entry the label names, when it names exactly one of that generation.',
        template: curriculumEntryTemplate,
      }),
      scalar('sort', 'integer'),
    ],
    hidden: false,
    icon: 'join_inner',
    note: 'The members of a course equivalency: one literal label per generation, linked to its curriculum entry when unambiguous. A new generation adds members, not columns.',
    origin: 'relational',
    singleton: false,
    sort: 29,
  },
];
