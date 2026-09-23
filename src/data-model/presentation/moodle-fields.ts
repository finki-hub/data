import type { FieldPresentation } from './types.js';

// The Moodle history forms: the exact label is written by the index run
// only; the review state, reason and mappings are the source data edited
// here; memberships are the derived index, shown read-only; the raw
// scraper count is never rewritten.
export const moodleFieldPresentations: readonly FieldPresentation[] = [
  {
    collection: 'moodle_course_entries',
    field: 'label',
    meta: {
      note: 'Exact text of one Moodle history line (at most 2048 bytes), created by the index run and never edited by hand; whitespace and case are part of the label.',
    },
  },
  {
    collection: 'moodle_course_entries',
    field: 'review_reason',
    meta: {
      note: 'Why this entry stays unmapped or is ignored.',
      width: 'full',
    },
  },
  {
    collection: 'moodle_course_entries',
    field: 'mappings',
    meta: {
      note: 'Course and academic year this entry stands for; mappings are source data that survive every re-index, even once no snapshot carries the entry.',
    },
  },
  {
    collection: 'moodle_course_entries',
    field: 'memberships',
    meta: {
      note: 'Moodle users whose raw history carries this entry, in first-occurrence order: a derived index the scheduled "Data / Process pending" Flow rebuilds after every history edit, never edited.',
    },
  },
  {
    collection: 'moodle_users',
    field: 'Courses Count',
    meta: {
      note: 'Raw scraper count of history lines, never rewritten; the data operations status counts the users whose distinct indexed entries differ from it.',
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
