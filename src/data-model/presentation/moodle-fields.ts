import type { FieldPresentation } from './types.js';

// The Moodle history forms: memberships are the derived index, shown
// read-only; the raw scraper count is never rewritten. The label, First
// seen and the explicit mappings of a line keep the note of their model
// declaration (moodle-collections.ts), one note per field. A pattern
// mapping's Year pattern is hidden, and saved as null, while Only in year
// is set, and required while it is empty.
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
  {
    collection: 'moodle_course_entries',
    field: 'memberships',
    meta: {
      note: 'Moodle users carrying this line, in first-occurrence order; derived, read-only.',
    },
  },
  {
    collection: 'moodle_users',
    field: 'Courses Count',
    meta: {
      note: 'Raw scraper count of history lines; read-only. Compared with the indexed history lines in the data status.',
    },
  },
  {
    collection: 'moodle_users',
    field: 'history_memberships',
    meta: {
      note: 'Distinct history lines of this user in first-occurrence order, derived by the index Flow from the raw Courses text; read-only.',
    },
  },
];
