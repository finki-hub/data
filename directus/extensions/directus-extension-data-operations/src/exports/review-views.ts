import type { Filter } from '@directus/types';

import type { ReviewView } from './readiness-types.js';

import { unlinkedMember } from './curriculum-checks.js';

// The review views of the readiness-check registry: the incomplete-data
// bookmark the import creates per entry that declares one, on its page
// collection, listing the records behind its count with the columns a fix
// needs and the relation back to where each record belongs (its course,
// equivalency or generation). A view of a count entry filters exactly
// like its count (registry-rules.ts refuses a drift); the filters of the
// others come from the check modules that count them. Curriculum views
// show the generation and filter through the curriculum_generations
// relation, never by a generation row, so a new generation needs no view.

// Council memberships and equivalencies whose own link is empty.
export const councilWithoutStudent: Filter = { student: { _null: true } };
export const equivalencyWithoutCourse: Filter = { course: { _null: true } };

export const reviewViews = {
  councilWithoutStudent: {
    bookmark: 'Council members without a student',
    fields: ['year', 'index_number', 'position', 'student'],
    filter: councilWithoutStudent,
    icon: 'how_to_reg',
    sort: ['-year', 'index_number'],
  },
  // The member generations and labels of each equivalency, one list per
  // column (a relational path through the members).
  equivalencyWithoutCourse: {
    bookmark: 'Equivalencies without a course',
    fields: ['members.generation', 'members.label', 'course'],
    filter: equivalencyWithoutCourse,
    icon: 'compare_arrows',
    sort: ['id'],
  },
  unlinkedMembers: {
    bookmark: 'Equivalency labels without an entry',
    fields: ['generation', 'label', 'equivalency', 'equivalency.course'],
    filter: unlinkedMember,
    icon: 'join_inner',
    sort: ['generation', 'equivalency'],
  },
} as const satisfies Readonly<Record<string, ReviewView>>;
