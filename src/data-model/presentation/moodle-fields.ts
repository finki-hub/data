import type { FieldPresentation } from './types.js';

// A pattern mapping's Year pattern is hidden, and saved as null, while
// Only in year is set, and required while it is empty. The notes of the
// Moodle forms are those of their model declarations
// (moodle-collections.ts, mapping-collections.ts).
export const moodleFieldPresentations: readonly FieldPresentation[] = [
  {
    collection: 'moodle_pattern_mappings',
    field: 'year_pattern',
    meta: {
      conditions: [
        {
          clear_hidden_value_on_save: true,
          hidden: true,
          name: 'Only in year set',
          rule: { only_in_year: { _nnull: true } },
        },
        {
          name: 'All years',
          required: true,
          rule: { only_in_year: { _null: true } },
        },
      ],
    },
  },
];
