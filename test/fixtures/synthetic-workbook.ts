import ExcelJS from 'exceljs';

import {
  type ProgramHeaders,
  workbookPrograms,
} from '../../src/import/generations.js';
import {
  type FieldSpec,
  perWorkbookKey,
  type Scalar,
  type WorkbookData,
  type WorkbookKey,
  type WorkbookSpec,
} from '../../src/schema.js';
import { workbookSpecs } from '../../src/specs/workbook.js';
import {
  academicYears,
  makeSyntheticDataset,
  type SyntheticDataset,
  type SyntheticRow,
} from './synthetic-data.js';

// Staff rows beyond the dataset's own, which the parity files publish. No
// teaching cell of the dataset names them; the two Alpha names are the
// staff the teaching-cell refusal tests list (test/import-teaching.test.ts).
// Each has the title, position and email staff.json requires.
const labelledStaff = [
  'Prof. Zed Alpha',
  'Prof. Abe Alpha',
  'Prof. Theta',
  'Asst. Theta',
].map((name, index): SyntheticRow => ({
  id: 4 + index,
  name,
  active: true,
  title: name.startsWith('Asst.') ? 'Asst.' : 'Prof.',
  position: name.startsWith('Asst.') ? 'Assistant' : 'Professor',
  email: `${name.toLowerCase().replaceAll(/\.? /gu, '.')}@staff.example`,
  cabinet: null,
  profile: null,
  courses: null,
  consultations: null,
}));

// The synthetic dataset without the ambiguities an import refuses (a
// repeated curriculum name per generation, a second 2018 label for one
// course, a council index two students share), a student with the name the
// index sheet needs, and every other peculiarity kept: the orphan
// curriculum, equivalency, assignment and pattern rows, the 2013-only
// equivalency and the superseded pattern, which the import imports or
// skips, the second teaching row of Alpha, which the parity dataset
// (parityDataset of test/relational-export-helpers.ts) removes and the
// import ignores with a warning (the first row is used, as the committed
// files publish it), and Gamma's 2018 availability of FALSE without a
// 2018 name, which links nothing and publishes FALSE.
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

// The curriculum sheets' Ниво column, between Код and the semester as the
// real sheets lay it out. The import does not read it (the level is the
// one the code gives), so a row fills it only when a test gives the row a
// `level`.
const levelColumn: FieldSpec = {
  kind: 'integer',
  source: 'Ниво',
  sourceColumn: 5,
  target: 'level',
};

const unreadColumns: ReadonlyMap<WorkbookKey, readonly FieldSpec[]> = new Map([
  ['curriculum_2018', [levelColumn]],
  ['curriculum_2023', [levelColumn]],
]);

// The worksheet column of every source field and every unread column of
// the sheet: its fixed position, or the next column no fixed position
// takes.
const columnsOf = (
  spec: WorkbookSpec,
): ReadonlyArray<{ readonly column: number; readonly field: FieldSpec }> => {
  const fields = [...spec.fields, ...(unreadColumns.get(spec.key) ?? [])];
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

// The duration line below the program code of a curriculum header.
const durationLine = '\nтраење: 4 год.';

// A header cell of the curriculum sheets: a program column is headed as
// the real workbook heads it, the program code on the first line and its
// duration on the second; the 2018 sheet links each such header to its
// program page as rich text. ExcelJS types a hyperlink's text as a string,
// although it reads and writes rich text there, so that value is set
// through the cell's own setter.
const setHeader = (
  sheet: ExcelJS.Worksheet,
  {
    column,
    row,
    spec,
  }: {
    readonly column: number;
    readonly row: number;
    readonly spec: WorkbookSpec;
  },
  field: FieldSpec,
): void => {
  const code = field.source;
  const cell = sheet.getRow(row).getCell(column);
  if (!field.target.startsWith('state_')) {
    cell.value = code;
  } else if (spec.key === 'curriculum_2018') {
    Reflect.set(cell, 'value', {
      hyperlink: `https://curriculum.example/2018/programs/${field.target}`,
      text: { richText: [{ text: code }, { text: durationLine }] },
    });
  } else {
    cell.value = `${code}${durationLine}`;
  }
};

const text = (row: SyntheticRow, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new TypeError(`${key} must be text in the synthetic dataset`);
  }
  return value;
};

// The real curriculum sheets are laid out by semester: column A is merged
// over each semester block, its label on the block's first row. The column
// of a field read from merged ranges (`fillMerged`: catalog_order) is
// merged the same way: a row whose value is empty continues the block
// above it, and reads the block's label.
const mergeBlocks = (
  sheet: ExcelJS.Worksheet,
  {
    column,
    field,
    rows,
  }: { column: number; field: FieldSpec; rows: readonly SyntheticRow[] },
): void => {
  const starts = rows.flatMap((row, index) =>
    blanks.has(row[field.target]) ? [] : [index + 2],
  );
  for (const [index, start] of starts.entries()) {
    const end = (starts[index + 1] ?? rows.length + 2) - 1;
    if (end > start) {
      sheet.mergeCells(start, column, end, column);
    }
  }
};

// The Courses sheet carries every snapshot contract header, and the
// synthetic workbook leaves empty the four columns the newer export added
// (ID_old, Profile_old, Timezone_new, Timezone_old), so the users it
// imports are those of the older layout.
const emptyColumns: ReadonlyMap<WorkbookKey, ReadonlySet<string>> = new Map([
  [
    'moodle_users',
    new Set(['ID_old', 'Profile_old', 'Timezone_new', 'Timezone_old']),
  ],
]);

const isWritten = (key: WorkbookKey, field: FieldSpec): boolean =>
  emptyColumns.get(key)?.has(field.target) !== true;

// A sheet of rows, or of one label column per generation: row 1 heads
// each field's column, and each row of the dataset fills one row below.
const writeRows = (
  workbook: ExcelJS.Workbook,
  spec: WorkbookSpec,
  rows: readonly SyntheticRow[],
): void => {
  if (
    spec.source.kind !== 'rows' &&
    spec.source.kind !== 'generation-columns'
  ) {
    return;
  }
  const sheet = workbook.addWorksheet(spec.source.sheet);
  const headerRow =
    spec.source.kind === 'rows' ? (spec.source.headerRow ?? 1) : 1;
  // A sheet headed below row 1 carries a title above its headers and a
  // blank row between, as the real Discord sheet does.
  if (headerRow > 1) {
    setCell(sheet, { column: 1, row: 1 }, spec.source.sheet);
  }
  const columns = columnsOf(spec);
  for (const { column, field } of columns) {
    setHeader(sheet, { column, row: headerRow, spec }, field);
  }
  const written = columns.filter(({ field }) => isWritten(spec.key, field));
  for (const [index, row] of rows.entries()) {
    for (const { column, field } of written) {
      setCell(sheet, { column, row: headerRow + 1 + index }, row[field.target]);
    }
  }
  for (const { column, field } of columns) {
    if (field.fillMerged === true) {
      mergeBlocks(sheet, { column, field, rows });
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

// The year headers of the listener sheet: the given years in order (the
// fifteen synthetic years, newest first, unless a test names others), then
// any year a pattern row names that they lack.
export const headerYears = (
  rows: readonly SyntheticRow[],
  years: readonly string[] = academicYears,
): readonly string[] => [
  ...new Set([...years, ...rows.map((row) => text(row, 'academic_year'))]),
];

// The listener sheet in the export's layout: column A the course, then one
// group of three columns per year from column B, its label in row 1 merged
// over the group, the literal pattern in the group's third column, one
// pattern per row.
const writePatterns = (
  workbook: ExcelJS.Workbook,
  rows: readonly SyntheticRow[],
  years: readonly string[],
): void => {
  const sheet = workbook.addWorksheet('Слушатели');
  setCell(sheet, { column: 1, row: 1 }, 'Предмет');
  for (const [index, year] of years.entries()) {
    const label = 2 + index * 3;
    setCell(sheet, { column: label, row: 1 }, year);
    sheet.mergeCells(1, label, 1, label + 2);
  }
  for (const [index, row] of rows.entries()) {
    const year = years.indexOf(text(row, 'academic_year'));
    setCell(sheet, { column: 1, row: index + 2 }, row['course_name']);
    setCell(sheet, { column: 4 + year * 3, row: index + 2 }, row['pattern']);
  }
};

const writeSource = (
  workbook: ExcelJS.Workbook,
  spec: WorkbookSpec,
  { rows, years }: { rows: readonly SyntheticRow[]; years: readonly string[] },
): void => {
  switch (spec.source.kind) {
    case 'course-enrollment-patterns':
      writePatterns(workbook, rows, headerYears(rows, years));
      return;
    case 'generation-columns':
    case 'rows':
      writeRows(workbook, spec, rows);
      return;
    case 'student-pairs':
      writeStudents(workbook, rows);
  }
};

// An .xlsx workbook laid out the way the workbook readers expect, holding
// the source columns of every row of the dataset and a listener sheet
// headed by the given academic years.
export const syntheticWorkbook = (
  dataset: SyntheticDataset,
  years: readonly string[] = academicYears,
): ExcelJS.Workbook => {
  const workbook = new ExcelJS.Workbook();
  for (const spec of workbookSpecs) {
    writeSource(workbook, spec, { rows: dataset[spec.key], years });
  }
  return workbook;
};

type HeadedColumn = { readonly header: string; readonly sheet: string };

// The worksheet and the column a sheet heads with the given text.
const headedColumn = (
  workbook: ExcelJS.Workbook,
  { header, sheet }: HeadedColumn,
): { readonly column: number; readonly worksheet: ExcelJS.Worksheet } => {
  const worksheet = workbook.getWorksheet(sheet);
  const headers: string[] = [];
  worksheet?.getRow(1).eachCell({ includeEmpty: true }, (cell) => {
    headers.push(cell.text);
  });
  const column = headers.indexOf(header) + 1;
  if (worksheet === undefined || column === 0) {
    throw new TypeError(`${sheet}: no column headed ${header}`);
  }
  return { column, worksheet };
};

// The workbook with the column a sheet heads with the given text deleted,
// the columns after it moved left, as deleting it in the spreadsheet does.
export const withoutColumn = (
  workbook: ExcelJS.Workbook,
  headed: HeadedColumn,
): ExcelJS.Workbook => {
  const { column, worksheet } = headedColumn(workbook, headed);
  worksheet.spliceColumns(column, 1);
  return workbook;
};

// The workbook with the header cell of that column cleared and the cells
// below it kept.
export const withHeaderCleared = (
  workbook: ExcelJS.Workbook,
  headed: HeadedColumn,
): ExcelJS.Workbook => {
  const { column, worksheet } = headedColumn(workbook, headed);
  worksheet.getRow(1).getCell(column).value = null;
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
  spec: WorkbookSpec,
  rows: readonly SyntheticRow[],
  headers: readonly string[],
): readonly SyntheticRow[] => {
  if (spec.source.kind === 'course-enrollment-patterns') {
    const years = headerYears(rows, headers);
    return rows.toSorted(
      (left, right) =>
        years.indexOf(text(left, 'academic_year')) -
        years.indexOf(text(right, 'academic_year')),
    );
  }
  return rows;
};

const specOf = (key: WorkbookSpec['key']): WorkbookSpec => {
  const spec = workbookSpecs.find((candidate) => candidate.key === key);
  if (spec === undefined) {
    throw new TypeError(`No workbook spec reads ${key}`);
  }
  return spec;
};

// What a field reads on each row: its value, or, for a field read from
// merged ranges, the label of the block a row with an empty value
// continues (none before the first label).
const readValues = (
  field: FieldSpec,
  rows: readonly SyntheticRow[],
): readonly Scalar[] => {
  let label: Scalar = null;
  return rows.map((row) => {
    const value = normalized(row[field.target]);
    if (field.fillMerged !== true) {
      return value;
    }
    if (!blanks.has(row[field.target])) {
      label = value;
    }
    return label;
  });
};

// What the workbook readers return for the workbook written from the
// dataset, after a save and a reload: the read columns only, in reading
// order, blanks as null, and the label of its block on every row a merged
// block continues.
export const workbookData = (
  dataset: SyntheticDataset,
  years: readonly string[] = academicYears,
): WorkbookData =>
  perWorkbookKey((key) => {
    const spec = specOf(key);
    const rows = readingOrder(spec, dataset[key], years);
    const values = spec.fields.map(
      (field) =>
        [
          field.target,
          isWritten(key, field) ? readValues(field, rows) : [],
        ] as const,
    );
    return rows.map((_row, index) =>
      Object.fromEntries(
        values.map(([target, read]) => [target, read[index] ?? null]),
      ),
    );
  });

// The program codes each curriculum sheet heads its program columns with.
export const syntheticProgramHeaders: ProgramHeaders = {
  curriculum_2018: specOf('curriculum_2018').fields.flatMap((field) =>
    field.target.startsWith('state_') ? [field.source] : [],
  ),
  curriculum_2023: specOf('curriculum_2023').fields.flatMap((field) =>
    field.target.startsWith('state_') ? [field.source] : [],
  ),
};

// The study programs the synthetic curriculum sheets head.
export const syntheticPrograms = workbookPrograms(syntheticProgramHeaders);
