import type ExcelJS from 'exceljs';

import { isDeepStrictEqual } from 'node:util';
import { describe, expect, test } from 'vitest';

import { countByCode } from '../src/import/findings.js';
import { workbookGenerations } from '../src/import/generations.js';
import { planImport } from '../src/import/plan.js';
import { type PlannedRow, ref } from '../src/import/planned.js';
import { WorkbookDataError } from '../src/workbook-values.js';
import { readWorkbookContent } from '../src/workbook.js';
import {
  lifecycleDataset,
  reloaded,
  syntheticWorkbook,
  withHeaderCleared,
  withoutColumn,
} from './fixtures/synthetic-workbook.js';
import {
  equivalencySpec,
  generationHeaders,
  headerOf,
  itemsOf,
  labelled,
  outcomeOf,
  readWithout,
  sheet,
  sheetOf,
  sheetOfRows,
} from './generation-columns-helpers.js';

const header2023 = 'Предмет (2023)';
const header2018 = 'Предмет (2018)';
const header2013 = 'Предмет (2013)';

const dataset = lifecycleDataset();

const contentOf = async (workbook: ExcelJS.Workbook) =>
  readWorkbookContent(await reloaded(workbook));

// The synthetic workbook with its Еквиваленции column of that header
// deleted, as read.
const readWithoutColumn = (header: string) =>
  contentOf(withoutColumn(syntheticWorkbook(dataset), { header, sheet }));

const membersOf = (plan: ReturnType<typeof planImport>) =>
  plan.collections.find(
    ({ collection }) => collection === 'course_equivalency_members',
  )?.rows ?? [];

const of2013 = ({ record }: PlannedRow): boolean =>
  isDeepStrictEqual(
    record['generation'],
    ref('curriculum_generations', '2013'),
  );

describe('the Еквиваленции sheet', () => {
  test('is read as one label column per workbook generation, newest first, headed "Предмет (<code>)", into the generation equivalency column', () => {
    const spec = equivalencySpec();

    expect(spec.source).toEqual({ kind: 'generation-columns', sheet });
    expect(spec.fields.map(({ source, target }) => [source, target])).toEqual(
      workbookGenerations
        .toReversed()
        .map(({ code, equivalencyColumn }) => [
          headerOf(code),
          equivalencyColumn,
        ]),
    );
  });

  test('reads each generation column by its header, in any order, and skips an empty or blank header cell over a blank column', () => {
    const headers = [header2018, '', header2013, ' ', header2023];
    const items = itemsOf(
      sheetOf(headers, [{ ...labelled(generationHeaders, 2), '': '  ' }]),
    );

    expect(items).toEqual([
      {
        course_2013: `Label 2 ${header2013}`,
        course_2018: `Label 2 ${header2018}`,
        course_2023: `Label 2 ${header2023}`,
      },
    ]);
  });

  test('reads a missing column of a label-only generation as empty and refuses a missing column of a generation with a curriculum, as each generation states', () => {
    const outcomes = workbookGenerations.map(
      (generation) => [generation.code, readWithout(generation)] as const,
    );

    expect(outcomes).toEqual([
      ['2013', [null]],
      ['2018', 'Еквиваленции row 1: missing column "Предмет (2018)"'],
      ['2023', 'Еквиваленции row 1: missing column "Предмет (2023)"'],
    ]);
    expect(
      outcomes.flatMap(([code, outcome]) =>
        typeof outcome === 'string' ? [] : [code],
      ),
    ).toEqual(
      workbookGenerations.flatMap(({ code, has_curriculum }) =>
        has_curriculum ? [] : [code],
      ),
    );
  });

  test('refuses a header that names no known generation, with its column, before a missing column', () => {
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [
        [...generationHeaders, 'Предмет (2028)'],
        'Еквиваленции row 1, column 4: header "Предмет (2028)" names no known generation',
      ],
      [
        [header2023, 'Белешка', header2018],
        'Еквиваленции row 1, column 2: header "Белешка" names no known generation',
      ],
      [
        [header2023, `${header2018} `, header2013],
        'Еквиваленции row 1, column 2: header "Предмет (2018) " names no known generation',
      ],
      [
        [header2023, 'Предмет (2012)'],
        'Еквиваленции row 1, column 2: header "Предмет (2012)" names no known generation',
      ],
      [
        [
          header2023,
          header2018,
          'Предмет (2013), избришан во вечерниот извоз на табелата',
        ],
        'Еквиваленции row 1, column 3: header "Предмет (2013), избришан во вечерниот из" names no known generation',
      ],
    ];
    for (const [headers, message] of cases) {
      expect(outcomeOf(() => itemsOf(sheetOf(headers)))).toBe(message);
    }
  });

  test('refuses a filled cell in a column without a header, at its first filled row, after a missing column', () => {
    const cases: ReadonlyArray<
      readonly [ReadonlyArray<ReadonlyArray<null | string>>, string]
    > = [
      [
        [
          [header2023, header2018, null],
          ['A', 'B', 'C'],
        ],
        'Еквиваленции row 2, column 3: not empty under an empty header',
      ],
      [
        [generationHeaders, ['A', null, null], [null, null, null, 'D']],
        'Еквиваленции row 3, column 4: not empty under an empty header',
      ],
      [
        [generationHeaders, ['A', null, null, null, 'E']],
        'Еквиваленции row 2, column 5: not empty under an empty header',
      ],
      [
        [
          [header2023, ' ', header2018],
          ['A', '  ', 'B'],
          ['C', 'D', null],
        ],
        'Еквиваленции row 3, column 2: not empty under an empty header',
      ],
      [
        [
          [header2023, null],
          ['A', 'B'],
        ],
        `Еквиваленции row 1: missing column "${header2018}"`,
      ],
    ];
    for (const [rows, message] of cases) {
      expect(outcomeOf(() => itemsOf(sheetOfRows(rows)))).toBe(message);
    }
  });
});

describe('the synthetic workbook without the 2013 column', () => {
  test('reads as the workbook whose 2013 column is empty: no 2013 label, and a row that held only one not read', async () => {
    const read = await readWithoutColumn(header2013);
    const full = await contentOf(syntheticWorkbook(dataset));
    const cleared = await contentOf(
      syntheticWorkbook({
        ...dataset,
        course_equivalencies: dataset.course_equivalencies.map((row) => ({
          ...row,
          course_2013: null,
        })),
      }),
    );
    const kept = full.data.course_equivalencies.flatMap((row, index) =>
      row['course_2023'] === null && row['course_2018'] === null ? [] : [index],
    );

    expect(read).toEqual(cleared);
    expect(read.data.course_equivalencies).toEqual(
      kept.map((index) => ({
        ...full.data.course_equivalencies[index],
        course_2013: null,
      })),
    );
    expect(read.places.course_equivalencies).toEqual(
      kept.map((index) => full.places.course_equivalencies[index]),
    );
    expect(kept).toHaveLength(full.data.course_equivalencies.length - 1);
    expect({ ...read.data, course_equivalencies: [] }).toEqual({
      ...full.data,
      course_equivalencies: [],
    });
  });

  test('plans without a blocking case and without 2013 members, every other member as with the column', async () => {
    const plan = planImport(await readWithoutColumn(header2013));
    const full = planImport(await contentOf(syntheticWorkbook(dataset)));

    expect(countByCode(plan.blockers)).toEqual({});
    expect(countByCode(full.blockers)).toEqual({});
    expect(membersOf(plan).filter((row) => of2013(row))).toEqual([]);
    expect(membersOf(full).filter((row) => of2013(row))).not.toEqual([]);
    expect(membersOf(plan)).toEqual(
      membersOf(full).filter((row) => !of2013(row)),
    );
  });

  test('fails at its first 2013 label when the 2013 header is cleared and its labels kept', async () => {
    const full = await contentOf(syntheticWorkbook(dataset));
    const first = full.data.course_equivalencies.findIndex(
      (item) => item['course_2013'] !== null,
    );
    const row = full.places.course_equivalencies[first]?.row;
    const column = generationHeaders.indexOf(header2013) + 1;

    expect(row).toBeTypeOf('number');
    await expect(
      contentOf(
        withHeaderCleared(syntheticWorkbook(dataset), {
          header: header2013,
          sheet,
        }),
      ),
    ).rejects.toThrow(
      new WorkbookDataError(
        `Еквиваленции row ${String(row)}, column ${String(column)}: not empty under an empty header`,
      ),
    );
  });

  test('fails without the column of a generation with a curriculum', async () => {
    await expect(readWithoutColumn(header2018)).rejects.toThrow(
      new WorkbookDataError(
        `Еквиваленции row 1: missing column "${header2018}"`,
      ),
    );
    await expect(readWithoutColumn(header2023)).rejects.toThrow(
      new WorkbookDataError(
        `Еквиваленции row 1: missing column "${header2023}"`,
      ),
    );
  });
});
