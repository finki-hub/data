import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { CourseCandidate } from '../src/import/candidates.js';
import type { CourseRow } from '../src/import/workbook-rows.js';

import {
  defaultPattern,
  defaultYearPattern,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import {
  planPatternMappings,
  withoutLineBreaks,
} from '../src/import/pattern-mappings.js';
import {
  lineSets,
  PatternConversionError,
  type PatternCourse,
  provePatternMappings,
} from '../src/import/pattern-proof.js';
import { planned } from '../src/import/planned.js';

// The planner's input for a few courses: their rows, their candidates
// (a typed cell per given year, numbered in course and then year order,
// the default elsewhere) and the Moodle users' histories.

const years = ['2025/2026', '2024/2025', '2023/2024', '2022/2023'];
const newest = '2025/2026';

type CourseSpec = {
  readonly cells?: Readonly<Record<string, string>>;
  readonly name: string;
};

const noLink = { matches: [], precedent: null, resolution: 'none' } as const;

const courseRow = (id: number, name: string): CourseRow => ({
  available_2018: null,
  available_2023: null,
  credits_2018: null,
  credits_2023: null,
  export_assistants: null,
  id,
  name,
  name_2018_override: null,
  name_2023: null,
  typed_professors: null,
});

const candidatesOf = (courses: readonly CourseSpec[]): CourseCandidate[] => {
  let row = 0;
  return courses.map(({ cells = {}, name }, index) => ({
    current: noLink,
    id: index + 1,
    legacy: { entry: noLink, equivalencies: noLink, source: 'none' },
    rules: years.map((academicYear) => {
      const pattern = cells[academicYear];
      if (pattern === undefined) {
        return {
          academicYear,
          overrides: [],
          pattern: `${name}-${academicYear}`,
          source: 'default',
          valid: true,
        } as const;
      }
      row += 1;
      return {
        academicYear,
        overrides: [row],
        pattern,
        source: 'override',
        valid: true,
      } as const;
    }),
    teaching: { links: [], source: null, status: 'active' },
  }));
};

const planFor = (
  courses: readonly CourseSpec[],
  histories: readonly string[],
) =>
  planPatternMappings({
    academicYears: years,
    candidates: candidatesOf(courses),
    courses: courses.map(({ name }, index) => courseRow(index + 1, name)),
    users: histories.map((Courses, index) => planned(index + 1, { Courses })),
  });

const plannedRecord = z.object({
  course: z.object({ collection: z.literal('courses'), key: z.string() }),
  only_in_year: z
    .object({ collection: z.literal('academic_years'), key: z.string() })
    .nullable(),
  pattern: z.string(),
  year_pattern: z.string().nullable(),
});

// The planned mappings, each as `<pattern> :: <year pattern or year>`.
const mappingsOf = (plan: ReturnType<typeof planFor>): readonly string[] =>
  plan.rows.map(({ record }) => {
    const parsed = plannedRecord.parse(record);
    const year = `only ${parsed.only_in_year?.key ?? ''}`;
    return `${parsed.pattern} :: ${parsed.year_pattern ?? year}`;
  });

const findingsOf = (plan: ReturnType<typeof planFor>, code: string) =>
  plan.findings
    .filter((finding) => finding.code === code)
    .map(({ academicYear, ids }) => ({ academicYear, ids }));

const standard = (name: string): string =>
  `${defaultPattern(name)} :: ${defaultYearPattern}`;

describe('the standard mapping', () => {
  test("is every course's escaped name and `-`, with the default year pattern", () => {
    const plan = planFor(
      [{ name: 'C++ (напредно)' }, { name: 'Алфа' }],
      ['C++ (напредно)-2024/2025/Z', 'Cxx (напредно)-2024/2025/Z'],
    );

    expect(mappingsOf(plan)).toEqual([
      String.raw`C\+\+ \(напредно\)- :: (?<start>\d{4})/(?<end>\d{4})`,
      standard('Алфа'),
    ]);
    expect(plan.findings).toEqual([]);
  });
});

describe('typed cells', () => {
  test('lose their line breaks, each removal a rule fix placed by its cell', () => {
    expect(withoutLineBreaks('Бета Спец|\r\nБета Посебен\n')).toBe(
      'Бета Спец|Бета Посебен',
    );

    const plan = planFor(
      [{ cells: { '2024/2025': 'Бета Спец|\nБета Посебен' }, name: 'Бета' }],
      ['Бета Спец 1', 'Бета Посебен 2'],
    );

    expect(mappingsOf(plan)).toEqual([
      standard('Бета'),
      'Бета Спец|Бета Посебен :: only 2024/2025',
    ]);
    expect(findingsOf(plan, 'pattern_line_break')).toEqual([
      { academicYear: '2024/2025', ids: [1] },
    ]);
  });

  test('are skipped when they count what the standard mapping counts in their year, matching a line or none', () => {
    const plan = planFor(
      [
        {
          cells: {
            '2023/2024': 'Гама Стар-2023/2024',
            '2024/2025': 'Гама-2024/2025',
          },
          name: 'Гама',
        },
      ],
      ['Гама-2024/2025/Z', 'Гама-2022/2023/Z'],
    );

    expect(mappingsOf(plan)).toEqual([standard('Гама')]);
    expect(findingsOf(plan, 'redundant_pattern')).toEqual([
      { academicYear: undefined, ids: [1] },
      { academicYear: undefined, ids: [2] },
    ]);
  });
});

describe('a conversion', () => {
  test('of kind A joins the text before the year to the standard mapping', () => {
    const plan = planFor(
      [
        {
          cells: {
            '2023/2024': 'Делта-2023/2024|Delta-2023/2024',
            '2024/2025': 'Делта-2024/2025|Delta-2024/2025',
          },
          name: 'Делта',
        },
      ],
      [
        'Делта-2024/2025/Z',
        'Delta-2024/2025/Z',
        'Делта-2023/2024/Z',
        'Delta-2023/2024/L',
        'Делта-2025/2026/Z',
      ],
    );

    expect(mappingsOf(plan)).toEqual([
      `Делта-|Delta- :: ${defaultYearPattern}`,
    ]);
    expect(plan.conversions).toMatchObject([{ group: 2, kind: 'A', pass: 1 }]);
    expect(findingsOf(plan, 'merged_pattern')).toHaveLength(2);
  });

  test('of kind B keeps the text after the year where kind A would count another year', () => {
    const plan = planFor(
      [
        {
          cells: {
            '2023/2024': 'Зета Лаб 2023/2024 Z',
            '2024/2025': 'Зета Лаб 2024/2025 Z',
          },
          name: 'Зета',
        },
      ],
      ['Зета Лаб 2024/2025 Z', 'Зета Лаб 2023/2024 Z', 'Зета Лаб 2022/2023 L'],
    );

    expect(mappingsOf(plan)).toEqual([
      String.raw`Зета-|Зета Лаб \d{4}/\d{4} Z :: ${defaultYearPattern}`,
    ]);
    expect(plan.conversions).toMatchObject([{ kind: 'B', pass: 1 }]);
  });

  test("takes the year pattern from the lines' form, not the cell's", () => {
    const plan = planFor(
      [
        {
          cells: { '2023/2024': 'Тета Т-2023', '2024/2025': 'Тета Т-2024' },
          name: 'Тета',
        },
      ],
      ['Тета Т-2024/2025/Z', 'Тета Т-2023/2024/Z'],
    );

    expect(mappingsOf(plan)).toEqual([
      `Тета-|Тета Т- :: ${defaultYearPattern}`,
    ]);
  });

  test('joins two runs with one year pattern into one mapping', () => {
    const plan = planFor(
      [
        {
          cells: {
            '2022/2023': 'Ламбда-2022/2023|Лмб-2022/2023',
            '2023/2024': 'Ламбда-2023/2024|Lambda-2023/2024',
            '2024/2025': 'Ламбда-2024/2025|Lambda-2024/2025',
          },
          name: 'Ламбда',
        },
      ],
      [
        'Ламбда-2024/2025/Z',
        'Lambda-2024/2025/Z',
        'Lambda-2023/2024/Z',
        'Лмб-2022/2023/Z',
      ],
    );

    expect(mappingsOf(plan)).toEqual([
      `Ламбда-|Lambda-|Лмб- :: ${defaultYearPattern}`,
    ]);
    expect(plan.conversions).toMatchObject([
      { group: 2, kind: 'A', pass: 1 },
      { group: 1, kind: 'A', pass: 1 },
    ]);
  });

  test("puts a covering branch in place of the course's own name, and adds no covered branch nor one that counts no line", () => {
    const plan = planFor(
      [
        {
          cells: {
            '2024/2025': 'Машинска визија 2024/2025|Nu-2024/2025',
          },
          name: 'Машинска визија',
        },
        {
          cells: {
            '2024/2025': 'Ни-2024/2025|Nu-2024/2025|Ни Лаб-2024/2025',
          },
          name: 'Ни',
        },
      ],
      [
        'Машинска визија 2024/2025',
        'Машинска визија-2023/2024/Z',
        'Ни-2024/2025/Z',
        'Ни Лаб-2024/2025/Z',
      ],
    );

    expect(mappingsOf(plan)).toEqual([
      `Машинска визија :: ${defaultYearPattern}`,
      `Ни-|Ни Лаб- :: ${defaultYearPattern}`,
    ]);
  });

  test('converts part of a group when the generalisation changes one of its years', () => {
    const plan = planFor(
      [
        {
          cells: {
            '2022/2023': 'Ро-2022/2023|Rho-2022/2023',
            '2023/2024': 'Ро-2023/2024|Rho-2023/2024',
            '2024/2025': 'Ро-2024/2025|Rho-2024/2025',
          },
          name: 'Ро',
        },
      ],
      [
        'Rho-2024/2025/Z',
        'Rho-2023/2024/Z',
        'Rho-2022/2023/Z',
        'Rho-X-2022/2023',
      ],
    );

    expect(mappingsOf(plan)).toEqual([
      `Ро-|Rho- :: ${defaultYearPattern}`,
      'Ро-2022/2023|Rho-2022/2023 :: only 2022/2023',
    ]);
    expect(plan.conversions).toMatchObject([{ group: 3, kind: 'A', pass: 1 }]);
    expect(
      plan.conversions[0]?.cells.map(({ academicYear }) => academicYear),
    ).toEqual(['2024/2025', '2023/2024']);
  });

  test('converts in pass 2 two cells with different templates that need one new year pattern', () => {
    const plan = planFor(
      [
        {
          cells: {
            '2023/2024': 'Сигма 2023-2024',
            '2025/2026': 'Сигма_2025-2026',
          },
          name: 'Сигма',
        },
      ],
      ['Сигма_2025-2026', 'Сигма 2023-2024'],
    );

    expect(mappingsOf(plan)).toEqual([
      standard('Сигма'),
      String.raw`Сигма :: (?<start>\d{4})-(?<end>\d{4})`,
    ]);
    expect(plan.conversions).toMatchObject([{ group: 2, kind: 'A', pass: 2 }]);
  });
});

describe('a cell kept only in its year', () => {
  test('spills: every generalisation also counts a line of an older year without a typed cell', () => {
    const plan = planFor(
      [{ cells: { '2024/2025': 'Кси-2024/2025|Xi-2024/2025' }, name: 'Кси' }],
      ['Кси-2024/2025/Z', 'Xi-2024/2025/Z', 'Xi-2023/2024/L'],
    );

    expect(mappingsOf(plan)).toEqual([
      standard('Кси'),
      'Кси-2024/2025|Xi-2024/2025 :: only 2024/2025',
    ]);
    expect(plan.conversions).toEqual([]);
  });

  test('gains nothing alone: a mapping of its own year pattern would replace it one for one', () => {
    const plan = planFor(
      [{ cells: { '2024/2025': 'Омикрон 2024-2025' }, name: 'Омикрон' }],
      ['Омикрон 2024-2025'],
    );

    expect(mappingsOf(plan)).toEqual([
      standard('Омикрон'),
      'Омикрон 2024-2025 :: only 2024/2025',
    ]);
  });
});

// Тау's cells name an English line beside its own, and Moodle holds an
// English line of the newest year too.
const tau = (cells: Readonly<Record<string, string>>) =>
  planFor(
    [{ cells, name: 'Тау' }],
    [
      'Тау-2024/2025/Z',
      'Tau-2024/2025/Z',
      'Тау-2023/2024/Z',
      'Tau-2023/2024/Z',
      'Tau-2025/2026/Z',
    ],
  );
const english = {
  '2023/2024': 'Тау-2023/2024|Tau-2023/2024',
  '2024/2025': 'Тау-2024/2025|Tau-2024/2025',
};

describe('the newest workbook year (decision B)', () => {
  test('may count more for a course without a typed cell in it, each such year a rule fix', () => {
    const plan = tau(english);

    expect(mappingsOf(plan)).toEqual([`Тау-|Tau- :: ${defaultYearPattern}`]);
    expect(findingsOf(plan, 'newest_year_widened')).toEqual([
      { academicYear: newest, ids: [1] },
    ]);
  });

  test('is compared like any other year for a course with a typed cell in it', () => {
    const plan = tau({ ...english, [newest]: 'Тау-2025/2026' });

    expect(mappingsOf(plan)).toEqual([
      standard('Тау'),
      'Тау-2024/2025|Tau-2024/2025 :: only 2024/2025',
      'Тау-2023/2024|Tau-2023/2024 :: only 2023/2024',
    ]);
    expect(findingsOf(plan, 'newest_year_widened')).toEqual([]);
    expect(findingsOf(plan, 'redundant_pattern')).toEqual([
      { academicYear: undefined, ids: [1] },
    ]);
  });
});

describe('the plan rows', () => {
  test('give each all-years mapping a year pattern and no year, and each only-in-year mapping a year and no year pattern', () => {
    const plan = planFor(
      [{ cells: { '2024/2025': 'Кси-2024/2025|Xi-2024/2025' }, name: 'Кси' }],
      ['Кси-2024/2025/Z', 'Xi-2024/2025/Z', 'Xi-2023/2024/L'],
    );

    expect(
      plan.rows.map(({ key, origin, record }) => ({ key, origin, record })),
    ).toEqual([
      {
        key: '1\u{0}1',
        origin: { id: 1, source: 'courses' },
        record: {
          course: { collection: 'courses', key: '1' },
          only_in_year: null,
          pattern: 'Кси-',
          year_pattern: defaultYearPattern,
        },
      },
      {
        key: '1\u{0}2',
        origin: { id: 1, source: 'course_enrollment_patterns' },
        record: {
          course: { collection: 'courses', key: '1' },
          only_in_year: { collection: 'academic_years', key: '2024/2025' },
          pattern: 'Кси-2024/2025|Xi-2024/2025',
          year_pattern: null,
        },
      },
    ]);
  });
});

describe('the proof', () => {
  const sets = lineSets(['Фи-2025/2026/Z', 'Фи-2024/2025/Z'], years);
  const course: PatternCourse = { cells: new Map(), id: 1, name: 'Фи' };

  test('passes when every compared year counts exactly the design', () => {
    expect(
      provePatternMappings(sets, [
        {
          course,
          mappings: {
            allYears: new Map([[defaultYearPattern, ['Фи-']]]),
            onlyInYear: new Map(),
          },
        },
      ]),
    ).toEqual([]);
  });

  test('fails a compared year that loses a line, and a newest year that loses one', () => {
    const broken = (onlyInYear: ReadonlyMap<string, string>) => () =>
      provePatternMappings(sets, [
        {
          course,
          mappings: {
            allYears: new Map([[defaultYearPattern, ['Фи-']]]),
            onlyInYear,
          },
        },
      ]);

    expect(broken(new Map([['2024/2025', 'Хи']]))).toThrow(
      new PatternConversionError(
        'pattern conversion "Фи" 2024/2025: line set mismatch',
      ),
    );
    expect(broken(new Map([[newest, 'Хи']]))).toThrow(
      'pattern conversion "Фи" 2025/2026: line set mismatch',
    );
  });
});
