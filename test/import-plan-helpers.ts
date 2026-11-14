import type { PlannedRow } from '../src/import/planned.js';
import type { WorkbookContent } from '../src/workbook.js';

import { type Finding } from '../src/import/findings.js';
import { type ImportPlan, planImport } from '../src/import/plan.js';
import { type Preflight, preflight } from '../src/import/preflight.js';
import { workbookRows } from '../src/import/workbook-rows.js';
import {
  type ModelCollectionKey,
  perWorkbookKey,
  type WorkbookData,
  type WorkbookKey,
} from '../src/schema.js';
import { workbookSpecs } from '../src/specs/workbook.js';
import {
  academicYears,
  makeSyntheticDataset,
  type SyntheticDataset,
  type SyntheticRow,
} from './fixtures/synthetic-data.js';
import {
  headerYears,
  syntheticPrograms,
} from './fixtures/synthetic-workbook.js';

// The synthetic dataset without its deliberate duplicates: one curriculum
// row per label, one equivalency label per course, one assignment and one
// pattern per course and year, and one student per index.
export const uniqueDataset = (
  base = makeSyntheticDataset(),
): SyntheticDataset => ({
  ...base,
  course_enrollment_patterns: base.course_enrollment_patterns.filter(
    (row) => row.id !== 2,
  ),
  course_equivalencies: base.course_equivalencies.filter((row) => row.id !== 2),
  curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
  curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
  students: base.students.filter((row) => row.id !== 2),
  teaching_assignments: base.teaching_assignments.filter((row) => row.id !== 2),
});

// A staff row with the title, position and email staff.json requires.
export const staffRow = (id: number, name: string): SyntheticRow => ({
  id,
  name,
  active: true,
  title: 'Prof.',
  position: 'Professor',
  email: `staff${String(id)}@staff.example`,
  cabinet: null,
  profile: null,
  courses: null,
  consultations: null,
});

// The dataset with the cells of the course's teaching rows replaced.
export const withTeaching = (
  dataset: SyntheticDataset,
  course: string,
  cells: Readonly<Record<string, null | string>>,
): SyntheticDataset => ({
  ...dataset,
  teaching_assignments: dataset.teaching_assignments.map((row) =>
    row['course_name'] === course ? { ...row, ...cells } : row,
  ),
});

export const withAssignment = (
  dataset: SyntheticDataset,
  row: SyntheticRow,
): SyntheticDataset => ({
  ...dataset,
  teaching_assignments: [...dataset.teaching_assignments, row],
});

export const withCourse = (
  dataset: SyntheticDataset,
  name: string,
  values: Readonly<Record<string, boolean | null | number | string>>,
): SyntheticDataset => ({
  ...dataset,
  courses: dataset.courses.map((course) =>
    course['name'] === name ? { ...course, ...values } : course,
  ),
});

// The columns the workbook reader reads for a part: its fields.
const readColumns = (key: WorkbookKey): ReadonlySet<string> =>
  new Set(
    workbookSpecs
      .find((spec) => spec.key === key)
      ?.fields.map(({ target }) => target),
  );

// The workbook rows of a dataset in dataset order, with the columns the
// reader reads and without their ids: the check numbers them from 1 (the
// ordinal of a row is its position here).
const dataOf = (dataset: SyntheticDataset): WorkbookData =>
  perWorkbookKey((key) => {
    const columns = readColumns(key);
    return dataset[key].map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([field]) => columns.has(field)),
      ),
    );
  });

const sheetOf = (key: WorkbookKey): string => {
  const source = workbookSpecs.find((spec) => spec.key === key)?.source;
  if (source === undefined) {
    return key;
  }
  return 'sheet' in source ? source.sheet : source.sheets.join(', ');
};

// The row a part's sheet heads its columns on.
const headerRowOf = (key: WorkbookKey): number => {
  const source = workbookSpecs.find((spec) => spec.key === key)?.source;
  return source !== undefined && 'headerRow' in source ? source.headerRow : 1;
};

// What the import reads from a workbook holding the dataset, in dataset
// order: each row placed on its part's sheet below its header row, the
// academic years of the listener sheet and the synthetic study programs.
export const contentOf = (
  dataset: SyntheticDataset,
  years: readonly string[] = academicYears,
): WorkbookContent => {
  const data = dataOf(dataset);
  return {
    academicYears: headerYears(dataset.course_enrollment_patterns, years),
    data,
    formulaPatternCells: [],
    places: perWorkbookKey((key) =>
      data[key].map((_, index) => ({
        row: headerRowOf(key) + 1 + index,
        sheet: sheetOf(key),
      })),
    ),
    studyPrograms: syntheticPrograms,
  };
};

export const planOf = (
  dataset: SyntheticDataset,
  years: readonly string[] = academicYears,
): ImportPlan => planImport(contentOf(dataset, years));

// The candidate decisions and findings of the check over a dataset.
export const checkOf = (
  dataset: SyntheticDataset,
  years: readonly string[] = academicYears,
): Preflight =>
  preflight(
    workbookRows(dataOf(dataset)),
    headerYears(dataset.course_enrollment_patterns, years),
  );

// Every finding of the plan, whatever it decides.
export const findingsOf = (plan: ImportPlan): readonly Finding[] => [
  ...plan.blockers,
  ...plan.skipped,
  ...plan.warnings,
];

export const shapes = (
  findings: readonly Finding[],
  code: Finding['code'],
): ReadonlyArray<Pick<Finding, 'collection' | 'ids'>> =>
  findings
    .filter((finding) => finding.code === code)
    .map(({ collection, ids }) => ({ collection, ids }));

export const codes = (findings: readonly Finding[]): readonly string[] =>
  findings.map(({ code }) => code);

// The planned rows of one collection.
export const rowsIn = (
  plan: ImportPlan,
  collection: ModelCollectionKey,
): readonly PlannedRow[] =>
  plan.collections.find((planned) => planned.collection === collection)?.rows ??
  [];

export const recordsIn = (plan: ImportPlan, collection: ModelCollectionKey) =>
  rowsIn(plan, collection).map(({ record }) => record);
