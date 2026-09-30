import type { FieldPresentation } from './types.js';

// The Moodle history forms: the review reason takes the full width; the
// mappings are the source data edited here; memberships are the derived
// index, shown read-only; the raw scraper count is never rewritten. The
// label and the review reason keep the note of their model declaration
// (moodle-collections.ts), one note per field.
export const moodleFieldPresentations: readonly FieldPresentation[] = [
  {
    collection: 'moodle_course_entries',
    field: 'review_reason',
    meta: { width: 'full' },
  },
  {
    collection: 'moodle_course_entries',
    field: 'mappings',
    meta: {
      note: 'Courses and academic years this entry stands for; source data, kept across re-indexing.',
    },
  },
  {
    collection: 'moodle_course_entries',
    field: 'memberships',
    meta: {
      note: 'Moodle users carrying this entry, in first-occurrence order; derived, read-only.',
    },
  },
  {
    collection: 'moodle_users',
    field: 'Courses Count',
    meta: {
      note: 'Raw scraper count of history lines; read-only. Compared with the indexed entries in the data status.',
    },
  },
  {
    collection: 'moodle_users',
    field: 'history_memberships',
    meta: {
      note: 'Distinct history entries of this user in first-occurrence order, derived by the index Flow from the raw Courses text; read-only.',
    },
  },
];
