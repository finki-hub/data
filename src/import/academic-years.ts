import { planned, type PlannedRow } from './planned.js';

// The academic years of the workbook (newest first), published: the
// imported years are the ones courses.json carries.
export const planAcademicYears = (
  academicYears: readonly string[],
): readonly PlannedRow[] =>
  academicYears.map((label) => planned(label, { label, published: true }));
