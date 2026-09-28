import type { Candidates } from './candidates.js';
import type { Indexes } from './preflight-indexes.js';
import type { WorkbookRows } from './workbook-rows.js';

import { type Finding, finding } from './findings.js';
import { type LinkCandidate, nonEmpty, resolveLabel } from './labels.js';
import { duplicateRows } from './preflight-duplicates.js';
import { courseLink, linkedRows } from './preflight-links.js';

export type RowCandidates = Omit<Candidates, 'courses'>;

// A pattern row without a course, year or pattern cannot become a rule; a
// row naming no course, or else a year the workbook does not list, is
// skipped (a row of a known course and year is decided with its course,
// preflight-course-values.ts).
const patternFindings = (
  rows: WorkbookRows,
  indexes: Indexes,
  knownYears: ReadonlySet<string>,
): readonly Finding[] =>
  rows.course_enrollment_patterns.flatMap((row) => {
    const collection = 'course_enrollment_patterns';
    const year = nonEmpty(row.academic_year);
    const invalid =
      nonEmpty(row.course_name) === null ||
      year === null ||
      nonEmpty(row.pattern) === null
        ? [finding('invalid_source_row', collection, [row.id])]
        : [];
    const course = courseLink(
      { collection, id: row.id, label: nonEmpty(row.course_name) },
      { indexes, orphan: 'orphan_pattern' },
    );
    const unknownYear =
      course.link.resolution === 'unique' &&
      year !== null &&
      !knownYears.has(year)
        ? [finding('unknown_academic_year', collection, [row.id])]
        : [];
    return [...invalid, ...course.findings, ...unknownYear];
  });

// A council row without an index has no label; an index several students
// carry names none of them; an index no student carries leaves the member
// unlinked, labelled by the index.
const councilFinding = (
  id: number,
  indexNumber: null | string,
  student: LinkCandidate,
): Finding | null => {
  if (indexNumber === null) {
    return finding('invalid_source_row', 'student_council', [id]);
  }
  if (student.resolution === 'ambiguous') {
    return finding('ambiguous_student_index', 'student_council', [id]);
  }
  return student.resolution === 'missing'
    ? finding('unmatched_council_index', 'student_council', [id])
    : null;
};

const council = (
  rows: WorkbookRows,
  indexes: Indexes,
): {
  readonly candidates: Candidates['council'];
  readonly findings: readonly Finding[];
} => {
  const results = rows.student_council.map((row) => {
    const indexNumber = nonEmpty(row.index_number);
    const student = resolveLabel(indexNumber, indexes.students);
    const item = councilFinding(row.id, indexNumber, student);
    return {
      candidate: { id: row.id, student },
      findings: item === null ? [] : [item],
    };
  });
  return {
    candidates: results.map(({ candidate }) => candidate),
    findings: results.flatMap(({ findings }) => findings),
  };
};

// Row-level candidates and findings for every workbook row that links to
// another by label, plus the duplicate rows the model must not guess
// about.
export const rowCandidates = (
  rows: WorkbookRows,
  indexes: Indexes,
  academicYears: readonly string[],
): {
  readonly candidates: RowCandidates;
  readonly findings: readonly Finding[];
} => {
  const assignments = linkedRows.assignments(rows, indexes);
  const members = council(rows, indexes);
  const equivalencies = linkedRows.equivalencies(rows, indexes);
  return {
    candidates: {
      assignments: assignments.candidates,
      council: members.candidates,
      equivalencies: equivalencies.candidates,
    },
    findings: [
      ...assignments.findings,
      ...members.findings,
      ...equivalencies.findings,
      ...patternFindings(rows, indexes, new Set(academicYears)),
      ...duplicateRows(rows),
    ],
  };
};
