import type { Filter } from '@directus/types';

import type { ReviewView } from './readiness-types.js';

import {
  labelOnlyRow,
  roleMissing,
  unresolvedRow,
} from './assignment-checks.js';
import { namingMembers, unlinkedMember } from './curriculum-checks.js';
import { awaitingMapping } from './enrollment-checks.js';

// The Needs review views of the readiness-check registry: one shared
// Studio bookmark per entry that declares one, on its page collection,
// listing the records behind its count with the columns an editor needs
// and the relation back to where each record belongs (its course,
// equivalency or generation). A view of a count entry filters exactly
// like its count (registry-rules.ts refuses a drift); the filters of the
// others come from the check modules that count them. Curriculum views
// show the generation and filter through the curriculum_generations
// relation, never by a generation row, so a new generation needs no view.

// The Moodle entries still marked needs_mapping, without a mapping (the
// O2M path joins the mappings; a missing one leaves its id NULL) or with
// one that nobody has reviewed yet.
const unmapped: Filter = {
  _and: [awaitingMapping, { mappings: { id: { _null: true } } }],
};
const mappedUnreviewed: Filter = {
  _and: [awaitingMapping, { mappings: { id: { _nnull: true } } }],
};

// Council memberships and equivalencies whose own link is empty.
export const councilWithoutStudent: Filter = { student: { _null: true } };
export const equivalencyWithoutCourse: Filter = { course: { _null: true } };

export const reviewViews = {
  assignmentLabelOnly: {
    bookmark: 'Assignments shown by their label only',
    fields: ['course', 'role', 'display_override', 'source_id'],
    filter: labelOnlyRow,
    icon: 'badge',
    lists: 'counted',
    sort: ['course', 'role', 'sort'],
  },
  assignmentRoleMissing: {
    bookmark: 'Assignments without a known role',
    fields: ['course', 'role', 'staff', 'display_override', 'source_id'],
    filter: roleMissing,
    icon: 'badge',
    lists: 'counted',
    sort: ['course', 'sort'],
  },
  assignmentUnresolved: {
    bookmark: 'Assignments without staff or label',
    fields: ['course', 'role', 'source_id'],
    filter: unresolvedRow,
    icon: 'badge',
    lists: 'counted',
    sort: ['course', 'role', 'sort'],
  },
  councilWithoutStudent: {
    bookmark: 'Council members without a student',
    fields: ['year', 'index_number', 'position', 'student'],
    filter: councilWithoutStudent,
    icon: 'how_to_reg',
    lists: 'counted',
    sort: ['-year', 'index_number'],
  },
  // The equivalency members the link check reads: beside each, the
  // generations of the curriculum links of the course it names, so a
  // missing link of the member's generation shows at a glance.
  curriculumLinksToCheck: {
    bookmark: 'Curriculum links to check',
    fields: [
      'generation',
      'label',
      'entry',
      'equivalency.course',
      'equivalency.course.curricula.generation',
    ],
    filter: namingMembers,
    icon: 'link',
    lists: 'candidates',
    sort: ['equivalency'],
  },
  // The member generations and labels of each equivalency, one list per
  // column (a relational path through the members).
  equivalencyWithoutCourse: {
    bookmark: 'Equivalencies without a course',
    fields: ['members.generation', 'members.label', 'course'],
    filter: equivalencyWithoutCourse,
    icon: 'compare_arrows',
    lists: 'counted',
    sort: ['course_2023'],
  },
  mappedAwaitingReview: {
    bookmark: 'Mapped entries awaiting review',
    fields: [
      'label',
      'mappings.course',
      'mappings.academic_year',
      'review_reason',
    ],
    filter: mappedUnreviewed,
    icon: 'alt_route',
    lists: 'counted',
    sort: ['label'],
  },
  needsMapping: {
    bookmark: 'Needs mapping',
    fields: ['label', 'review_reason'],
    filter: unmapped,
    icon: 'alt_route',
    lists: 'counted',
    sort: ['label'],
  },
  unlinkedMembers: {
    bookmark: 'Equivalency labels without an entry',
    fields: ['generation', 'label', 'equivalency', 'equivalency.course'],
    filter: unlinkedMember,
    icon: 'join_inner',
    lists: 'counted',
    sort: ['generation', 'equivalency'],
  },
} as const satisfies Readonly<Record<string, ReviewView>>;
