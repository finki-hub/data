import type { RuleCandidate } from './candidates.js';
import type { Part } from './preflight-course-links.js';
import type { CourseRow } from './workbook-rows.js';

import { detailed, type Finding, finding, type PartRows } from './findings.js';
import { isValidPattern, nonEmpty } from './labels.js';
import { withoutLineBreaks } from './pattern-mappings.js';
import { type Indexes, patternKey } from './preflight-indexes.js';

// The rule of one course and year: the last pattern the workbook names
// for them applies, and every earlier one is skipped. A last row with an
// empty pattern supplies nothing (the row is reported as an invalid
// source row), so the rule falls back to the default.
const ruleOf = (
  name: string,
  year: string,
  indexes: Indexes,
): {
  readonly findings: readonly Finding[];
  // The pattern row whose pattern applies, when one does.
  readonly row: null | number;
  readonly rule: RuleCandidate;
} => {
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
    row: override === null ? null : (last?.id ?? null),
    rule: {
      academicYear: year,
      overrides: rows.map((row) => row.id),
      pattern,
      source: override === null ? 'default' : 'override',
      // The rule keeps the pattern as typed; its pattern mapping drops the
      // line breaks first (pattern-mappings.ts), and both must compile.
      valid:
        isValidPattern(pattern) &&
        (override === null || isValidPattern(withoutLineBreaks(override))),
    },
  };
};

// The rows whose text makes a pattern that does not compile: each pattern
// row whose pattern applies, and the course row when its name makes the
// default pattern of a year.
const invalidSources = (
  course: CourseRow,
  results: ReadonlyArray<ReturnType<typeof ruleOf>>,
): readonly PartRows[] => {
  const invalid = results.filter(({ rule }) => !rule.valid);
  const patterns = invalid.flatMap(({ row }) => (row === null ? [] : [row]));
  const sources: PartRows[] = [];
  if (patterns.length > 0) {
    sources.push({ collection: 'course_enrollment_patterns', ids: patterns });
  }
  if (invalid.some(({ row }) => row === null)) {
    sources.push({ collection: 'courses', ids: [course.id] });
  }
  return sources;
};

// One enrollment rule per academic year of the workbook: the last pattern
// it names, else the unescaped `<name>-<year>` default, each compiled in
// Unicode mode as the legacy rule Flows compile it, and a typed pattern
// also without its line breaks, as its pattern mapping holds it. A rule or
// mapping that does not compile could never count.
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
    findings.push(
      detailed(finding('invalid_regex', 'courses', [course.id]), {
        related: invalidSources(course, results),
      }),
    );
  }
  return { findings, value: results.map(({ rule }) => rule) };
};
