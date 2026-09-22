import type { Candidates, CourseCandidate, RuleCandidate } from './report.js';

import { academicYears } from '../specs/public.js';
import {
  Collector,
  compositeKey,
  type Conversion,
  ConverterError,
  existing,
  pending,
  unresolved,
} from './converter-types.js';
import { finding, listIds, quote } from './labels.js';

export type YearRecord = { readonly label: string; readonly sort: number };

const yearCollection = 'academic_years';

// The fifteen academic years the checkpoint counts, sorted chronologically
// (the oldest year sorts first); a label already present is reused.
export const convertAcademicYears = (
  existingYears: ReadonlyMap<string, number>,
): Conversion<YearRecord> => {
  const out = new Collector<YearRecord>();
  for (const [index, label] of academicYears.entries()) {
    const source = { collection: yearCollection, id: label, relation: 'label' };
    const id = existingYears.get(label);
    if (id === undefined) {
      out.write({ label, sort: academicYears.length - index }, [
        pending(source, yearCollection),
      ]);
    } else {
      out.settle(existing(source, yearCollection, id));
    }
  }
  return out.result();
};

// One legacy_regex rule per course and academic year: the pattern the
// checkpoint derivation compiled, recorded literally, with the row it came
// from as provenance and a note that says why.
export type RuleRecord = {
  readonly academic_year: number;
  readonly course: number;
  readonly mode: 'legacy_regex';
  readonly pattern: string;
  readonly review_note: string;
  readonly source_collection: 'course_enrollment_patterns' | 'courses';
  readonly source_id: number;
};

export const ruleKey = (course: number | string, year: string) =>
  compositeKey(course, year);

const ruleCollection = 'course_enrollment_rules';

// A rule already present for a course and year, with the mode and pattern
// it carries.
export type ExistingRule = {
  readonly id: number;
  readonly mode: null | string;
  readonly pattern: null | string;
};

export type RuleInput = {
  readonly candidates: readonly CourseCandidate[];
  readonly existing: ReadonlyMap<string, ExistingRule>;
  readonly patterns: Candidates['patterns'];
  readonly yearIds: ReadonlyMap<string, number>;
};

const provenanceOf = (
  course: CourseCandidate,
  rule: RuleCandidate,
): Pick<RuleRecord, 'review_note' | 'source_collection' | 'source_id'> => {
  if (rule.source === 'default') {
    return {
      review_note: `Migration fallback: the default pattern ${quote(rule.pattern)} is recorded literally from the course name and academic year; no course_enrollment_patterns row applied. Renaming the course no longer changes this rule.`,
      source_collection: 'courses',
      source_id: course.id,
    };
  }
  if (rule.chosen === null) {
    throw new ConverterError(
      `The override rule of course ${String(course.id)} for ${rule.academicYear} names no pattern row.`,
    );
  }
  return {
    review_note:
      rule.overrides.length > 1
        ? `Override pattern from course_enrollment_patterns row ${String(rule.chosen)}, the last ascending id of rows ${listIds(rule.overrides)} for this course and year; every row is retained.`
        : `Override pattern from course_enrollment_patterns row ${String(rule.chosen)}.`,
    source_collection: 'course_enrollment_patterns',
    source_id: rule.chosen,
  };
};

const ruleOf = (
  input: RuleInput,
  course: CourseCandidate,
  rule: RuleCandidate,
): RuleRecord => {
  const year = input.yearIds.get(rule.academicYear);
  if (year === undefined) {
    throw new ConverterError(
      `Academic year ${rule.academicYear} was not seeded before the rules that reference it.`,
    );
  }
  return {
    ...provenanceOf(course, rule),
    academic_year: year,
    course: course.id,
    mode: 'legacy_regex',
    pattern: rule.pattern,
  };
};

// Pattern rows that seed no rule stay retained and are explained: a row
// superseded by a later id for the same course and year, a row naming no
// course or several, and a row for a year no course counts.
const patternFindings = (
  out: Collector<RuleRecord>,
  input: RuleInput,
  chosen: ReadonlySet<number>,
): void => {
  const collection = 'course_enrollment_patterns';
  for (const row of input.patterns) {
    const base = { collection, ids: [row.id], label: row.course.label };
    const source = { collection, id: row.id, relation: 'course' };
    if (row.course.resolution === 'ambiguous') {
      out.find(
        finding('ambiguous_course_name', {
          ...base,
          message: `pattern row ${String(row.id)} names courses ${listIds(row.course.matches)}; it seeds no rule until the courses are told apart.`,
        }),
      );
      out.settle(unresolved(source, 'courses'));
    } else if (row.course.resolution !== 'unique') {
      out.find(
        finding('orphan_pattern', {
          ...base,
          message: `pattern row ${String(row.id)} names no existing course; it is retained with its labels and seeds no rule.`,
        }),
      );
      out.settle(unresolved(source, 'courses'));
    } else if (!row.knownYear) {
      out.find(
        finding('unknown_academic_year', {
          ...base,
          label: row.academicYear,
          message: `pattern row ${String(row.id)} names academic year ${quote(row.academicYear)}, which no course counts; it is retained and seeds no rule.`,
        }),
      );
    } else if (!chosen.has(row.id)) {
      out.find(
        finding('duplicate_pattern', {
          ...base,
          message: `pattern row ${String(row.id)} is superseded by a later row for the same course and year; it is retained and the seeded rule names the row applied.`,
        }),
      );
    }
  }
};

// A rule already present is reused; one whose mode or pattern differs from
// what the migration would freeze was edited or created by hand and is
// retained and reported, never overwritten or adopted silently.
const reuseRule = (
  out: Collector<RuleRecord>,
  course: CourseCandidate,
  { planned, present }: { planned: RuleRecord; present: ExistingRule },
): void => {
  if (present.mode !== planned.mode || present.pattern !== planned.pattern) {
    out.find(
      finding('manual_link_retained', {
        collection: ruleCollection,
        ids: [present.id],
        label: course.name,
        message: `course_enrollment_rules row ${String(present.id)} of ${quote(course.name)} already carries mode ${quote(present.mode)} and pattern ${quote(present.pattern)} while the migration would seed legacy_regex ${quote(planned.pattern)}; the rule set by hand is retained.`,
      }),
    );
  }
};

export const convertEnrollmentRules = (
  input: RuleInput,
): Conversion<RuleRecord> => {
  const out = new Collector<RuleRecord>();
  const chosen = new Set<number>();
  for (const course of input.candidates) {
    for (const rule of course.rules) {
      if (rule.chosen !== null) {
        chosen.add(rule.chosen);
      }
      const source = {
        collection: 'courses',
        id: course.id,
        relation: `rule:${rule.academicYear}`,
      };
      if (!rule.valid) {
        out.find(
          finding('invalid_regex', {
            collection: 'courses',
            ids: [course.id],
            label: course.name,
            message: `the rule of ${quote(course.name)} for ${rule.academicYear} does not compile in unicode mode; it is seeded literally and needs an override before it can count.`,
          }),
        );
      }
      const planned = ruleOf(input, course, rule);
      const present = input.existing.get(ruleKey(course.id, rule.academicYear));
      if (present === undefined) {
        out.write(planned, [pending(source, ruleCollection)]);
      } else {
        reuseRule(out, course, { planned, present });
        out.settle(existing(source, ruleCollection, present.id));
      }
    }
  }
  patternFindings(out, input, chosen);
  return out.result();
};
