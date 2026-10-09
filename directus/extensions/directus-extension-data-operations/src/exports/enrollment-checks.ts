import type { Filter } from '@directus/types';

import type { IssueCounts, ReadinessCheck, Row, SourceRead } from './types.js';

import { publishedThrough } from './key-sources.js';
import { countIn, sourceRows } from './values.js';

// The enrollment checks of courses.json: counts and rules of every
// course and published year, and the mappings behind them, as bounded
// counts and native reads of ids and keys (never a label or a history).

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
    counts: counting('course_enrollments', publishedThrough('academic_year')),
    courses: counting('courses'),
    rules: counting(
      'course_enrollment_rules',
      publishedThrough('academic_year'),
    ),
    years: counting('academic_years', { published: { _eq: true } }),
  },
};

// Mappings whose course and year have no rule are never counted
// (follow-up 36). Only a warning: a published pair without a rule blocks
// as enrollment_rule_missing.
export const mappingCheck: ReadinessCheck = {
  evaluate: (sources): IssueCounts => {
    const ruled = new Set(
      sourceRows(sources, 'rules').map((rule) => pairOf(rule)),
    );
    return {
      mapping_without_rule: sourceRows(sources, 'mappings').filter(
        (mapping) => !ruled.has(pairOf(mapping)),
      ).length,
    };
  },
  reads: {
    mappings: {
      collection: 'moodle_course_mappings',
      fields: ['course', 'academic_year'],
      sort: ['id'],
    },
    rules: {
      collection: 'course_enrollment_rules',
      fields: ['course', 'academic_year'],
      sort: ['id'],
    },
  },
};
