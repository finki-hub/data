import type { Candidates, CourseCandidate } from './candidates.js';
import type { WorkbookRows } from './workbook-rows.js';

import { type Finding, finding, sortFindings } from './findings.js';
import { courseCandidates } from './preflight-courses.js';
import { buildIndexes } from './preflight-indexes.js';
import { rowCandidates } from './preflight-rows.js';

// Curriculum rows no course resolves to: imported as entries without a
// course link, and counted among the warnings.
const unreferencedFindings = (
  rows: WorkbookRows,
  courses: readonly CourseCandidate[],
): readonly Finding[] => {
  const referenced = {
    curriculum_2018: new Set(
      courses.flatMap((course) => course.legacy.entry.matches),
    ),
    curriculum_2023: new Set(
      courses.flatMap((course) => course.current.matches),
    ),
  } as const;
  return (['curriculum_2018', 'curriculum_2023'] as const).flatMap((sheet) => {
    const ids = rows[sheet]
      .map(({ id }) => id)
      .filter((id) => !referenced[sheet].has(id));
    return ids.length === 0 ? [] : [finding('unreferenced_rows', sheet, ids)];
  });
};

export type Preflight = {
  readonly candidates: Candidates;
  readonly findings: readonly Finding[];
};

// Pure: every candidate decision and finding of the workbook rows, over
// the academic years of the workbook (newest first).
export const preflight = (
  rows: WorkbookRows,
  academicYears: readonly string[],
): Preflight => {
  const indexes = buildIndexes(rows);
  const courses = courseCandidates(rows, { academicYears, indexes });
  const linked = rowCandidates(rows, indexes, academicYears);
  return {
    candidates: { courses: courses.candidates, ...linked.candidates },
    findings: sortFindings([
      ...courses.findings,
      ...linked.findings,
      ...unreferencedFindings(rows, courses.candidates),
    ]),
  };
};
