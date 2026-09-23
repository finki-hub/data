import type { Filter } from '@directus/types';

import type { IssueCounts, ReadinessCheck, Row, SourceRead } from './types.js';

import { publishedYear } from './key-sources.js';
import { countIn, sourceRows } from './values.js';

// The enrollment checks of courses.json: counts and rules of every
// course and published year, and the mappings and entries behind them, as
// bounded counts and native reads of ids, keys and states (never a label
// or a history).

const pairOf = (row: Row) =>
  `${String(row['course'])}/${String(row['academic_year'])}`;

// A bounded count of the rows of a collection the filter matches.
const counting = (collection: string, filter?: Filter): SourceRead => ({
  aggregate: 'count',
  collection,
  fields: ['id'],
  ...(filter !== undefined && { filter }),
  sort: [],
});

// Every course needs a count row and the rule that produces it for every
// published academic year; a pair without a rule is never counted. Both
// are four bounded counts: courses times published years, less the count
// rows and the rules of published years (one per course and year, by the
// unique keys), so no row is read.
export const enrollmentCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const expected = countIn(sources, 'courses') * countIn(sources, 'years');
    return {
      enrollment_count_missing: expected - countIn(sources, 'counts'),
      enrollment_rule_missing: expected - countIn(sources, 'rules'),
    };
  },
  reads: {
    counts: counting('course_enrollments', publishedYear('academic_year')),
    courses: counting('courses'),
    rules: counting('course_enrollment_rules', publishedYear('academic_year')),
    years: counting('academic_years', { published: { _eq: true } }),
  },
};

// Two published academic years sharing a sort have no newest-first order
// among the year keys of courses.json: the published years with a sort,
// less their distinct sorts (two bounded counts; a year without a sort is
// academic_year_unsorted).
export const yearOrderCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => ({
    academic_year_sort_shared:
      countIn(sources, 'sorted') - countIn(sources, 'sorts'),
  }),
  reads: {
    sorted: counting('academic_years', {
      _and: [{ published: { _eq: true } }, { sort: { _nnull: true } }],
    }),
    sorts: {
      aggregate: 'countDistinct',
      collection: 'academic_years',
      fields: ['sort'],
      filter: { published: { _eq: true } },
      sort: [],
    },
  },
};

// Mappings whose course and year have no rule are never counted
// (follow-up 36); entries still marked needs_mapping are listed apart from
// the ones that already carry a mapping. None of this blocks: Moodle lines
// nobody mapped include administrative ones that belong to no course.
export const mappingCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const ruled = new Set(
      sourceRows(sources, 'rules').map((rule) => pairOf(rule)),
    );
    const mappings = sourceRows(sources, 'mappings');
    const awaiting = new Set(
      sourceRows(sources, 'entries').map(({ id }) => id),
    );
    const mapped = new Set(
      mappings
        .map((mapping) => mapping['entry'])
        .filter((entry) => awaiting.has(entry)),
    );
    return {
      entry_needs_mapping: awaiting.size - mapped.size,
      mapped_entry_awaiting_review: mapped.size,
      mapping_without_rule: mappings.filter(
        (mapping) => !ruled.has(pairOf(mapping)),
      ).length,
    };
  },
  reads: {
    entries: {
      collection: 'moodle_course_entries',
      fields: ['id'],
      filter: { review_state: { _eq: 'needs_mapping' } },
      sort: ['id'],
    },
    mappings: {
      collection: 'moodle_course_mappings',
      fields: ['entry', 'course', 'academic_year'],
      sort: ['id'],
    },
    rules: {
      collection: 'course_enrollment_rules',
      fields: ['course', 'academic_year'],
      sort: ['id'],
    },
  },
};
