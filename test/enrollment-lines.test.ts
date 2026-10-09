import { describe, expect, test } from 'vitest';

import {
  type CountedLine,
  countPairs,
  defaultPattern,
  defaultYearPattern,
  lineYear,
  type PatternMapping,
  patternProblem,
  resolveLines,
  yearPatternProblem,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { lineYearVectors } from './line-year-vectors.js';

// The counting rules of ext/enrollment-lines.ts on small hand-made inputs:
// three academic years, courses 10, 20 and 30, and history lines numbered
// from 1 in the order given.

const math1 = 'Математика 1-';
const metacharacterNames = String.raw`\ . * + ? ^ $ { } ( ) | [ ]`.split(' ');
const noGroup = 'no group named start or end';

const years = [
  { id: 1, label: '2023/2024' },
  { id: 2, label: '2024/2025' },
  { id: 3, label: '2025/2026' },
];

const lines = (...labels: readonly string[]) =>
  labels.map((label, index) => ({ id: index + 1, label }));

// An all-years mapping with the default year pattern.
const allYears = (
  id: number,
  course: number,
  pattern: string,
): PatternMapping => ({
  course,
  id,
  onlyInYear: null,
  pattern,
  yearPattern: defaultYearPattern,
});

// The same mapping counting only in one academic year.
const onlyIn = (mapping: PatternMapping, year: number): PatternMapping => ({
  ...mapping,
  onlyInYear: year,
  yearPattern: null,
});

// A counted row of a pattern mapping: line, [course, year], mapping.
const counted = (
  entry: number,
  [course, academicYear]: readonly [number, number],
  patternMapping: number,
): CountedLine => ({
  academicYear,
  course,
  entry,
  patternMapping,
  source: 'pattern',
});

const explicitRow = (
  entry: number,
  [course, academicYear]: readonly [number, number],
): CountedLine => ({
  academicYear,
  course,
  entry,
  patternMapping: null,
  source: 'explicit',
});

// The counted lines of pattern mappings alone.
const resolved = (
  labels: readonly string[],
  mappings: readonly PatternMapping[],
): CountedLine[] =>
  resolveLines({ explicit: [], lines: lines(...labels), mappings, years });

const refusalOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('The resolution answered instead of failing');
};

// The message resolveLines fails with on these mappings and no line.
const failureOf = (mappings: readonly PatternMapping[]): string =>
  refusalOf(() => resolveLines({ explicit: [], lines: [], mappings, years }));

describe('defaultYearPattern', () => {
  test('reads both years of the YYYY/YYYY form and is a valid year pattern', () => {
    expect(defaultYearPattern).toBe(String.raw`(?<start>\d{4})/(?<end>\d{4})`);
    expect(yearPatternProblem(defaultYearPattern)).toBeNull();
    expect(lineYear(defaultYearPattern, 'Математика 1-2025/2026/Z')).toBe(
      '2025/2026',
    );
  });
});

describe('defaultPattern', () => {
  test('appends a dash to a name without metacharacters', () => {
    expect(defaultPattern('Математика 1')).toBe(math1);
    expect(defaultPattern('Компјутерски звук, музика и говор')).toBe(
      'Компјутерски звук, музика и говор-',
    );
    expect(defaultPattern('Веб дизајн - напредно / 2')).toBe(
      'Веб дизајн - напредно / 2-',
    );
  });

  test('escapes every regular expression metacharacter', () => {
    expect(defaultPattern(String.raw`a.b*c+d?e^f$g{h}i(j)k|l[m]n\o`)).toBe(
      String.raw`a\.b\*c\+d\?e\^f\$g\{h\}i\(j\)k\|l\[m\]n\\o-`,
    );
    expect(defaultPattern('C++ (напредно)')).toBe(
      String.raw`C\+\+ \(напредно\)-`,
    );
    expect(patternProblem('C++ (напредно)-')).toBe('Nothing to repeat');
  });

  // Each metacharacter alone, and all of them in a row.
  test.each([...metacharacterNames, metacharacterNames.join('')])(
    'the default pattern of %j compiles and counts only its own line',
    (name) => {
      expect(patternProblem(defaultPattern(name))).toBeNull();
      expect(
        resolved(
          [`${name}-2025/2026/Z`, 'Физика-2025/2026/Z', `${name}2025/2026/Z`],
          [allYears(1, 10, defaultPattern(name))],
        ),
      ).toEqual([counted(1, [10, 3], 1)]);
    },
  );

  test('a name such as "C++ (напредно)" counts only lines that carry it', () => {
    const rows = resolved(
      [
        'C++ (напредно)-2025/2026/Z',
        'C (напредно)-2025/2026/Z',
        'CCC напредно-2025/2026/Z',
        'C++ напредно-2025/2026/Z',
        'C++ (напредно) 2025/2026',
        'ССП - C++ (напредно)-2024/2025/L',
      ],
      [allYears(1, 10, defaultPattern('C++ (напредно)'))],
    );

    expect(rows).toEqual([counted(1, [10, 3], 1), counted(6, [10, 2], 1)]);
  });
});

describe('lineYear', () => {
  test.each(lineYearVectors)(
    '%s on %j reads %j',
    (yearPattern, label, year) => {
      expect(lineYear(yearPattern, label)).toBe(year);
    },
  );

  test('every vector year pattern is a valid year pattern', () => {
    expect(
      lineYearVectors.filter(
        ([yearPattern]) => yearPatternProblem(yearPattern) !== null,
      ),
    ).toEqual([]);
  });
});

describe('patternProblem', () => {
  test('accepts a pattern that compiles with the u flag', () => {
    expect(patternProblem('^Математика 2-')).toBeNull();
    expect(patternProblem('Сајбер безбедност-|Мрежна безбедност-')).toBeNull();
  });

  test('gives the reason without the pattern it quotes', () => {
    expect(patternProblem('Тајно име: (')).toBe('Unterminated group');
    expect(patternProblem('C++')).toBe('Nothing to repeat');
    // An identity escape compiles without the u flag and is refused with it.
    expect(patternProblem(String.raw`Веб\-програмирање`)).toBe(
      'Invalid escape',
    );
  });
});

describe('yearPatternProblem', () => {
  test.each([
    String.raw`(?<start>\d{4})`,
    String.raw`(?<end>\d{4})`,
    String.raw`(?<start>\d{4})-(?<end>\d{2})`,
    String.raw`x(?<start>\d{4})`,
    String.raw`(?:a|(?<end>\d{2}))`,
  ])('accepts %s', (yearPattern) => {
    expect(yearPatternProblem(yearPattern)).toBeNull();
  });

  test.each([
    [String.raw`(?<start>\d{4}`, 'Unterminated group'],
    [String.raw`\d{4}/\d{4}`, noGroup],
    [String.raw`(\d{4})/(\d{4})`, noGroup],
    [String.raw`(?<year>\d{4})`, noGroup],
    [String.raw`(?<Start>\d{4})`, noGroup],
    ['', noGroup],
  ])('refuses %j: %s', (yearPattern, problem) => {
    expect(yearPatternProblem(yearPattern)).toBe(problem);
  });
});

describe('resolveLines', () => {
  test('^ means the start of each line (the Математика 2 case)', () => {
    const rows = resolved(
      [
        'Физика-2024/2025/Z',
        'Математика 2-2024/2025/L',
        'ССП - Математика 2-2024/2025/L',
      ],
      [allYears(1, 20, '^Математика 2-')],
    );

    expect(rows).toEqual([counted(2, [20, 2], 1)]);
    // The line is second in its user's history, where a test of the whole
    // history against ^ would not find it.
    expect(
      countPairs({
        counted: rows,
        courses: [{ id: 20 }],
        memberships: [
          { entry: 1, moodleUser: 100 },
          { entry: 2, moodleUser: 100 },
        ],
        years: [{ id: 2 }],
      }),
    ).toEqual([{ academicYear: 2, count: 1, course: 20 }]);
  });

  test('an all-years mapping counts in the year it reads, and nowhere without one', () => {
    const rows = resolved(
      [
        'Математика 1-2025/2026/Z',
        'Математика 1-2023/2024/L',
        'Математика 1-2030/2031/Z',
        'Математика 1-2025/2027/Z',
        'Математика 1',
      ],
      [allYears(1, 10, math1)],
    );

    expect(rows).toEqual([counted(1, [10, 3], 1), counted(2, [10, 1], 1)]);
  });

  test('a year pattern of another form reads its own lines', () => {
    const mapping = {
      ...allYears(4, 10, 'Компјутерски компоненти'),
      yearPattern: String.raw`(?<start>\d{4})-(?<end>\d{4})`,
    };

    expect(
      resolved(
        [
          'Компјутерски компоненти 2024-2025',
          'Компјутерски компоненти-2024/2025/L',
        ],
        [mapping],
      ),
    ).toEqual([counted(1, [10, 2], 4)]);
  });

  test('an explicit mapping replaces every pattern mapping for its line', () => {
    const rows = resolveLines({
      explicit: [{ academicYear: 2, course: 30, entry: 1 }],
      lines: lines('Mathematics 1-2025/2026/Z', 'Mathematics 1-2024/2025/L'),
      mappings: [
        allYears(1, 10, 'Mathematics 1-'),
        allYears(2, 20, 'Mathematics'),
      ],
      years,
    });

    expect(rows).toEqual([
      explicitRow(1, [30, 2]),
      counted(2, [10, 2], 1),
      counted(2, [20, 2], 2),
    ]);
  });

  test('explicit mappings count their line for each of their pairs, matched or not', () => {
    expect(
      resolveLines({
        explicit: [
          { academicYear: 3, course: 20, entry: 2 },
          { academicYear: 1, course: 10, entry: 2 },
        ],
        lines: lines('Физика-2025/2026/Z', 'ВЕЗИЛКА'),
        mappings: [],
        years,
      }),
    ).toEqual([explicitRow(2, [10, 1]), explicitRow(2, [20, 3])]);
  });

  test('an only-in-year mapping replaces the all-years mappings of its course in its year only', () => {
    const rows = resolved(
      [
        'Математика 1-2025/2026/Z',
        'Калкулус-2025/2026/Z',
        'Математика 1-2024/2025/Z',
        'Калкулус-2024/2025/L',
      ],
      [
        allYears(1, 10, math1),
        onlyIn(allYears(2, 10, 'Калкулус-'), 3),
        allYears(3, 20, math1),
      ],
    );

    expect(rows).toEqual([
      // Course 10 counts its 2025/2026 line only through Калкулус-.
      counted(1, [20, 3], 3),
      counted(2, [10, 3], 2),
      counted(3, [10, 2], 1),
      counted(3, [20, 2], 3),
      // The only-in-year mapping counts its line whatever year it shows.
      counted(4, [10, 3], 2),
    ]);
  });

  test('an only-in-year mapping that matches nothing still empties its year', () => {
    expect(
      resolved(
        ['Математика 1-2023/2024/Z', 'Математика 1-2024/2025/Z'],
        [allYears(1, 10, math1), onlyIn(allYears(2, 10, 'Калкулус-'), 1)],
      ),
    ).toEqual([counted(2, [10, 2], 1)]);
  });

  test('one line counts for several courses, and once per mapping', () => {
    expect(
      resolved(
        ['Сајбер безбедност-2025/2026/L'],
        [
          allYears(1, 10, 'Сајбер безбедност-'),
          allYears(2, 20, 'безбедност-'),
          allYears(3, 10, 'Сајбер'),
        ],
      ),
    ).toEqual([
      counted(1, [10, 3], 1),
      counted(1, [10, 3], 3),
      counted(1, [20, 3], 2),
    ]);
  });

  test('a course without a counted line gives no row', () => {
    expect(resolved(['ВЕЗИЛКА'], [allYears(1, 10, math1)])).toEqual([]);
    expect(
      resolveLines({ explicit: [], lines: [], mappings: [], years }),
    ).toEqual([]);
  });
});

describe('resolveLines failures', () => {
  test.each([
    [
      { ...allYears(7, 10, 'Тајно име: ('), onlyInYear: null },
      'Pattern mapping 7: invalid regular expression (Unterminated group)',
    ],
    [
      {
        ...allYears(8, 10, math1),
        yearPattern: String.raw`(?<start>\d{4})**`,
      },
      'Pattern mapping 8: invalid year pattern (Nothing to repeat)',
    ],
    [
      { ...allYears(9, 10, math1), yearPattern: String.raw`\d{4}` },
      'Pattern mapping 9: invalid year pattern (no group named start or end)',
    ],
    [
      { ...allYears(4, 10, math1), onlyInYear: 3 },
      'Pattern mapping 4: expected exactly one of year_pattern, only_in_year',
    ],
    [
      { ...allYears(5, 10, math1), yearPattern: null },
      'Pattern mapping 5: expected exactly one of year_pattern, only_in_year',
    ],
    // The database CHECKs refuse these too; the matcher script refuses them
    // with the same text.
    [allYears(6, 10, ''), 'Pattern mapping 6: pattern missing'],
    [
      { ...allYears(11, 10, math1), yearPattern: '' },
      'Pattern mapping 11: expected exactly one of year_pattern, only_in_year',
    ],
    [
      { ...allYears(12, 10, math1), onlyInYear: 3, yearPattern: '' },
      'Pattern mapping 12: expected exactly one of year_pattern, only_in_year',
    ],
    [
      onlyIn(allYears(13, 10, math1), 0),
      'Pattern mapping 13: expected exactly one of year_pattern, only_in_year',
    ],
    [
      onlyIn(allYears(14, 10, math1), 2.5),
      'Pattern mapping 14: expected exactly one of year_pattern, only_in_year',
    ],
  ])(
    'fails on an unusable mapping, named by its id (%#)',
    (mapping, message) => {
      expect(
        refusalOf(() =>
          resolveLines({
            explicit: [],
            lines: lines('Математика 1-2025/2026/Z'),
            mappings: [allYears(1, 10, math1), mapping],
            years,
          }),
        ),
      ).toBe(message);
      // Without any line, the mapping is still compiled and refused.
      expect(
        refusalOf(() =>
          resolveLines({ explicit: [], lines: [], mappings: [mapping], years }),
        ),
      ).toBe(message);
    },
  );

  test("checks every mapping's fields before compiling any pattern", () => {
    expect(failureOf([allYears(7, 10, '('), allYears(8, 10, '')])).toBe(
      'Pattern mapping 8: pattern missing',
    );
    expect(
      failureOf([
        allYears(7, 10, '('),
        { ...allYears(8, 10, math1), onlyInYear: 3 },
      ]),
    ).toBe(
      'Pattern mapping 8: expected exactly one of year_pattern, only_in_year',
    );
    // Then mapping by mapping: the first that does not compile fails.
    expect(
      failureOf([
        { ...allYears(7, 10, math1), yearPattern: '(' },
        allYears(8, 10, '('),
      ]),
    ).toBe('Pattern mapping 7: invalid year pattern (Unterminated group)');
  });
});

describe('countPairs', () => {
  const courses = [{ id: 10 }, { id: 20 }, { id: 30 }];
  const pairYears = [{ id: 1 }, { id: 2 }];

  test('counts every course and year, in course then year order, 0 without a line', () => {
    expect(
      countPairs({ counted: [], courses, memberships: [], years: pairYears }),
    ).toEqual([
      { academicYear: 1, count: 0, course: 10 },
      { academicYear: 2, count: 0, course: 10 },
      { academicYear: 1, count: 0, course: 20 },
      { academicYear: 2, count: 0, course: 20 },
      { academicYear: 1, count: 0, course: 30 },
      { academicYear: 2, count: 0, course: 30 },
    ]);
  });

  test('counts distinct Moodle users holding a counted line', () => {
    const rows = [
      // Lines 1 and 2 both count for course 10 in year 1, line 2 twice.
      counted(1, [10, 1], 1),
      counted(2, [10, 1], 1),
      counted(2, [10, 1], 4),
      explicitRow(3, [20, 2]),
      // A course and a year not listed.
      counted(1, [40, 1], 9),
      counted(1, [10, 7], 1),
    ];
    const memberships = [
      { entry: 1, moodleUser: 100 },
      { entry: 2, moodleUser: 100 },
      { entry: 2, moodleUser: 101 },
      { entry: 3, moodleUser: 102 },
      // Line 4 counts nowhere.
      { entry: 4, moodleUser: 103 },
    ];

    expect(
      countPairs({ counted: rows, courses, memberships, years: pairYears }),
    ).toEqual([
      { academicYear: 1, count: 2, course: 10 },
      { academicYear: 2, count: 0, course: 10 },
      { academicYear: 1, count: 0, course: 20 },
      { academicYear: 2, count: 1, course: 20 },
      { academicYear: 1, count: 0, course: 30 },
      { academicYear: 2, count: 0, course: 30 },
    ]);
  });

  test('a line without a holder counts 0', () => {
    expect(
      countPairs({
        counted: [counted(5, [10, 1], 1)],
        courses: [{ id: 10 }],
        memberships: [{ entry: 6, moodleUser: 100 }],
        years: [{ id: 1 }],
      }),
    ).toEqual([{ academicYear: 1, count: 0, course: 10 }]);
  });
});
