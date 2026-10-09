import type { CourseCandidate } from './candidates.js';
import type { CourseRow } from './workbook-rows.js';

import {
  defaultPattern,
  defaultYearPattern,
} from '../../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { splitHistoryEntries } from '../../directus/extensions/directus-extension-data-operations/src/history-contract.js';
import { detailed, type Finding, finding } from './findings.js';
import { nonEmpty } from './labels.js';
import { type Conversion, mergeCourse } from './pattern-merge.js';
import {
  type ConvertedCourse,
  designLines,
  type LineSets,
  lineSets,
  type PatternCourse,
  provePatternMappings,
  type TypedCell,
} from './pattern-proof.js';
import {
  compositeKey,
  planned,
  type PlannedRecord,
  type PlannedRow,
  ref,
} from './planned.js';

// The pattern mappings the one-time import writes (plan step 13): every
// course's standard all-years mapping, and the typed Слушатели cells,
// skipped where they count what the standard mapping counts, converted
// into all-years mappings where every year keeps its lines, and kept as
// only-in-year mappings otherwise. The proof runs before anything is
// written.

// A typed cell without its line breaks: a pasted CR or LF is no part of
// the pattern (the rule fix pattern_line_break).
export const withoutLineBreaks = (pattern: string): string =>
  pattern.replaceAll(/[\r\n]/gu, '');

// The distinct history lines of the planned Moodle users, in the order
// they first occur.
const historyLines = (users: readonly PlannedRow[]): readonly string[] => [
  ...new Set(
    users.flatMap(({ record }) => {
      const history = record['Courses'];
      return splitHistoryEntries(typeof history === 'string' ? history : null);
    }),
  ),
];

// A course's typed cells: the pattern that applies to each year it names
// (the last of its rows), line breaks removed. A cell that is no Unicode
// regular expression without them blocks the import (invalid_regex) and
// takes no part.
const patternCourse = (
  candidate: CourseCandidate,
  row: CourseRow | undefined,
): PatternCourse => ({
  cells: new Map(
    candidate.rules.flatMap((rule) =>
      rule.source === 'override' && rule.valid
        ? [
            [
              rule.academicYear,
              {
                academicYear: rule.academicYear,
                pattern: withoutLineBreaks(rule.pattern),
                row: rule.overrides.at(-1) ?? 0,
              },
            ],
          ]
        : [],
    ),
  ),
  id: candidate.id,
  name: nonEmpty(row?.name) ?? '',
});

const lineBreakFindings = (candidate: CourseCandidate): readonly Finding[] =>
  candidate.rules.flatMap((rule) =>
    rule.source === 'override' &&
    rule.valid &&
    withoutLineBreaks(rule.pattern) !== rule.pattern
      ? [
          detailed(
            finding('pattern_line_break', 'course_enrollment_patterns', [
              rule.overrides.at(-1) ?? 0,
            ]),
            { academicYear: rule.academicYear },
          ),
        ]
      : [],
  );

const sameLines = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length &&
  left.every((line, index) => line === right[index]);

// A cell is skipped when it matches exactly the lines the course's
// `<escaped name>-` counts in its year under the default year pattern;
// every other cell is kept.
const splitCells = (sets: LineSets, course: PatternCourse) => {
  const standard = { ...course, cells: new Map<string, TypedCell>() };
  return Map.groupBy(course.cells.values(), (cell) =>
    sameLines(
      sets.matched(cell.pattern),
      designLines(sets, standard, cell.academicYear),
    )
      ? 'skipped'
      : 'kept',
  );
};

const cellFindings = (
  code: 'merged_pattern' | 'redundant_pattern',
  cells: Iterable<TypedCell>,
): readonly Finding[] =>
  [...cells].map(({ row }) =>
    finding(code, 'course_enrollment_patterns', [row]),
  );

// The planned rows of one course's mappings: its all-years mappings, each
// with a year pattern and no year, then its only-in-year mappings, each
// with a year and no year pattern, placed by their cell.
const plannedRows = ({ course, mappings }: ConvertedCourse): PlannedRow[] => {
  const rows: Array<{ origin: PlannedRow['origin']; record: PlannedRecord }> = [
    ...mappings.allYears.entries().map(([yearPattern, alternatives]) => ({
      origin: { id: course.id, source: 'courses' as const },
      record: {
        course: ref('courses', course.id),
        only_in_year: null,
        pattern: alternatives.join('|'),
        year_pattern: yearPattern,
      },
    })),
    ...mappings.onlyInYear.entries().map(([year, pattern]) => ({
      origin: {
        id: course.cells.get(year)?.row ?? 0,
        source: 'course_enrollment_patterns' as const,
      },
      record: {
        course: ref('courses', course.id),
        only_in_year: ref('academic_years', year),
        pattern,
        year_pattern: null,
      },
    })),
  ];
  return rows.map(({ origin, record }, index) =>
    planned(compositeKey(course.id, index + 1), record, origin),
  );
};

export type PatternPlan = {
  readonly conversions: readonly Conversion[];
  readonly findings: readonly Finding[];
  readonly rows: readonly PlannedRow[];
};

// Pure: the moodle_pattern_mappings rows of the workbook, over its
// academic years (newest first) and the history lines of its Moodle
// users, with the skipped and merged cells, the line-break rule fixes and
// the newest years the conversion widens (decision B).
export const planPatternMappings = ({
  academicYears,
  candidates,
  courses,
  users,
}: {
  readonly academicYears: readonly string[];
  readonly candidates: readonly CourseCandidate[];
  readonly courses: readonly CourseRow[];
  readonly users: readonly PlannedRow[];
}): PatternPlan => {
  const sets = lineSets(historyLines(users), academicYears);
  const findings: Finding[] = [];
  const conversions: Conversion[] = [];
  const converted = candidates.map((candidate): ConvertedCourse => {
    const course = patternCourse(candidate, courses[candidate.id - 1]);
    const split = splitCells(sets, course);
    const kept = split.get('kept') ?? [];
    const merged = mergeCourse(sets, course, {
      kept,
      standard: {
        allYears: new Map([
          [defaultYearPattern, [defaultPattern(course.name)]],
        ]),
        onlyInYear: new Map(
          kept.map((cell) => [cell.academicYear, cell.pattern]),
        ),
      },
    });
    conversions.push(...merged.conversions);
    findings.push(
      ...lineBreakFindings(candidate),
      ...cellFindings('redundant_pattern', split.get('skipped') ?? []),
      ...cellFindings(
        'merged_pattern',
        merged.conversions.flatMap(({ cells }) => cells),
      ),
    );
    return { course, mappings: merged.mappings };
  });
  for (const { course, year } of provePatternMappings(sets, converted)) {
    const row = course.cells.values().next().value?.row ?? 0;
    findings.push(
      detailed(
        finding('newest_year_widened', 'course_enrollment_patterns', [row]),
        { academicYear: year },
      ),
    );
  }
  return { conversions, findings, rows: converted.flatMap(plannedRows) };
};
