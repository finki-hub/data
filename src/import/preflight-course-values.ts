import type { RuleCandidate } from './candidates.js';
import type { Part } from './preflight-course-links.js';
import type { CourseRow } from './workbook-rows.js';

import { type Finding, finding } from './findings.js';
import { isValidPattern, nonEmpty } from './labels.js';
import { type Indexes, patternKey } from './preflight-indexes.js';

// The rule of one course and year: the last pattern the workbook names
// for them applies, and every earlier one is skipped. A last row with an
// empty pattern supplies nothing (the row is reported as an invalid
// source row), so the rule falls back to the default.
const ruleOf = (
  name: string,
  year: string,
  indexes: Indexes,
): { readonly findings: readonly Finding[]; readonly rule: RuleCandidate } => {
  const rows = indexes.patterns.get(patternKey(name, year)) ?? [];
  const last = rows.at(-1);
  const override = nonEmpty(last?.pattern);
  const pattern = override ?? `${name}-${year}`;
  return {
    findings: rows
      .slice(0, -1)
      .map(({ id }) =>
        finding('duplicate_pattern', 'course_enrollment_patterns', [id]),
      ),
    rule: {
      academicYear: year,
      overrides: rows.map((row) => row.id),
      pattern,
      source: override === null ? 'default' : 'override',
      valid: isValidPattern(pattern),
    },
  };
};

// One enrollment rule per academic year of the workbook: the last pattern
// it names, else the unescaped `<name>-<year>` default, each compiled in
// Unicode mode as the legacy rule Flows compile it. A rule that does not
// compile could never count.
export const rulesOf = (
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
): Part<'rules'> => {
  const results = academicYears.map((year) => ruleOf(name, year, indexes));
  const findings = results.flatMap((result) => result.findings);
  if (results.some(({ rule }) => !rule.valid)) {
    findings.push(finding('invalid_regex', 'courses', [course.id]));
  }
  return { findings, value: results.map(({ rule }) => rule) };
};

// Two teaching rows of one course would publish the staff of both; the
// published file lists one course's staff once.
export const duplicateAssignment = (
  name: string,
  indexes: Indexes,
): readonly Finding[] => {
  const matches = name === '' ? [] : (indexes.assignments.get(name) ?? []);
  return matches.length > 1
    ? [finding('duplicate_assignment', 'teaching_assignments', matches)]
    : [];
};
