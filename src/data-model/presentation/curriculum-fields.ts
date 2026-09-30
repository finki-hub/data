import type { FieldCondition, FieldPresentation } from './types.js';

import { curriculumEntryTemplate } from '../content-collections.js';
import { baselineOptions } from './baseline.js';

// Rendered by Studio with the form's own live `generation` value (the
// generation id) before the picker queries, so only entries or programs of
// that generation are offered. The database guards from the schema
// constraints reject the rest; the filter is a convenience, not a
// permission.
export const generationFilter = { generation: { _eq: '{{ generation }}' } };

// A new row carries `generation: null`, so the picker stays locked until a
// generation is chosen; opened earlier, Studio would query with an empty
// generation and get an invalid-query error back.
export const lockedWithoutGeneration: FieldCondition = {
  name: 'Generation not chosen yet',
  readonly: true,
  rule: { generation: { _null: true } },
};

// A generation picker offering only generations with a curriculum: an
// entry or a link belongs to one, and the database refuses the others.
const curriculumGenerations = (collection: string): FieldPresentation => ({
  collection,
  field: 'generation',
  meta: {
    options: {
      ...baselineOptions(collection, 'generation'),
      filter: { has_curriculum: { _eq: true } },
    },
  },
});

// An entry picker filtered by the row's generation and locked without one.
const generationPicker = (
  collection: string,
  field: string,
): FieldPresentation => ({
  collection,
  field,
  meta: {
    conditions: [lockedWithoutGeneration],
    note: "Entries of the row's generation only; locked until a generation is set.",
    options: {
      ...baselineOptions(collection, field),
      filter: generationFilter,
      template: curriculumEntryTemplate,
    },
  },
});

// The curriculum forms: pickers filtered by the row's generation and
// locked without one, generation pickers limited to generations with a
// curriculum, and the program states of an entry.
export const curriculumFieldPresentations: readonly FieldPresentation[] = [
  generationPicker('course_curricula', 'entry'),
  { collection: 'course_curricula', field: 'entry', meta: { sort: 3 } },
  // The generation comes before the entry it filters.
  { collection: 'course_curricula', field: 'generation', meta: { sort: 2 } },
  curriculumGenerations('curriculum_entries'),
  curriculumGenerations('course_curricula'),
  generationPicker('course_equivalency_members', 'entry'),
  // The study programs of an entry: picked among the programs of the
  // entry's generation, each with its state on the junction row. The
  // program and entry of a junction row are set by the list itself.
  // Studio's M2M drawer also shows the program's own fields, so the note
  // says whose fields they are (the key guard keeps a published code).
  {
    collection: 'curriculum_entries',
    field: 'program_states',
    meta: {
      conditions: [lockedWithoutGeneration],
      note: "Study programs of the entry's generation, each with its state for this entry; locked until a generation is set. Fields below State: the study program itself, for its whole generation; a published program keeps its code.",
      options: {
        ...baselineOptions('curriculum_entries', 'program_states'),
        filter: generationFilter,
      },
    },
  },
  {
    collection: 'curriculum_entry_program_states',
    field: 'entry',
    meta: { hidden: true },
  },
  {
    collection: 'curriculum_entry_program_states',
    field: 'program',
    meta: { hidden: true },
  },
];
