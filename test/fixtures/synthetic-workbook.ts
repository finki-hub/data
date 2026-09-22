import ExcelJS from 'exceljs';

import type {
  CollectionKey,
  CollectionSpec,
  FieldSpec,
  MigrationData,
  MigrationItem,
  Scalar,
} from '../../src/schema.js';

import { collectionSpecs } from '../../src/model.js';
import {
  makeSyntheticDataset,
  type SyntheticDataset,
  type SyntheticRow,
} from './synthetic-data.js';

// Staff rows whose names are the complete labels the synthetic assignment
// texts use, so the migration links some role rows and retains others.
const labelledStaff = [
  'Prof. Zed Alpha',
  'Prof. Abe Alpha',
  'Prof. Theta',
  'Asst. Theta',
].map((name, index): SyntheticRow => ({
  id: 4 + index,
  name,
  active: true,
  title: null,
  position: null,
  email: null,
  cabinet: null,
  profile: null,
  courses: null,
  consultations: null,
}));

// The synthetic dataset as a workbook can carry it and a fresh import can
// convert it: the ambiguities that block the relational conversion (a
// repeated curriculum name per generation, a second 2018 label for one
// course, a council index two students share) are removed, a student gets
// the name the index sheet needs, and every retained peculiarity stays (the
// orphan curriculum, equivalency, assignment and pattern rows, the 2013-only
// equivalency, the superseded pattern and the duplicate assignment row).
export const lifecycleDataset = (
  base = makeSyntheticDataset(),
): SyntheticDataset => ({
  ...base,
  course_equivalencies: base.course_equivalencies.filter((row) => row.id !== 2),
  curriculum_2018: base.curriculum_2018.filter((row) => row.id !== 9),
  curriculum_2023: base.curriculum_2023.filter((row) => row.id !== 2),
  staff: [...base.staff, ...labelledStaff],
  students: base.students
    .filter((row) => row.id !== 2)
    .map((row) =>
      row['name'] === '' ? { ...row, name: 'Synthetic Student Three' } : row,
    ),
});

const studentSheets = ['Индекси - Година', 'Индекси - Други'] as const;

const sourceFields = (spec: CollectionSpec): readonly FieldSpec[] =>
  spec.fields.filter((field) => field.source !== undefined);

// The worksheet column of every source field: its fixed position, or the
// next column no fixed position takes.
const columnsOf = (
  spec: CollectionSpec,
): ReadonlyArray<{ readonly column: number; readonly field: FieldSpec }> => {
  const fields = sourceFields(spec);
  const taken = new Set(fields.flatMap((field) => field.sourceColumn ?? []));
  let next = 1;
  return fields.map((field) => {
    if (field.sourceColumn !== undefined) {
      return { column: field.sourceColumn, field };
    }
    while (taken.has(next)) {
      next += 1;
    }
    taken.add(next);
    return { column: next, field };
  });
};

const blanks: ReadonlySet<Scalar | undefined> = new Set(['', null, undefined]);

const setCell = (
  sheet: ExcelJS.Worksheet,
  position: { readonly column: number; readonly row: number },
  value: Scalar | undefined,
): void => {
  if (blanks.has(value)) {
    return;
  }
  sheet.getRow(position.row).getCell(position.column).value = value;
};

const text = (row: SyntheticRow, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new TypeError(`${key} must be text in the synthetic dataset`);
  }
  return value;
};

const writeRows = (
  workbook: ExcelJS.Workbook,
  spec: CollectionSpec,
  rows: readonly SyntheticRow[],
): void => {
  if (spec.source.kind !== 'rows') {
    return;
  }
  const sheet = workbook.addWorksheet(spec.source.sheet);
  const columns = columnsOf(spec);
  for (const { column, field } of columns) {
    setCell(sheet, { column, row: 1 }, field.source ?? field.target);
  }
  for (const [index, row] of rows.entries()) {
    for (const { column, field } of columns) {
      setCell(sheet, { column, row: index + 2 }, row[field.target]);
    }
  }
};

// Consecutive runs of rows sharing a key, in dataset order.
const runsBy = (
  rows: readonly SyntheticRow[],
  key: (row: SyntheticRow) => string,
): ReadonlyArray<readonly [string, readonly SyntheticRow[]]> => {
  const runs: Array<[string, SyntheticRow[]]> = [];
  for (const row of rows) {
    const last = runs.at(-1);
    if (last?.[0] === key(row)) {
      last[1].push(row);
    } else {
      runs.push([key(row), [row]]);
    }
  }
  return runs;
};

// The first student group on the year sheet, every other one in its own
// column pair of the second sheet: row 1 names the group, rows from 3 hold
// index and name.
const writeStudents = (
  workbook: ExcelJS.Workbook,
  rows: readonly SyntheticRow[],
): void => {
  const sheets = studentSheets.map((name) => workbook.addWorksheet(name));
  const groups = runsBy(rows, (row) => text(row, 'source_group')).entries();
  for (const [index, [group, members]] of groups) {
    const sheet = sheets[Math.min(index, 1)];
    if (sheet === undefined) {
      throw new TypeError('no student sheet');
    }
    const column = index === 0 ? 1 : 2 * index - 1;
    setCell(sheet, { column, row: 1 }, group);
    setCell(sheet, { column, row: 2 }, 'Индекс');
    setCell(sheet, { column: column + 1, row: 2 }, 'Име');
    for (const [offset, row] of members.entries()) {
      setCell(sheet, { column, row: 3 + offset }, row['index_number']);
      setCell(sheet, { column: column + 1, row: 3 + offset }, row['name']);
    }
  }
};

const semesterOf = (row: SyntheticRow): number => {
  const value = row['semester'];
  if (typeof value !== 'number') {
    throw new TypeError('semester must be a number in the synthetic dataset');
  }
  return value;
};

// One channel/course-names column pair per semester, rows 2 to 29. The
// readers walk `actualColumnCount` (populated columns), so row 1 labels
// every column up to the last semester, as the real sheet does.
const writeDiscord = (
  workbook: ExcelJS.Workbook,
  rows: readonly SyntheticRow[],
): void => {
  const sheet = workbook.addWorksheet('Дискорд');
  const last = Math.max(0, ...rows.map((row) => semesterOf(row)));
  for (let semester = 1; semester <= last; semester += 1) {
    setCell(
      sheet,
      { column: 2 * semester - 1, row: 1 },
      `Семестар ${String(semester)}`,
    );
    setCell(sheet, { column: 2 * semester, row: 1 }, 'Предмети');
  }
  const used = new Map<number, number>();
  for (const row of rows) {
    const semester = semesterOf(row);
    const line = 2 + (used.get(semester) ?? 0);
    used.set(semester, line - 1);
    setCell(sheet, { column: 2 * semester - 1, row: line }, row['channel']);
    setCell(sheet, { column: 2 * semester, row: line }, row['course_names']);
  }
};

const yearsOf = (rows: readonly SyntheticRow[]): readonly string[] => [
  ...new Set(rows.map((row) => text(row, 'academic_year'))),
];

// The listener sheet: year labels in row 1 every third column from C, the
// literal pattern two columns right of its year, one pattern per row. Row 1
// labels every column, so `actualColumnCount` reaches the last pattern.
const writePatterns = (
  workbook: ExcelJS.Workbook,
  rows: readonly SyntheticRow[],
): void => {
  const sheet = workbook.addWorksheet('Слушатели');
  const years = yearsOf(rows);
  setCell(sheet, { column: 1, row: 1 }, 'Предмет');
  setCell(sheet, { column: 2, row: 1 }, 'Код');
  for (const [index, year] of years.entries()) {
    setCell(sheet, { column: 3 + index * 3, row: 1 }, year);
    setCell(sheet, { column: 4 + index * 3, row: 1 }, 'Број');
    setCell(sheet, { column: 5 + index * 3, row: 1 }, 'Регекс');
  }
  for (const [index, row] of rows.entries()) {
    const year = years.indexOf(text(row, 'academic_year'));
    setCell(sheet, { column: 1, row: index + 2 }, row['course_name']);
    setCell(sheet, { column: 5 + year * 3, row: index + 2 }, row['pattern']);
  }
};

const writeSource = (
  workbook: ExcelJS.Workbook,
  spec: CollectionSpec,
  rows: readonly SyntheticRow[],
): void => {
  switch (spec.source.kind) {
    case 'course-enrollment-patterns':
      writePatterns(workbook, rows);
      return;
    case 'discord-pairs':
      writeDiscord(workbook, rows);
      return;
    case 'rows':
      writeRows(workbook, spec, rows);
      return;
    case 'student-pairs':
      writeStudents(workbook, rows);
  }
};

// An .xlsx workbook laid out the way the checkpoint readers expect, holding
// the source columns of every row of the dataset (never a derived value).
export const syntheticWorkbook = (
  dataset: SyntheticDataset,
): ExcelJS.Workbook => {
  const workbook = new ExcelJS.Workbook();
  for (const spec of collectionSpecs) {
    writeSource(workbook, spec, dataset[spec.key]);
  }
  return workbook;
};

// The workbook after a save and a reload, as a file on disk would read.
export const reloaded = async (
  workbook: ExcelJS.Workbook,
): Promise<ExcelJS.Workbook> => {
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
  return loaded;
};

// A blank cell reads as null, and an .xlsx cell keeps no carriage return:
// a CRLF line break reads back as LF.
const normalized = (value: Scalar | undefined): Scalar => {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim() === '' ? null : value.replaceAll('\r\n', '\n');
};

const readingOrder = (
  spec: CollectionSpec,
  rows: readonly SyntheticRow[],
): readonly SyntheticRow[] => {
  if (spec.source.kind === 'discord-pairs') {
    return rows.toSorted((left, right) => semesterOf(left) - semesterOf(right));
  }
  if (spec.source.kind === 'course-enrollment-patterns') {
    const years = yearsOf(rows);
    return rows.toSorted(
      (left, right) =>
        years.indexOf(text(left, 'academic_year')) -
        years.indexOf(text(right, 'academic_year')),
    );
  }
  return rows;
};

// What the checkpoint readers return for the workbook written from the
// dataset: the source columns only, in reading order, blanks as null.
export const workbookData = (dataset: SyntheticDataset): MigrationData => {
  const data: Record<CollectionKey, readonly MigrationItem[]> = {
    course_enrollment_patterns: [],
    course_equivalencies: [],
    courses: [],
    curriculum_2018: [],
    curriculum_2023: [],
    deans_office: [],
    discord_channels: [],
    moodle_users: [],
    rooms: [],
    staff: [],
    student_council: [],
    students: [],
    teaching_assignments: [],
  };
  for (const spec of collectionSpecs) {
    data[spec.key] = readingOrder(spec, dataset[spec.key]).map((row) =>
      Object.fromEntries(
        sourceFields(spec).map((field) => [
          field.target,
          normalized(row[field.target]),
        ]),
      ),
    );
  }
  return data;
};

// The rows of parsed workbook data with the ids a fresh table hands out
// (1, 2, ...), as a populated checkpoint deployment holds them.
export const withSequentialIds = (data: MigrationData): SyntheticDataset => {
  const dataset: Record<CollectionKey, readonly SyntheticRow[]> = {
    course_enrollment_patterns: [],
    course_equivalencies: [],
    courses: [],
    curriculum_2018: [],
    curriculum_2023: [],
    deans_office: [],
    discord_channels: [],
    moodle_users: [],
    rooms: [],
    staff: [],
    student_council: [],
    students: [],
    teaching_assignments: [],
  };
  for (const spec of collectionSpecs) {
    dataset[spec.key] = data[spec.key].map((item, index) => ({
      ...item,
      id: index + 1,
    }));
  }
  return dataset;
};
