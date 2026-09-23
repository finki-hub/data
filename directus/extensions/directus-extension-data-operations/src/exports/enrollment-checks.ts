import type { IssueCounts, ReadinessCheck, Row } from './types.js';

import { sourceRows } from './values.js';

// The enrollment checks of courses.json: counts and rules of every
// exported course and year, and the mappings and entries behind them, as
// native reads of ids, keys and states (never a label or a history).

const pairOf = (row: Row, year = String(row['academic_year'])) =>
  `${String(row['course'])}/${year}`;

const labelOf = (row: Row): string => {
  const year = row['academic_year'];
  return typeof year === 'object' && year !== null && 'label' in year
    ? String(year.label)
    : '';
};

// Every exported course needs a count row and the rule that produces it
// for every exported year; a pair without a rule is never counted.
export const enrollmentCheck = (years: readonly string[]): ReadinessCheck => {
  const exported = { academic_year: { label: { _in: [...years] } } };
  return {
    codes: {
      enrollment_count_missing: {
        collection: 'course_enrollments',
        kind: 'blocker',
      },
      enrollment_rule_missing: {
        collection: 'course_enrollment_rules',
        kind: 'blocker',
      },
    },
    evaluate: (sources): IssueCounts => {
      const courses = sourceRows(sources, 'courses');
      const expected = courses.length * years.length;
      const present = (key: string) =>
        new Set(
          sourceRows(sources, key).map((row) => pairOf(row, labelOf(row))),
        ).size;
      return {
        enrollment_count_missing: expected - present('counts'),
        enrollment_rule_missing: expected - present('rules'),
      };
    },
    reads: {
      counts: {
        collection: 'course_enrollments',
        fields: ['course', 'academic_year.label'],
        filter: exported,
        sort: ['id'],
      },
      courses: { collection: 'courses', fields: ['id'], sort: ['id'] },
      rules: {
        collection: 'course_enrollment_rules',
        fields: ['course', 'academic_year.label'],
        filter: exported,
        sort: ['id'],
      },
    },
  };
};

// Mappings whose course and year have no rule are never counted
// (follow-up 36); entries still marked needs_mapping are listed apart from
// the ones that already carry a mapping. None of this blocks: Moodle lines
// nobody mapped include administrative ones that belong to no course.
export const mappingCheck: ReadinessCheck = {
  codes: {
    entry_needs_mapping: {
      collection: 'moodle_course_entries',
      kind: 'warning',
    },
    mapped_entry_awaiting_review: {
      collection: 'moodle_course_entries',
      kind: 'warning',
    },
    mapping_without_rule: {
      collection: 'moodle_course_mappings',
      kind: 'warning',
    },
  },
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
