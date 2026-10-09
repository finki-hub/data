import { describe, expect, test } from 'vitest';

import { checkSummary, refusalLines } from '../src/import-report.js';
import {
  detailed,
  finding,
  isWarning,
  ruleFixCodes,
} from '../src/import/findings.js';
import { fixPlaces } from '../src/import/fix-places.js';
import { planImport } from '../src/import/plan.js';
import {
  compositeKey,
  isRef,
  type PlannedValue,
} from '../src/import/planned.js';
import { readWorkbookContent } from '../src/workbook.js';
import {
  courseNames,
  staffNames,
  type SyntheticDataset,
} from './fixtures/synthetic-data.js';
import {
  lifecycleDataset,
  reloaded,
  syntheticWorkbook,
} from './fixtures/synthetic-workbook.js';
import {
  codes,
  contentOf,
  planOf,
  rowsIn,
  shapes,
  withAssignment,
  withCourse,
} from './import-plan-helpers.js';
import { parityDataset } from './relational-export-helpers.js';

// The summary both import commands print for a dataset, read in dataset
// order (row N + 1 of each sheet is the dataset's row N).
const summaryOf = (dataset: SyntheticDataset) =>
  checkSummary(planOf(dataset), contentOf(dataset));

// The ordinals of the teaching rows the planned role rows come from.
const plannedTeachingRows = (dataset: SyntheticDataset) => [
  ...new Set(
    rowsIn(planOf(dataset), 'teaching_assignments').flatMap(({ origin }) =>
      origin?.source === 'teaching_assignments' ? [origin.id] : [],
    ),
  ),
];

// The lifecycle dataset with a tenth teaching row, a third of Alpha.
const thirdAlphaRow = (): SyntheticDataset =>
  withAssignment(lifecycleDataset(), {
    id: 10,
    course_name: courseNames.alpha,
    professors: 'Prof. Third Alpha',
    assistants: null,
  });

// The dataset with Iota's professors listed once each, so no rule fixes
// a repeated name.
const withoutRepeat = (dataset: SyntheticDataset): SyntheticDataset => ({
  ...dataset,
  teaching_assignments: dataset.teaching_assignments.map((row) =>
    row['course_name'] === courseNames.iota
      ? { ...row, professors: `${staffNames.active}\n${staffNames.inactive}` }
      : row,
  ),
});

// Iota's teaching row lists its first professor again on line 3: row 9 of
// the lifecycle dataset's Наставен Кадар, row 8 of the parity dataset's,
// which lacks Alpha's second row.
const iotaRepeat = 'Наставен Кадар row 9, column "Професори", line 3';

describe('a later teaching row of a course', () => {
  test('is ignored, neither planned nor checked, and the first row is planned', () => {
    // A name no staff row carries, which a teaching row the import reads
    // blocks (unmatched_staff_name).
    const dataset = withAssignment(parityDataset(), {
      id: 10,
      course_name: courseNames.alpha,
      professors: 'Prof. Nobody Alpha',
      assistants: null,
    });
    const plan = planOf(dataset);
    const later = dataset.teaching_assignments.length;

    expect(plan.blockers).toEqual([]);
    expect(
      [...plan.skipped, ...plan.warnings]
        .filter(
          ({ collection, ids }) =>
            collection === 'teaching_assignments' && ids.includes(later),
        )
        .map(({ code }) => code),
    ).toEqual(['duplicate_assignment']);
    expect(plannedTeachingRows(dataset)).not.toContain(later);
    expect(plannedTeachingRows(dataset)).toContain(1);
    expect(
      rowsIn(plan, 'teaching_assignments')
        .filter(({ origin }) => origin?.id === 1)
        .map(({ record }) => [record['role'], record['sort']]),
    ).toEqual([
      ['professor', 1],
      ['professor', 2],
      ['assistant', 3],
    ]);
  });

  test('gives one warning per later row, naming that row, the course and the row used', () => {
    const plan = planOf(thirdAlphaRow());

    expect(
      plan.warnings
        .filter(({ code }) => code === 'duplicate_assignment')
        .map(({ ids, related }) => [ids, related]),
    ).toEqual([
      [
        [2],
        [
          { collection: 'courses', ids: [1] },
          { collection: 'teaching_assignments', ids: [1] },
        ],
      ],
      [
        [10],
        [
          { collection: 'courses', ids: [1] },
          { collection: 'teaching_assignments', ids: [1] },
        ],
      ],
    ]);
    expect(summaryOf(thirdAlphaRow()).fixes).toEqual({
      duplicate_assignment: [
        'Наставен Кадар row 3 (used: row 2)',
        'Наставен Кадар row 11 (used: row 2)',
      ],
      repeated_staff_name: [iotaRepeat],
    });
  });

  test('of a name several courses carry is no rule fix: every row naming it blocks as ambiguous', () => {
    const base = lifecycleDataset();
    const [alpha] = base.courses;
    const plan = planOf({
      ...base,
      courses: [...base.courses, { ...alpha, id: 90, name: courseNames.alpha }],
    });

    expect(codes(plan.warnings)).not.toContain('duplicate_assignment');
    expect(shapes(plan.blockers, 'ambiguous_course_name')).toEqual(
      expect.arrayContaining([
        { collection: 'teaching_assignments', ids: [1] },
        { collection: 'teaching_assignments', ids: [2] },
      ]),
    );
  });
});

describe('an availability of TRUE without a name', () => {
  test('links nothing and is placed by its cell under fixes', () => {
    const dataset = withCourse(
      withCourse(parityDataset(), courseNames.gamma, { available_2018: true }),
      courseNames.delta,
      { available_2023: true },
    );
    const plan = planOf(dataset);

    const links = rowsIn(plan, 'course_curricula').map(({ key }) => key);

    expect(plan.blockers).toEqual([]);
    expect(links).not.toContain(compositeKey(3, '2018'));
    expect(links).not.toContain(compositeKey(4, '2023'));
    expect(links).toContain(compositeKey(3, '2023'));
    expect(summaryOf(withoutRepeat(dataset)).fixes).toEqual({
      unlinked_availability: [
        'Предмети (Export) row 4, column "2018-available"',
        'Предмети (Export) row 5, column "2023-available"',
      ],
    });
  });
});

// The plan key a planned reference names, or null for a scalar.
const refKey = (value: PlannedValue | undefined): null | string =>
  value !== undefined && isRef(value) ? value.key : null;

// The parity workbook with a formula in Alpha's empty 2024/2025 pattern
// cell (Слушатели row 2, column G), whose result is no pattern the
// dataset holds.
const withFormulaPattern = async () => {
  const workbook = syntheticWorkbook(parityDataset());
  const sheet = workbook.getWorksheet('Слушатели');
  if (sheet === undefined) {
    throw new Error('The listener sheet is missing');
  }
  sheet.getRow(2).getCell(7).value = {
    formula: '$A2&"-Formula-"&E$1',
    result: 'Alpha Formula-2024/2025',
  };
  return readWorkbookContent(await reloaded(workbook));
};

describe('a formula pattern cell', () => {
  test("is not read: its course and year fall to the course's all-years mappings, and it is placed by its cell and year", async () => {
    const content = await withFormulaPattern();
    const plain = readWorkbookContent(
      await reloaded(syntheticWorkbook(parityDataset())),
    );
    const plan = planImport(content);
    const summary = checkSummary(plan, content);

    expect(content.formulaPatternCells).toEqual([
      { column: '2024/2025', row: 2, sheet: 'Слушатели' },
    ]);
    expect(plain.formulaPatternCells).toEqual([]);
    expect(content.data.course_enrollment_patterns).toEqual(
      plain.data.course_enrollment_patterns,
    );
    expect(rowsIn(plan, 'moodle_pattern_mappings')).toEqual(
      rowsIn(planImport(plain), 'moodle_pattern_mappings'),
    );
    expect(
      rowsIn(plan, 'moodle_pattern_mappings').filter(
        ({ record }) =>
          refKey(record['course']) === '1' &&
          refKey(record['only_in_year']) === '2024/2025',
      ),
    ).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(summary.warnings).toMatchObject({ formula_pattern_cell: 1 });
    expect(summary.fixes).toEqual({
      formula_pattern_cell: ['Слушатели row 2, column "2024/2025"'],
      repeated_staff_name: ['Наставен Кадар row 8, column "Професори", line 3'],
    });
    expect(JSON.stringify(summary)).not.toContain('Formula');
  });
});

// A formula pattern cell finding at a sheet and row.
const formulaCell = (sheet: string, row: number) =>
  detailed(finding('formula_pattern_cell', 'course_enrollment_patterns', []), {
    cell: { column: '2025/2026', row, sheet },
  });

describe('the fixes of the summary', () => {
  test('list only places, per code with a case, in sheet order and then row order, and never a course name or staff value', () => {
    const dataset = withCourse(thirdAlphaRow(), courseNames.gamma, {
      available_2018: true,
    });
    const summary = summaryOf(dataset);
    const text = JSON.stringify(summary.fixes);
    const values = [
      ...dataset.courses.map((row) => row['name']),
      ...dataset.staff.map((row) => row['name']),
      ...dataset.teaching_assignments.flatMap((row) => [
        row['professors'],
        row['assistants'],
      ]),
    ].filter((value) => typeof value === 'string' && value !== '');

    expect(summary.fixes).toEqual({
      duplicate_assignment: [
        'Наставен Кадар row 3 (used: row 2)',
        'Наставен Кадар row 11 (used: row 2)',
      ],
      repeated_staff_name: [iotaRepeat],
      unlinked_availability: [
        'Предмети (Export) row 4, column "2018-available"',
      ],
    });

    for (const value of values) {
      expect(text).not.toContain(value);
    }
  });

  test('order the places of one code by the sheets the import reads, then by row, whatever order the findings come in', () => {
    expect(
      fixPlaces(
        [
          formulaCell('Слушатели', 9),
          formulaCell('Слушатели', 3),
          formulaCell('Предмети (Export)', 12),
        ],
        contentOf(parityDataset()).places,
      ),
    ).toEqual({
      formula_pattern_cell: [
        'Предмети (Export) row 12, column "2025/2026"',
        'Слушатели row 3, column "2025/2026"',
        'Слушатели row 9, column "2025/2026"',
      ],
    });
  });

  test('are empty without a rule fix, and the summary keeps every existing key', () => {
    const summary = summaryOf(withoutRepeat(parityDataset()));

    expect(summary.fixes).toEqual({});
    expect(Object.keys(summary)).toEqual([
      'blockers',
      'fixes',
      'rows',
      'skipped',
      'unstorable',
      'warnings',
    ]);
  });

  test('cover only warnings', () => {
    for (const code of ruleFixCodes) {
      expect(isWarning(finding(code, 'courses', [1]))).toBeTruthy();
    }
  });
});

// The parity dataset with Alpha's cells for 2024/2025 (with a pasted
// line break) and 2023/2024, each also naming an English line, and the
// Moodle users' histories replaced by the given ones.
const withAlphaCells = (
  first: string,
  users: readonly string[],
): SyntheticDataset => {
  const base = parityDataset();
  return {
    ...base,
    course_enrollment_patterns: [
      {
        id: 1,
        course_name: courseNames.alpha,
        academic_year: '2024/2025',
        pattern: first,
      },
      {
        id: 2,
        course_name: courseNames.alpha,
        academic_year: '2023/2024',
        pattern: 'Alpha Course-2023/2024|Alpha English-2023/2024',
      },
    ],
    moodle_users: base.moodle_users.map((row, index) => ({
      ...row,
      Courses: users[index] ?? null,
    })),
  };
};
const histories = [
  'Alpha Course-2024/2025/Z\nAlpha English-2024/2025/Z',
  'Alpha English-2023/2024/Z',
  'Alpha English-2025/2026/Z',
];

describe('typed Слушатели cells', () => {
  test('lose their line breaks, and the newest year may count more for a course without a typed cell in it: both rule fixes placed by their cell', () => {
    const dataset = withAlphaCells(
      'Alpha Course-2024/2025|\nAlpha English-2024/2025',
      histories,
    );
    const summary = summaryOf(dataset);

    expect(summary.fixes).toEqual({
      newest_year_widened: ['Слушатели row 2, column "2025/2026"'],
      pattern_line_break: ['Слушатели row 2, column "2024/2025"'],
      repeated_staff_name: ['Наставен Кадар row 8, column "Професори", line 3'],
    });
    expect(summary.skipped).toMatchObject({ merged_pattern: 2 });
    expect(summary.rows).toMatchObject({
      moodle_pattern_mappings: dataset.courses.length,
    });
    expect(
      rowsIn(planOf(dataset), 'moodle_pattern_mappings')[0]?.record,
    ).toMatchObject({
      pattern: 'Alpha Course-|Alpha English-',
      year_pattern: String.raw`(?<start>\d{4})/(?<end>\d{4})`,
    });
  });

  test('block the import when they are no Unicode regular expression without their line breaks', () => {
    const plan = planOf(
      withAlphaCells('Alpha Course-2024/2025|\n*', histories),
    );

    expect(plan.blockers).toEqual([
      expect.objectContaining({
        code: 'invalid_regex',
        collection: 'courses',
        ids: [1],
        related: [{ collection: 'course_enrollment_patterns', ids: [1] }],
      }),
    ]);
  });

  test('refuse the import before it writes when a kept pattern is over the bytes the database holds, placed by its cell', () => {
    // 1,100 two-byte letters: 1,118 characters, 2,218 bytes.
    const dataset = withAlphaCells(
      `(?:${'Ω'.repeat(1_100)})?Alpha English`,
      histories,
    );
    const plan = planOf(dataset);

    expect(
      rowsIn(plan, 'moodle_pattern_mappings').filter(
        ({ record }) => record['only_in_year'] !== null,
      ),
    ).toHaveLength(1);
    expect(refusalLines(plan, contentOf(dataset))).toEqual([
      '- [unstorable] Слушатели row 2, moodle_pattern_mappings.pattern: 2218 bytes, max 2048',
    ]);
  });
});
