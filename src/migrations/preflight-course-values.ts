import type { CourseRow } from './inventory-schemas.js';
import type { Part } from './preflight-course-links.js';
import type { CourseCandidate, Finding, RuleCandidate } from './report.js';

import { academicYears } from '../specs/public.js';
import { finding, isValidPattern, listIds, nonEmpty, quote } from './labels.js';
import { type Indexes, patternKey } from './preflight-indexes.js';
import { assignmentStaff } from './preflight-staff.js';

// `chosen` names the row whose pattern applies; a last row with an empty
// pattern supplies nothing (the derivation refuses it, and the row is
// reported as an invalid source row), so the rule falls back to the default
// with no precedent recorded.
const ruleOf = (
  name: string,
  year: string,
  indexes: Indexes,
): { readonly finding: Finding | null; readonly rule: RuleCandidate } => {
  const rows = indexes.patterns.get(patternKey(name, year)) ?? [];
  const last = rows.at(-1);
  const override = nonEmpty(last?.pattern);
  const overrides = rows.map((row) => row.id);
  const pattern = override ?? `${name}-${year}`;
  return {
    finding:
      rows.length > 1
        ? finding('duplicate_pattern', {
            collection: 'course_enrollment_patterns',
            ids: overrides,
            label: name,
            message: `${quote(name)} ${year} has pattern rows ${listIds(overrides)}; the current derivation applies the last ascending id ${String(last?.id)}. All rows are retained.`,
          })
        : null,
    rule: {
      academicYear: year,
      chosen: override === null ? null : (last?.id ?? null),
      overrides,
      pattern,
      source: override === null ? 'default' : 'override',
      valid: isValidPattern(pattern),
    },
  };
};

// One enrollment rule per academic year: the last ascending pattern override
// when one exists, else the unescaped `<name>-<year>` default, each compiled
// in Unicode mode exactly like the checkpoint derivation.
export const rulesOf = (
  course: CourseRow,
  name: string,
  indexes: Indexes,
): Part<'rules'> => {
  const results = academicYears.map((year) => ruleOf(name, year, indexes));
  const invalidYears = results
    .filter(({ rule }) => !rule.valid)
    .map(({ rule }) => rule.academicYear);
  const findings = results.flatMap(({ finding: item }) =>
    item === null ? [] : [item],
  );
  if (invalidYears.length > 0) {
    findings.push(
      finding('invalid_regex', {
        collection: 'courses',
        ids: [course.id],
        label: name,
        message: `${quote(name)} has no valid unicode regular expression for ${invalidYears.join(', ')}; the current derivation fails on this course. Add a pattern override or rename before cutover.`,
      }),
    );
  }
  return { findings, value: results.map(({ rule }) => rule) };
};

// The first ascending assignment row of the course name supplies the
// professor and assistant text the derivation displays; its staff links
// are the same candidates the row carries in `candidates.assignments`,
// where every assignment row (duplicates and orphans included) is resolved
// and reported.
export const assignmentOf = (
  name: string,
  indexes: Indexes,
): Part<'assignment'> & { readonly staff: CourseCandidate['staff'] } => {
  const matches = name === '' ? [] : (indexes.assignments.get(name) ?? []);
  const chosen = matches[0] ?? null;
  const row = chosen === null ? undefined : indexes.assignmentRows.get(chosen);
  const findings: Finding[] = [];
  if (matches.length > 1) {
    findings.push(
      finding('duplicate_assignment', {
        collection: 'teaching_assignments',
        ids: matches,
        label: name,
        message: `${quote(name)} has assignment rows ${listIds(matches)}; the current derivation copies the first ascending id ${String(chosen)}. All rows are retained.`,
      }),
    );
  }
  return {
    findings,
    staff: row === undefined ? [] : assignmentStaff(row, indexes.staff),
    value: { chosen, matches, rule: 'first_id' },
  };
};
