import type { PatternCandidate } from './candidates.js';
import type { Part } from './preflight-course-links.js';
import type { CourseRow } from './workbook-rows.js';

import { detailed, type Finding, finding } from './findings.js';
import { isValidPattern, nonEmpty } from './labels.js';
import { withoutLineBreaks } from './pattern-mappings.js';
import { type Indexes, patternKey } from './preflight-indexes.js';

// The typed pattern of one course and year: the last pattern the workbook
// names for them applies, and every earlier one is skipped. A last row
// with an empty pattern supplies nothing (the row is reported as an
// invalid source row), so the year has no typed pattern.
const patternOf = (
  name: string,
  year: string,
  indexes: Indexes,
): {
  readonly candidate: PatternCandidate;
  readonly findings: readonly Finding[];
  // The pattern row whose pattern applies, when one does.
  readonly row: null | number;
} => {
  const rows = indexes.patterns.get(patternKey(name, year)) ?? [];
  const last = rows.at(-1);
  const pattern = nonEmpty(last?.pattern);
  return {
    candidate: {
      academicYear: year,
      overrides: rows.map((row) => row.id),
      pattern,
      // Its pattern mapping drops the line breaks first
      // (pattern-mappings.ts), and must compile.
      valid: pattern === null || isValidPattern(withoutLineBreaks(pattern)),
    },
    findings: rows
      .slice(0, -1)
      .map(({ id }) =>
        finding('duplicate_pattern', 'course_enrollment_patterns', [id]),
      ),
    row: pattern === null ? null : (last?.id ?? null),
  };
};

// The typed pattern of every academic year of the workbook, each without
// its line breaks compiled in Unicode mode, as the matcher compiles a
// pattern mapping: a pattern that does not compile could never count.
export const patternsOf = (
  course: CourseRow,
  {
    academicYears,
    indexes,
    name,
  }: {
    readonly academicYears: readonly string[];
    readonly indexes: Indexes;
    readonly name: string;
  },
): Part<'patterns'> => {
  const results = academicYears.map((year) => patternOf(name, year, indexes));
  const findings = results.flatMap((result) => result.findings);
  const invalid = results.flatMap(({ candidate, row }) =>
    candidate.valid || row === null ? [] : [row],
  );
  if (invalid.length > 0) {
    findings.push(
      detailed(finding('invalid_regex', 'courses', [course.id]), {
        related: [{ collection: 'course_enrollment_patterns', ids: invalid }],
      }),
    );
  }
  return {
    findings,
    value: results.map(({ candidate }) => candidate),
  };
};
