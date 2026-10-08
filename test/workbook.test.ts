import ExcelJS from 'exceljs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  snapshotFields,
  snapshotFieldTable,
} from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import { refusalLines } from '../src/import-report.js';
import { countByCode } from '../src/import/findings.js';
import { planImport } from '../src/import/plan.js';
import {
  field,
  literalField,
  requiredField,
  workbookKeys,
  type WorkbookSpec,
} from '../src/schema.js';
import { workbookSpecs } from '../src/specs/workbook.js';
import {
  readCourseEnrollmentPatterns,
  readEnrollmentYears,
  readFormulaPatternCells,
} from '../src/workbook-enrollment-reader.js';
import { readRows } from '../src/workbook-row-reader.js';
import {
  readCellText,
  readFirstLine,
  WorkbookDataError,
} from '../src/workbook-values.js';
import { loadWorkbook, readWorkbookContent } from '../src/workbook.js';
import {
  academicYears,
  courseNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  reloaded,
  syntheticWorkbook,
  workbookData,
} from './fixtures/synthetic-workbook.js';
import { contentOf, planOf, withCourse } from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

const courseOne = 'Course One';
const courseTwo = 'Course Two';

// The workbook written from the dataset, saved and reloaded, as the import
// reads it from a file.
const readBack = async (
  dataset: SyntheticDataset,
  years: readonly string[] = academicYears,
) => readWorkbookContent(await reloaded(syntheticWorkbook(dataset, years)));

const specOf = (key: WorkbookSpec['key']) =>
  workbookSpecs.find((spec) => spec.key === key);

// Every field read from merged ranges (`fillMerged`): its part of the
// workbook, target, header and fixed column.
const fillMergedFields = (specs: readonly WorkbookSpec[]) =>
  specs.flatMap(({ fields, key }) =>
    fields.flatMap(({ fillMerged, source, sourceColumn, target }) =>
      fillMerged === true ? [[key, target, source, sourceColumn]] : [],
    ),
  );

describe('workbook readers', () => {
  test('imports literal source cells without copying cached formula results, with the row of each', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic courses');
    sheet.addRow(['name', 'professors']);
    sheet.addRow([
      courseOne,
      { formula: '"Derived Professor"', result: 'Derived Professor' },
    ]);
    sheet.addRow([courseTwo, 'Manual Professor']);
    const spec = {
      fields: [
        requiredField('name', 'name'),
        literalField('professors', 'professors_override', 'text'),
      ],
      key: 'courses',
      source: { kind: 'rows', sheet: 'Synthetic courses' },
    } as const satisfies WorkbookSpec;

    expect(readRows(workbook, spec, spec.source)).toEqual([
      {
        item: { name: courseOne, professors_override: null },
        place: { row: 2, sheet: 'Synthetic courses' },
      },
      {
        item: { name: courseTwo, professors_override: 'Manual Professor' },
        place: { row: 3, sheet: 'Synthetic courses' },
      },
    ]);
  });

  test('normalizes only literal listener pattern overrides, and places a formula pattern cell without reading it', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic listeners');
    const source = {
      kind: 'course-enrollment-patterns',
      sheet: 'Synthetic listeners',
    } as const;
    sheet.addRow(['', '2025/2026', '', '']);
    sheet.addRow([courseOne, '', '', 'Course One-2025/2026|Legacy']);
    sheet.addRow([courseTwo, '', '', '']);
    sheet.getRow(3).getCell(4).value = {
      formula: '$A3&"-"&B$1',
      result: 'Course Two-2025/2026',
    };

    expect(readFormulaPatternCells(workbook, source)).toEqual([
      { column: '2025/2026', row: 3, sheet: 'Synthetic listeners' },
    ]);
    expect(readCourseEnrollmentPatterns(workbook, source)).toEqual([
      {
        item: {
          academic_year: '2025/2026',
          course_name: courseOne,
          pattern: 'Course One-2025/2026|Legacy',
        },
        place: { row: 2, sheet: 'Synthetic listeners' },
      },
    ]);
  });

  test('reads plain, rich and linked rich text, and the first line of a program header', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic headers');
    const plain = sheet.getRow(1).getCell(1);
    const rich = sheet.getRow(1).getCell(2);
    const linked = sheet.getRow(1).getCell(3);
    plain.value = 'КН\nтраење: 4 год.';
    rich.value = { richText: [{ text: 'ПИТ' }, { text: '\nтраење: 3 год.' }] };
    // ExcelJS types a hyperlink's text as a string; the curriculum sheets
    // hold rich text there.
    Reflect.set(linked, 'value', {
      hyperlink: 'https://curriculum.example/programs/ki',
      text: { richText: [{ text: 'КИ' }, { text: '\nтраење: 4 год.' }] },
    });

    // ExcelJS answers the rich text object as the text of such a cell.
    expect(linked.text).not.toBeTypeOf('string');
    expect([plain, rich, linked].map(readCellText)).toEqual([
      'КН\nтраење: 4 год.',
      'ПИТ\nтраење: 3 год.',
      'КИ\nтраење: 4 год.',
    ]);
    expect([plain, rich, linked].map(readFirstLine)).toEqual([
      'КН',
      'ПИТ',
      'КИ',
    ]);
  });

  test('models the longest staff profile URL without truncation', () => {
    const profile = specOf('staff')?.fields.find(
      ({ target }) => target === 'profile',
    );

    expect(profile?.kind).toBe('text');
  });

  test('does not read formula-only preview sheets', () => {
    const sourceSheets = workbookSpecs.flatMap(({ source }) =>
      source.kind === 'rows' ? [source.sheet] : [],
    );

    expect(sourceSheets).not.toContain('Пребарување');
    expect(sourceSheets).not.toContain('Индекси');
  });

  test('reads the professors override literally, and no calculated column', () => {
    const courses = specOf('courses');

    expect(
      courses?.fields.find(({ target }) => target === 'professors_override'),
    ).toMatchObject({ sourceMode: 'literal' });
    expect(courses?.fields.map(({ target }) => target)).not.toContain(
      'professors',
    );
    expect(
      specOf('student_council')?.fields.map(({ target }) => target),
    ).toEqual(['year', 'index_number', 'position']);
  });

  test('reads merged ranges as their top-left cell in the semester column A of the two curriculum sheets only', () => {
    expect(fillMergedFields(workbookSpecs)).toEqual([
      ['curriculum_2023', 'catalog_order', 'Семестар', 1],
      ['curriculum_2018', 'catalog_order', 'Семестар', 1],
    ]);
  });

  test('reads every snapshot contract field of the Courses sheet under its own header, with its kind, the instance ids as ids', () => {
    const fields = specOf('moodle_users')?.fields ?? [];

    expect(fields.map(({ source, target }) => [source, target])).toEqual(
      snapshotFields.map((name) => [name, name]),
    );
    expect(fields.map(({ kind }) => kind)).toEqual(
      snapshotFieldTable.map(({ field: name, kind }) =>
        name === 'ID_old' || name === 'ID_new' ? 'id' : kind,
      ),
    );
  });
});

describe('cells a merged range covers', () => {
  test('read as the top-left cell of their range for a field declared fillMerged only, and fill no unmerged blank', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic blocks');
    sheet.addRow(['block', 'name', 'group', 'note']);
    sheet.addRow([1, 'Subject One', 'Group One', 'Note One']);
    sheet.addRow([null, 'Subject Two', null, null]);
    sheet.addRow([null, 'Subject Three', null, 'Note Three']);
    sheet.addRow([null, 'Subject Four']);
    sheet.addRow([2, 'Subject Five']);
    sheet.mergeCells('A2:A4');
    sheet.mergeCells('C2:C3');
    const spec = {
      fields: [
        { ...field('block', 'block', 'integer'), fillMerged: true },
        requiredField('name', 'name'),
        field('group', 'group'),
        field('note', 'note'),
      ],
      key: 'curriculum_2023',
      source: { kind: 'rows', sheet: 'Synthetic blocks' },
    } as const satisfies WorkbookSpec;

    // The block label fills its merged range only (row 5 is no part of it);
    // the merged group range without the option reads as before, its label
    // on the first row only; an unmerged blank stays empty.
    expect(
      readRows(await reloaded(workbook), spec, spec.source).map(
        ({ item }) => item,
      ),
    ).toEqual([
      { block: 1, group: 'Group One', name: 'Subject One', note: 'Note One' },
      { block: 1, group: null, name: 'Subject Two', note: null },
      { block: 1, group: null, name: 'Subject Three', note: 'Note Three' },
      { block: null, group: null, name: 'Subject Four', note: null },
      { block: 2, group: null, name: 'Subject Five', note: null },
    ]);
  });
});

describe('generated synthetic workbook', () => {
  test('reads back as the source rows it was written from, each with its sheet and row', async () => {
    const workbook = await reloaded(syntheticWorkbook(lifecycleDataset()));
    const content = readWorkbookContent(workbook);
    const { data } = content;

    expect(data).toEqual(workbookData(lifecycleDataset()));
    expect(data.students.map(({ source_group }) => source_group)).toEqual([
      'SENTINEL_PRIVATE_SOURCE_GROUP:year-list',
      'SENTINEL_PRIVATE_SOURCE_GROUP:year-list',
      'SENTINEL_PRIVATE_SOURCE_GROUP:other-list',
    ]);
    expect(data.course_enrollment_patterns).toHaveLength(4);
    expect(data.discord_channels.map(({ semester }) => semester)).toEqual([
      1, 6,
    ]);
    expect(content.places.courses[0]).toEqual({
      row: 2,
      sheet: 'Предмети (Export)',
    });
    expect(content.places.students.map(({ sheet }) => sheet)).toEqual([
      'Индекси - Година',
      'Индекси - Година',
      'Индекси - Други',
    ]);

    for (const key of workbookKeys) {
      expect(content.places[key]).toHaveLength(data[key].length);
    }
  });

  test('reads the label of a merged semester block on every row of the block, and every other column as the row holds it', async () => {
    const base = lifecycleDataset();
    // The first three 2023 rows are one semester block, labelled on its
    // first row; the two rows it continues leave their level empty too.
    // The third to fifth 2018 rows are one block of the 2018 sheet.
    const dataset = {
      ...base,
      curriculum_2018: base.curriculum_2018.map((row, index) =>
        index === 3 || index === 4 ? { ...row, catalog_order: null } : row,
      ),
      curriculum_2023: base.curriculum_2023.map((row, index) =>
        index === 1 || index === 2
          ? { ...row, catalog_order: null, level: null }
          : row,
      ),
    };
    const workbook = await reloaded(syntheticWorkbook(dataset));
    const { data } = readWorkbookContent(workbook);

    expect(workbook.getWorksheet('Предмети - 2023')?.model.merges).toEqual([
      'A2:A4',
    ]);
    expect(workbook.getWorksheet('Предмети - 2018')?.model.merges).toEqual([
      'A4:A6',
    ]);
    expect(data.curriculum_2023.map((row) => row['catalog_order'])).toEqual([
      1, 1, 1, 5, 6, 7, 8, 9, 10,
    ]);
    expect(data.curriculum_2018.map((row) => row['catalog_order'])).toEqual([
      1, 2, 3, 3, 3, 6, 7, 8, 10,
    ]);
    expect(data.curriculum_2023.map((row) => row['level'])).toEqual([
      1,
      null,
      null,
      1,
      3,
      null,
      2,
      1,
      1,
    ]);
    expect(data).toEqual(workbookData(dataset));
  });

  test('heads its program columns as the real workbook does: two lines, linked rich text in the 2018 sheet', async () => {
    const workbook = await reloaded(syntheticWorkbook(lifecycleDataset()));
    const current = workbook.getWorksheet('Предмети - 2023')?.getRow(1);
    const legacy = workbook.getWorksheet('Предмети - 2018')?.getRow(1);

    expect(current?.getCell(8).value).toBe('КН\nтраење: 4 год.');
    expect(legacy?.getCell(8).value).toMatchObject({
      hyperlink: 'https://curriculum.example/2018/programs/state_kn',
      text: { richText: [{ text: 'КН' }, { text: '\nтраење: 4 год.' }] },
    });
  });

  test('names an unreadable workbook file instead of failing inside the parser', async () => {
    const missing = path.join(
      os.tmpdir(),
      'finki-hub-missing-synthetic-workbook.xlsx',
    );

    await expect(loadWorkbook(missing)).rejects.toThrow(
      `workbook ${missing}: not readable as .xlsx (File not found)`,
    );
  });
});

describe('the up-front check of a workbook file', () => {
  test('plans the parity workbook without a blocking case, as it plans the dataset', async () => {
    const read = planImport(await readBack(parityDataset()));
    const planned = planOf(parityDataset());

    expect(read.blockers).toEqual([]);
    expect(countByCode(read.skipped)).toEqual(countByCode(planned.skipped));
    expect(countByCode(read.warnings)).toEqual(countByCode(planned.warnings));
    expect(
      read.collections.map(({ collection, rows }) => [collection, rows.length]),
    ).toEqual(
      planned.collections.map(({ collection, rows }) => [
        collection,
        rows.length,
      ]),
    );
  });

  test('plans the lifecycle workbook without a blocking case, ignoring its second teaching row of a course with a warning, and skips what nothing published', async () => {
    const plan = planImport(await readBack(lifecycleDataset()));

    expect(countByCode(plan.blockers)).toEqual({});
    expect(countByCode(plan.warnings)).toMatchObject({
      duplicate_assignment: 1,
    });
    expect(countByCode(plan.skipped)).toEqual({
      duplicate_pattern: 1,
      orphan_assignment: 1,
      orphan_pattern: 1,
    });
  });
});

// The values of a dataset no column can hold, as the import records them
// and as it lists them on stderr before the lines of the blocking cases.
const unstorableOf = (dataset: SyntheticDataset) => {
  const content = contentOf(dataset);
  const plan = planImport(content);
  return {
    lines: refusalLines(plan, content),
    values: plan.unstorable,
  };
};

// The parity dataset with the second staff row's values replaced.
const withStaffValues = (values: Readonly<Record<string, string>>) => {
  const base = parityDataset();
  return {
    ...base,
    staff: base.staff.map((row, index) =>
      index === 1 ? { ...row, ...values } : row,
    ),
  };
};

describe('values the relational columns cannot hold', () => {
  const base = parityDataset();

  test('refuses a string longer than its column before anything is written, by sheet, row and column, never echoing it', () => {
    const long = 'Course label; '.repeat(20);
    const { lines, values } = unstorableOf(withStaffValues({ courses: long }));

    expect(lines).toEqual([
      '- [unstorable] Кадар (Export) row 3, staff.courses: 280 characters, max 255',
    ]);
    expect(JSON.stringify(values)).not.toContain('Course label');
  });

  test('reports every value no column can hold in one check, several of one row included', () => {
    const long = 'Course label; '.repeat(20);
    const { lines } = unstorableOf({
      ...withStaffValues({ cabinet: long, courses: long }),
      rooms: base.rooms.map((row, index) =>
        index === 0 ? { ...row, capacity: 2 ** 31 } : row,
      ),
    });

    expect(lines).toEqual([
      '- [unstorable] Кадар (Export) row 3, staff.cabinet: 280 characters, max 255',
      '- [unstorable] Кадар (Export) row 3, staff.courses: 280 characters, max 255',
      '- [unstorable] Простории (Export) row 2, rooms.capacity: integer outside int4 range',
    ]);
  });

  test('checks the relational column a value is written to, not the workbook part it came from', () => {
    const long = `${courseNames.alpha} `.repeat(30);
    const { lines, values } = unstorableOf({
      ...base,
      curriculum_2018: base.curriculum_2018.map((row, index) =>
        index === 6 ? { ...row, name: long } : row,
      ),
    });

    expect(values).toHaveLength(1);
    expect(lines[0]).toBe(
      '- [unstorable] Предмети - 2018 row 8, curriculum_entries.name: 390 characters, max 255',
    );

    const labelled = {
      ...base,
      teaching_assignments: base.teaching_assignments.map((row) =>
        row.id === 3 ? { ...row, professors: long } : row,
      ),
    };

    expect(unstorableOf(labelled).values).toEqual([]);
  });

  test('counts characters, not UTF-16 units, and leaves text columns unbounded', () => {
    expect(
      unstorableOf(withStaffValues({ courses: '🎓'.repeat(255) })).values,
    ).toEqual([]);
    expect(
      unstorableOf(withStaffValues({ profile: 'x'.repeat(10_000) })).values,
    ).toEqual([]);
  });

  test('refuses an integer outside the column range', () => {
    expect(
      unstorableOf({
        ...base,
        rooms: base.rooms.map((row, index) =>
          index === 0 ? { ...row, capacity: 2 ** 31 } : row,
        ),
      }).lines,
    ).toEqual([
      '- [unstorable] Простории (Export) row 2, rooms.capacity: integer outside int4 range',
    ]);
  });

  test('accepts the parity workbook', async () => {
    const content = await readBack(parityDataset());

    expect(planImport(content).unstorable).toEqual([]);
  });
});

describe('study programs of the curriculum sheets', () => {
  test('are read from the first line of the program headers, named by it and sorted in column order', async () => {
    const content = await readBack(lifecycleDataset());

    expect(
      content.studyPrograms
        .filter(({ generation }) => generation === '2018')
        .map(({ code, name, sort }) => [sort, code, name]),
    ).toEqual([
      [1, 'kn', 'КН'],
      [2, 'siis', 'СИИС'],
      [3, 'pit', 'ПИТ'],
      [4, 'imb', 'ИМБ'],
      [5, 'ki', 'КИ'],
      [6, 'ke', 'КЕ'],
      [7, 'seis', 'SEIS'],
    ]);
    expect(content.studyPrograms).toHaveLength(15);
  });

  test('refuse an unknown program header before anything is written', async () => {
    const workbook = await reloaded(syntheticWorkbook(lifecycleDataset()));
    const sheet = workbook.getWorksheet('Предмети - 2023');
    if (sheet === undefined) {
      throw new Error('The 2023 curriculum sheet is missing');
    }
    sheet.getRow(1).getCell(13).value = 'Нов смер\nтраење: 4 год.';

    expect(() => readWorkbookContent(workbook)).toThrow(WorkbookDataError);
    expect(() => readWorkbookContent(workbook)).toThrow(
      'Предмети - 2023 row 1, column 13: header "Нов смер", expected "ИЕ"',
    );
  });
});

// The lifecycle workbook with a 16th academic year, newer than the rest.
const laterYear = '2026/2027';
const sixteenYears = [laterYear, ...academicYears];

describe('academic years of the enrollment sheet', () => {
  test('are read in sheet order, newest first', async () => {
    const content = await readBack(lifecycleDataset());

    expect(content.academicYears).toEqual([...academicYears]);
    expect(content.data).toEqual(workbookData(lifecycleDataset()));
  });

  test('are the years of the workbook only: fewer years import fewer, a 16th imports one more', async () => {
    const fewer = academicYears.filter((year) => year !== '2014/2015');
    const withoutPatterns = {
      ...parityDataset(),
      course_enrollment_patterns: [],
    };

    const shorter = await readBack(withoutPatterns, fewer);
    const longer = await readBack(lifecycleDataset(), sixteenYears);

    expect(shorter.academicYears).toEqual(fewer);
    expect(longer.academicYears).toEqual(sixteenYears);
  });

  test('refuse a later year appended after the oldest one instead of placed first', async () => {
    const workbook = await reloaded(
      syntheticWorkbook(lifecycleDataset(), [...academicYears, laterYear]),
    );

    expect(() => readWorkbookContent(workbook)).toThrow(WorkbookDataError);
    expect(() => readWorkbookContent(workbook)).toThrow(
      'Слушатели row 1: academic year 2026/2027 after 2011/2012 (column groups not newest first)',
    );
  });

  test('refuse two years out of their order', async () => {
    const swapped = academicYears.map((year) => {
      if (year === '2020/2021') {
        return '2019/2020';
      }
      return year === '2019/2020' ? '2020/2021' : year;
    });
    const workbook = await reloaded(
      syntheticWorkbook(lifecycleDataset(), swapped),
    );

    expect(() => readWorkbookContent(workbook)).toThrow(
      'Слушатели row 1: academic year 2020/2021 after 2019/2020 (column groups not newest first)',
    );
  });

  test('refuse a header that is not an academic year label', async () => {
    const workbook = await reloaded(
      syntheticWorkbook(lifecycleDataset(), ['2026/27', ...academicYears]),
    );

    expect(() => readWorkbookContent(workbook)).toThrow(
      'Слушатели row 1, column 2: not an academic year',
    );
  });

  test('refuse a year that heads two column groups', async () => {
    const workbook = await reloaded(syntheticWorkbook(lifecycleDataset()));
    const sheet = workbook.getWorksheet('Слушатели');
    if (sheet === undefined) {
      throw new Error('The listener sheet is missing');
    }
    const next = 2 + academicYears.length * 3;
    sheet.getRow(1).getCell(next).value = '2025/2026';

    expect(() => readWorkbookContent(workbook)).toThrow(
      'Слушатели row 1: academic year 2025/2026 heads two column groups',
    );
  });

  test('plans a workbook with a 16th year with a rule for every year and no unknown-year finding', async () => {
    const dataset = withCourse(parityDataset(), courseNames.alpha, {});
    const withLater = {
      ...dataset,
      course_enrollment_patterns: [
        ...dataset.course_enrollment_patterns,
        {
          academic_year: laterYear,
          course_name: courseNames.alpha,
          id: 90,
          pattern: 'Synthetic later pattern',
        },
      ],
    };
    const plan = planImport(await readBack(withLater, sixteenYears));
    const years = plan.collections.find(
      ({ collection }) => collection === 'academic_years',
    )?.rows;

    expect(plan.blockers).toEqual([]);
    expect(years?.map(({ key }) => key)).toEqual(sixteenYears);
    expect(countByCode(plan.skipped)).not.toHaveProperty(
      'unknown_academic_year',
    );
    expect(
      plan.collections.find(
        ({ collection }) => collection === 'course_enrollment_rules',
      )?.rows,
    ).toHaveLength(withLater.courses.length * sixteenYears.length);
  });
});

const listeners = {
  kind: 'course-enrollment-patterns',
  sheet: 'Слушатели',
} as const;

type SheetCell = null | number | string;

// A listener sheet: the given rows from row 1, and each given label column
// merged over its group's three columns in row 1, as the export merges it.
const listenerSheet = (
  rows: ReadonlyArray<readonly SheetCell[]>,
  mergedLabels: readonly number[] = [],
): ExcelJS.Workbook => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(listeners.sheet);
  for (const row of rows) {
    sheet.addRow([...row]);
  }
  for (const label of mergedLabels) {
    sheet.mergeCells(1, label, 1, label + 2);
  }
  return workbook;
};

// The academic year, course and pattern of every pattern read.
const patternsOf = (workbook: ExcelJS.Workbook) =>
  readCourseEnrollmentPatterns(workbook, listeners).map(({ item, place }) => [
    item['academic_year'],
    item['course_name'],
    item['pattern'],
    place.row,
  ]);

const yearsOf = (workbook: ExcelJS.Workbook) =>
  readEnrollmentYears(workbook, listeners);

describe('year groups of the listener sheet', () => {
  test('are read up to the last column, also when a pattern column inside the sheet is fully empty and an empty column follows the last group', () => {
    // Groups at B, E and H; the 2025/2026 pattern column G holds nothing,
    // and column K is empty but styled, as the export's column AX.
    const workbook = listenerSheet([
      [null, '2026/2027', null, null, '2025/2026', null, null, '2024/2025'],
      [courseOne, null, null, 'Course One-2026/2027|A'],
      [courseTwo, null, null, null, null, null, null, null, null, 'Two-B'],
    ]);
    const sheet = workbook.getWorksheet(listeners.sheet);
    if (sheet === undefined) {
      throw new Error('The listener sheet is missing');
    }
    sheet.getRow(1).getCell(11).style = { font: { bold: true } };

    // Columns A, B, D, E, H and J hold a value; the last column is K.
    expect(sheet.actualColumnCount).toBe(6);
    expect(sheet.columnCount).toBe(11);
    expect(yearsOf(workbook)).toEqual(['2026/2027', '2025/2026', '2024/2025']);
    expect(patternsOf(workbook)).toEqual([
      ['2026/2027', courseOne, 'Course One-2026/2027|A', 2],
      ['2024/2025', courseTwo, 'Two-B', 3],
    ]);
  });

  test('read a merged label once and never the two other columns of its group', async () => {
    const workbook = await reloaded(
      listenerSheet(
        [
          ['Предмет', '2025/2026', null, null, '2024/2025'],
          [courseOne, 12, 'Stray text', 'One-A', 7, 'Stray', 'One-B'],
          [courseTwo, 3, null, null, null, null, 'Two-B'],
        ],
        [2, 5],
      ),
    );

    expect(workbook.getWorksheet(listeners.sheet)?.model.merges).toEqual([
      'B1:D1',
      'E1:G1',
    ]);
    expect(yearsOf(workbook)).toEqual(['2025/2026', '2024/2025']);
    expect(patternsOf(workbook)).toEqual([
      ['2025/2026', courseOne, 'One-A', 2],
      ['2024/2025', courseOne, 'One-B', 2],
      ['2024/2025', courseTwo, 'Two-B', 3],
    ]);
  });

  test('refuse other text in row 1, a year heading two groups, a sheet without a group and a header inside a group', () => {
    const refusals: ReadonlyArray<readonly [readonly SheetCell[], string]> = [
      [
        ['Предмет', 'Канал', '2025/2026'],
        'Слушатели row 1, column 2: not an academic year',
      ],
      [
        [null, '2025/2026', null, null, '2025/2027'],
        'Слушатели row 1, column 5: not an academic year',
      ],
      [
        [null, '2025/2026', null, null, '2025/2026'],
        'Слушатели row 1: academic year 2025/2026 heads two column groups',
      ],
      [['Предмет'], 'Слушатели row 1: no academic year'],
      [
        [null, '2025/2026', 'Број', 'Регекс'],
        'Слушатели row 1, column 3: not empty inside the 2025/2026 group',
      ],
      [
        [null, '2025/2026', null, 'Регекс'],
        'Слушатели row 1, column 4: not empty inside the 2025/2026 group',
      ],
    ];
    for (const [header, message] of refusals) {
      const workbook = listenerSheet([header, [courseOne]]);

      expect(() => yearsOf(workbook)).toThrow(WorkbookDataError);
      expect(() => yearsOf(workbook)).toThrow(message);
      expect(() => patternsOf(workbook)).toThrow(message);
    }
  });

  test('skip an empty cell outside a group, so a group may start after one', () => {
    const workbook = listenerSheet([
      [null, null, '2025/2026', null, null, null, '2024/2025'],
      [courseOne, null, null, null, 'One-A', null, null, null, 'One-B'],
    ]);

    expect(yearsOf(workbook)).toEqual(['2025/2026', '2024/2025']);
    expect(patternsOf(workbook)).toEqual([
      ['2025/2026', courseOne, 'One-A', 2],
      ['2024/2025', courseOne, 'One-B', 2],
    ]);
  });

  test('refuse the older export, whose column B is the course code', async () => {
    const workbook = await reloaded(syntheticWorkbook(lifecycleDataset()));
    const sheet = workbook.getWorksheet(listeners.sheet);
    sheet?.spliceColumns(2, 0, ['Код']);

    expect(() => readWorkbookContent(workbook)).toThrow(
      'Слушатели row 1, column 2: not an academic year',
    );
  });
});

// A Courses sheet headed by the given headers, every contract field in
// reverse order unless a test names others, with one row per record.
const coursesSheet = (
  records: ReadonlyArray<Readonly<Record<string, SheetCell>>>,
  headers: readonly string[] = snapshotFields.toReversed(),
): ExcelJS.Workbook => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Courses');
  sheet.addRow([...headers]);
  for (const record of records) {
    sheet.addRow(headers.map((header) => record[header] ?? null));
  }
  return workbook;
};

const usersOf = (workbook: ExcelJS.Workbook) => {
  const spec = specOf('moodle_users');
  if (spec?.source.kind !== 'rows') {
    throw new Error('No spec reads the Courses sheet');
  }
  return readRows(workbook, spec, spec.source).map(({ item }) => item);
};

const integerKeys: ReadonlySet<string> = new Set([
  'Courses Count',
  'ID_new',
  'ID_old',
]);

// A synthetic value for every contract field: a number for the integer
// fields, a text naming the field for the others.
const everyField = (id: number): Readonly<Record<string, SheetCell>> =>
  Object.fromEntries(
    snapshotFields.map((name) => [
      name,
      integerKeys.has(name) ? id : `Synthetic ${name} ${String(id)}`,
    ]),
  );

const refusalOf = (read: () => unknown): string => {
  try {
    read();
  } catch (error) {
    if (error instanceof WorkbookDataError) {
      return error.message;
    }
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('the Courses sheet', () => {
  test('reads every contract field by its own name, the four the older export lacked included, and a row without ID_new with its ID_old', () => {
    const users = usersOf(
      coursesSheet([
        everyField(7),
        { ID_old: 11, Name: 'Synthetic Old Account', Timezone_old: 'UTC' },
      ]),
    );

    expect(users[0]).toEqual(everyField(7));
    expect(users[0]).toMatchObject({
      ID_old: 7,
      Profile_old: 'Synthetic Profile_old 7',
      Timezone_new: 'Synthetic Timezone_new 7',
      Timezone_old: 'Synthetic Timezone_old 7',
    });
    expect(users[1]).toEqual({
      ...Object.fromEntries(snapshotFields.map((name) => [name, null])),
      ID_old: 11,
      Name: 'Synthetic Old Account',
      Timezone_old: 'UTC',
    });
  });

  test('refuses the older export headers at the first contract field', () => {
    // The 2026-09-30 Courses sheet: ID, Profile and # for ID_new,
    // Profile_new and Courses Count, and no ID_old, Profile_old or
    // Timezone column.
    const renamed: ReadonlyMap<string, string> = new Map([
      ['Courses Count', '#'],
      ['ID_new', 'ID'],
      ['Profile_new', 'Profile'],
    ]);
    const absent = new Set([
      'ID_old',
      'Profile_old',
      'Timezone_new',
      'Timezone_old',
    ]);
    const older = snapshotFields
      .filter((name) => !absent.has(name))
      .map((name) => renamed.get(name) ?? name);

    expect(refusalOf(() => usersOf(coursesSheet([], older)))).toBe(
      'Courses row 1: missing column "ID_old"',
    );
  });

  test('refuses an id that is not positive, or that repeats in its column, with the place and never the id', () => {
    const cases: ReadonlyArray<
      readonly [ReadonlyArray<Readonly<Record<string, SheetCell>>>, string]
    > = [
      [
        [{ ID_new: 0, Name: 'Zero' }],
        'Courses row 2, column "ID_new": not a positive id',
      ],
      [
        [{ ID_old: -5, Name: 'Negative' }],
        'Courses row 2, column "ID_old": not a positive id',
      ],
      [
        [{ ID_new: 1.5, Name: 'Fraction' }],
        'Courses row 2, column "ID_new": not a positive id',
      ],
      [
        [{ ID_old: 'abc', Name: 'Text' }],
        'Courses row 2, column "ID_old": not a positive id',
      ],
      [
        [{ ID_new: 2_147_483_648, Name: 'Beyond int4' }],
        'Courses row 2, column "ID_new": not a positive id',
      ],
      [
        [
          { ID_old: 9, Name: 'First' },
          { ID_old: 8, Name: 'Second' },
          { ID_old: 9, Name: 'Third' },
        ],
        'Courses row 4, column "ID_old": repeats the id of row 2',
      ],
      [
        [
          { ID_new: 4, Name: 'First' },
          { ID_new: 4, Name: 'Second' },
        ],
        'Courses row 3, column "ID_new": repeats the id of row 2',
      ],
    ];
    for (const [records, message] of cases) {
      expect(refusalOf(() => usersOf(coursesSheet(records)))).toBe(message);
    }
  });

  test('accepts empty ids on several rows, and one id in both columns', () => {
    const users = usersOf(
      coursesSheet([
        { Name: 'No id' },
        { Name: 'No id either' },
        { ID_new: 5, ID_old: 6, Name: 'First' },
        { ID_new: 6, ID_old: 5, Name: 'Second' },
      ]),
    );

    expect(users.map((user) => [user['ID_old'], user['ID_new']])).toEqual([
      [null, null],
      [null, null],
      [6, 5],
      [5, 6],
    ]);
  });
});
