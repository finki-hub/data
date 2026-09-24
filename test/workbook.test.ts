import ExcelJS from 'exceljs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { countByCode } from '../src/migrations/conversion.js';
import { readInventory } from '../src/migrations/inventory.js';
import { preflight } from '../src/migrations/preflight.js';
import {
  assertImportedRows,
  checkpointIds,
  type IdsOf,
  previewBlockers,
  WorkbookAdapterError,
  workbookCheckpoint,
} from '../src/migrations/workbook-adapter.js';
import { collectionSpecs } from '../src/model.js';
import {
  type CollectionSpec,
  derivedField,
  literalField,
  type MigrationData,
  requiredField,
} from '../src/schema.js';
import { academicYears } from '../src/specs/public.js';
import { readCourseEnrollmentPatterns } from '../src/workbook-enrollment-reader.js';
import { readRows } from '../src/workbook-row-reader.js';
import { WorkbookDataError } from '../src/workbook-values.js';
import {
  assertStorable,
  loadWorkbook,
  readMigrationData,
  readWorkbookContent,
} from '../src/workbook.js';
import { emptyData } from './directus-test-helpers.js';
import { withMetacharacterCourse } from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  reloaded,
  syntheticWorkbook,
  withSequentialIds,
  workbookContent,
  workbookData,
} from './fixtures/synthetic-workbook.js';
import {
  fakeItemsDirectus,
  storeFromDataset,
} from './migration-test-helpers.js';

const unreadablePattern = /could not be read as an \.xlsx file/u;

// The generated synthetic workbook, saved and reloaded, as the readers see it.
const parsedWorkbook = async (): Promise<MigrationData> =>
  readMigrationData(await reloaded(syntheticWorkbook(lifecycleDataset())));

// The checkpoint rows an upgrade reads back from a deployment holding the
// same rows under the ids a fresh table hands out.
const upgradeCheckpoint = async (data: MigrationData) => {
  const store = storeFromDataset(withSequentialIds(data), { installed: true });
  return readInventory(fakeItemsDirectus(store).request, {});
};

// The ids a fresh table hands the workbook rows: 1, 2, ...
const sequentialIds =
  (data: MigrationData): IdsOf =>
  (collection) =>
    data[collection].map((_, index) => index + 1);

const staffWith = (values: Record<string, string>): MigrationData => ({
  ...emptyData,
  staff: [
    { active: true, name: 'Synthetic Staff' },
    { active: true, name: 'Synthetic Staff Two', ...values },
  ],
});

const failureOf = (work: () => void): unknown => {
  try {
    work();
    return null;
  } catch (error) {
    return error;
  }
};

describe('workbook readers', () => {
  test('imports literal source cells without copying cached formula results', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic courses');
    sheet.addRow(['name', 'professors']);
    sheet.addRow([
      'Course One',
      { formula: '"Derived Professor"', result: 'Derived Professor' },
    ]);
    sheet.addRow(['Course Two', 'Manual Professor']);
    const spec = {
      displayTemplate: '{{name}}',
      fields: [
        requiredField('name', 'name'),
        literalField('professors', 'professors_override', 'text'),
        derivedField('professors', 'text'),
      ],
      icon: 'school',
      key: 'courses',
      note: 'Synthetic test collection.',
      previewFields: ['name'],
      previewSort: 'name',
      sort: 1,
      source: { kind: 'rows', sheet: 'Synthetic courses' },
    } as const satisfies CollectionSpec;

    expect(readRows(workbook, spec, spec.source)).toEqual([
      { name: 'Course One', professors_override: null },
      { name: 'Course Two', professors_override: 'Manual Professor' },
    ]);
  });

  test('normalizes only literal listener pattern overrides', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Synthetic listeners');
    sheet.addRow(['', '', '2025/2026', '', '2025/2026']);
    sheet.addRow(['Course One', '', '', '', 'Course One-2025/2026|Legacy']);
    sheet.addRow(['Course Two', '', '', '', '']);
    sheet.getRow(3).getCell(5).value = {
      formula: '$A3&"-"&C$1',
      result: 'Course Two-2025/2026',
    };

    expect(
      readCourseEnrollmentPatterns(workbook, {
        kind: 'course-enrollment-patterns',
        sheet: 'Synthetic listeners',
      }),
    ).toEqual([
      {
        academic_year: '2025/2026',
        course_name: 'Course One',
        pattern: 'Course One-2025/2026|Legacy',
      },
    ]);
  });

  test('models the longest staff profile URL without truncation', () => {
    const staff = collectionSpecs.find(({ key }) => key === 'staff');
    const profile = staff?.fields.find(({ target }) => target === 'profile');

    expect(profile?.kind).toBe('text');
  });

  test('does not store formula-only preview sheets as duplicate collections', () => {
    const sourceSheets = collectionSpecs.flatMap(({ source }) =>
      source.kind === 'rows' ? [source.sheet] : [],
    );

    expect(sourceSheets).not.toContain('Пребарување');
    expect(sourceSheets).not.toContain('Индекси');
  });

  test('marks spreadsheet outputs as derived Directus fields', () => {
    const courses = collectionSpecs.find(({ key }) => key === 'courses');
    const council = collectionSpecs.find(
      ({ key }) => key === 'student_council',
    );

    expect(
      courses?.fields.find(({ target }) => target === 'enrollment_2025_2026'),
    ).toMatchObject({ derived: true });
    expect(
      courses?.fields.find(({ target }) => target === 'professors_override'),
    ).toMatchObject({ sourceMode: 'literal' });
    expect(
      council?.fields.find(({ target }) => target === 'name'),
    ).toMatchObject({ derived: true });
  });

  test('uses the current courses-scraper CSV headers as Moodle field keys', () => {
    const moodleUsers = collectionSpecs.find(
      ({ key }) => key === 'moodle_users',
    );

    expect(moodleUsers?.fields.map(({ target }) => target)).toEqual([
      'ID_old',
      'ID_new',
      'Name',
      'Mail',
      'Courses',
      'Courses Count',
      'Profile_old',
      'Profile_new',
      'AIM_new',
      'AIM_old',
      'Avatar_new',
      'Avatar_old',
      'City_new',
      'City_old',
      'Country_new',
      'Country_old',
      'Description_new',
      'Description_old',
      'ICQ_new',
      'ICQ_old',
      'Images_new',
      'Images_old',
      'Interests_new',
      'Interests_old',
      'Last Access_new',
      'Last Access_old',
      'MSN_new',
      'MSN_old',
      'MoodleNet_new',
      'MoodleNet_old',
      'Skype_new',
      'Skype_old',
      'Timezone_new',
      'Timezone_old',
      'Web_new',
      'Web_old',
      'Yahoo_new',
      'Yahoo_old',
    ]);
  });
});

describe('generated synthetic workbook', () => {
  test('reads back through the unchanged checkpoint readers as the source rows it was written from', async () => {
    const data = await parsedWorkbook();

    expect(data).toEqual(workbookData(lifecycleDataset()));
    expect(data.students.map(({ source_group }) => source_group)).toEqual([
      'SENTINEL_PRIVATE_SOURCE_GROUP:year-list',
      'SENTINEL_PRIVATE_SOURCE_GROUP:year-list',
      'SENTINEL_PRIVATE_SOURCE_GROUP:other-list',
    ]);
    expect(
      data.courses.every((course) => !Object.hasOwn(course, 'professors')),
    ).toBeTruthy();
    expect(data.course_enrollment_patterns).toHaveLength(4);
    expect(data.discord_channels.map(({ semester }) => semester)).toEqual([
      1, 6,
    ]);
  });

  test('names an unreadable workbook file instead of failing inside the parser', async () => {
    await expect(
      loadWorkbook(
        path.join(os.tmpdir(), 'finki-hub-missing-synthetic-workbook.xlsx'),
      ),
    ).rejects.toThrow(unreadablePattern);
  });
});

describe('workbook adapter', () => {
  test('hands the converters exactly the rows an upgrade of the same checkpoint rows reads back', async () => {
    const data = await parsedWorkbook();
    const inventory = await upgradeCheckpoint(data);

    expect(workbookCheckpoint(data, sequentialIds(data))).toEqual(
      inventory.checkpoint,
    );
    expect(checkpointIds(inventory.checkpoint)('staff')).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  test('the synthetic workbook converts without blockers and keeps its peculiarities under review', async () => {
    const report = preflight(
      await upgradeCheckpoint(await parsedWorkbook()),
      null,
    );
    const warnings = new Set(report.warnings.map(({ code }) => code));

    expect(report.blockers).toEqual([]);

    for (const code of [
      'duplicate_assignment',
      'duplicate_pattern',
      'orphan_assignment',
      'orphan_equivalency',
      'orphan_pattern',
      'unmatched_council_index',
      'unreferenced_rows',
    ]) {
      expect(warnings).toContain(code);
    }
  });

  test('previews offline exactly the blockers the preflight of the written rows finds', async () => {
    const base = lifecycleDataset();
    const ambiguous = workbookContent(
      withMetacharacterCourse({
        ...base,
        students: [
          ...base.students,
          {
            id: 99,
            index_number: 'SYN-0001',
            name: 'Synthetic Student One (Other List)',
            source_group: 'synthetic:other-list',
          },
        ],
      }),
    );
    const live = preflight(await upgradeCheckpoint(ambiguous.data), null);

    expect(previewBlockers(workbookContent(lifecycleDataset()))).toEqual({});
    expect(previewBlockers(ambiguous)).toEqual({
      ambiguous_student_index: 1,
      invalid_regex: 1,
    });
    expect(previewBlockers(ambiguous)).toEqual(countByCode(live.blockers));
  });

  test('refuses rows read back that are not the workbook rows', async () => {
    const data = await parsedWorkbook();
    const { checkpoint } = await upgradeCheckpoint(data);

    expect(() => {
      assertImportedRows(data, checkpoint);
    }).not.toThrow();

    const courses = checkpoint.courses.map((row) =>
      row.id === 2 ? { ...row, name_2023: 'Edited meanwhile' } : row,
    );
    const edited = failureOf(() => {
      assertImportedRows(data, { ...checkpoint, courses });
    });

    expect(edited).toBeInstanceOf(WorkbookAdapterError);
    expect(String(edited)).toContain('read back from courses differ');
    expect(String(edited)).not.toContain('Edited meanwhile');

    const extra = failureOf(() => {
      assertImportedRows(data, {
        ...checkpoint,
        rooms: [...checkpoint.rooms, { id: 99 }],
      });
    });

    expect(String(extra)).toContain(
      'rooms holds 4 row(s), but the workbook supplied 3.',
    );
  });
});

describe('storable workbook values', () => {
  test('refuse a string longer than its column before anything is written, without echoing it', () => {
    const long = 'Course label; '.repeat(20);
    const error = failureOf(() => {
      assertStorable(staffWith({ courses: long }));
    });

    expect(error).toBeInstanceOf(WorkbookDataError);
    expect(String(error)).toContain(
      'staff row 2 of the workbook: courses holds 280 characters, but the column stores at most 255.',
    );
    expect(String(error)).not.toContain('Course label');
  });

  test('count characters, not UTF-16 units, and leave text columns unbounded', () => {
    expect(() => {
      assertStorable(staffWith({ courses: '🎓'.repeat(255) }));
    }).not.toThrow();
    expect(() => {
      assertStorable(staffWith({ profile: 'x'.repeat(10_000) }));
    }).not.toThrow();
  });

  test('refuse an integer outside the column range', () => {
    const data: MigrationData = {
      ...emptyData,
      rooms: [
        { capacity: 2 ** 31, location: 'Synthetic Building', name: 'Room' },
      ],
    };

    expect(() => {
      assertStorable(data);
    }).toThrow(
      'rooms row 1 of the workbook: capacity holds an integer outside the range',
    );
  });

  test('accept the synthetic workbook', async () => {
    const data = await parsedWorkbook();

    expect(() => {
      assertStorable(data);
    }).not.toThrow();
  });
});

// The lifecycle workbook with a 16th academic year, newer than the rest.
const laterYear = '2026/2027';

// The academic years a course candidate seeds a rule for, in order.
const ruleYears = ({
  rules,
}: {
  readonly rules: ReadonlyArray<{ readonly academicYear: string }>;
}): string[] => rules.map(({ academicYear }) => academicYear);
const sixteenYears = [laterYear, ...academicYears];

describe('study programs of the curriculum sheets', () => {
  test('are read from the program headers, named by them and sorted in column order', async () => {
    const content = readWorkbookContent(
      await reloaded(syntheticWorkbook(lifecycleDataset())),
    );

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
    sheet.getRow(1).getCell(13).value = 'Нов смер';

    expect(() => readWorkbookContent(workbook)).toThrow(WorkbookDataError);
    expect(() => readWorkbookContent(workbook)).toThrow(
      'The program column 6 of the curriculum_2023 sheet is headed "Нов смер"',
    );
  });
});

describe('academic years of the enrollment sheet', () => {
  test('are read in sheet order, newest first, and include the fifteen checkpoint years', async () => {
    const content = readWorkbookContent(
      await reloaded(syntheticWorkbook(lifecycleDataset())),
    );

    expect(content.academicYears).toEqual([...academicYears]);
    expect(content.data).toEqual(workbookData(lifecycleDataset()));
  });

  test('carry a 16th year header into the content', async () => {
    const content = readWorkbookContent(
      await reloaded(syntheticWorkbook(lifecycleDataset(), sixteenYears)),
    );

    expect(content.academicYears).toEqual(sixteenYears);
    expect(content).toEqual(workbookContent(lifecycleDataset(), sixteenYears));
  });

  test('refuse a workbook that drops a year the checkpoint counts', async () => {
    const workbook = await reloaded(
      syntheticWorkbook(
        { ...lifecycleDataset(), course_enrollment_patterns: [] },
        academicYears.filter((year) => year !== '2014/2015'),
      ),
    );

    expect(() => readWorkbookContent(workbook)).toThrow(WorkbookDataError);
    expect(() => readWorkbookContent(workbook)).toThrow(
      'The enrollment sheet names no column group for the academic year(s) 2014/2015; every year the checkpoint counts must stay.',
    );
  });

  test('refuse a later year appended after the oldest one instead of placed first', async () => {
    const workbook = await reloaded(
      syntheticWorkbook(lifecycleDataset(), [...academicYears, laterYear]),
    );

    expect(() => readWorkbookContent(workbook)).toThrow(WorkbookDataError);
    expect(() => readWorkbookContent(workbook)).toThrow(
      'The enrollment sheet lists the academic year 2026/2027 after 2011/2012; order its column groups newest first, since each year sorts by its position.',
    );
  });

  test('refuse two checkpoint years out of their order', async () => {
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
      'The enrollment sheet lists the academic year 2020/2021 after 2019/2020;',
    );
  });

  test('refuse a header that is not an academic year label', async () => {
    const workbook = await reloaded(
      syntheticWorkbook(lifecycleDataset(), ['2026/27', ...academicYears]),
    );

    expect(() => readWorkbookContent(workbook)).toThrow(
      'The enrollment sheet heads a column group with "2026/27", which is not an academic year such as 2025/2026.',
    );
  });

  test('refuse a year that heads two column groups', async () => {
    const workbook = await reloaded(syntheticWorkbook(lifecycleDataset()));
    const sheet = workbook.getWorksheet('Слушатели');
    if (sheet === undefined) {
      throw new Error('The listener sheet is missing');
    }
    const next = 3 + academicYears.length * 3;
    sheet.getRow(1).getCell(next).value = '2025/2026';
    sheet.getRow(1).getCell(next + 1).value = 'Број';
    sheet.getRow(1).getCell(next + 2).value = 'Регекс';

    expect(() => readWorkbookContent(workbook)).toThrow(
      'Academic year 2025/2026 heads two column groups of Слушатели',
    );
  });

  test('preview a workbook with a 16th year without an unknown-year finding', async () => {
    const dataset = lifecycleDataset();
    const withLater = {
      ...dataset,
      course_enrollment_patterns: [
        ...dataset.course_enrollment_patterns,
        {
          academic_year: laterYear,
          course_name: dataset.courses[0]?.['name'] ?? null,
          id: 90,
          pattern: 'Synthetic later pattern',
        },
      ],
    };
    const content = workbookContent(withLater, sixteenYears);
    const report = preflight(
      await upgradeCheckpoint(content.data),
      null,
      content.academicYears,
    );

    expect(previewBlockers(content)).toEqual({});
    expect(report.academicYears).toEqual(sixteenYears);
    expect(
      report.warnings.filter(({ code }) => code === 'unknown_academic_year'),
    ).toEqual([]);
    expect(report.candidates.courses.map(ruleYears)).toEqual(
      report.candidates.courses.map(() => sixteenYears),
    );
  });
});
