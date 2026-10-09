import { describe, expect, test } from 'vitest';

import { defaultYearPattern } from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import {
  covers,
  joinAlternatives,
  withAlternatives,
} from '../src/import/pattern-join.js';
import {
  branchesOf,
  branchYearPattern,
  generalisedBranch,
  templateOf,
} from '../src/import/pattern-templates.js';
import { tokenYearPattern, yearTokens } from '../src/import/pattern-tokens.js';

const startYear = String.raw`(?<start>\d{4})`;
const endYear = String.raw`(?<end>\d{4})`;

// The years and written form of every token of a text.
const tokensIn = (text: string) =>
  yearTokens(text).map((token) => ({
    text: text.slice(token.at, token.end),
    years: token.years,
  }));

describe('year tokens', () => {
  test.each([
    ['Курс-20192020-Z', '20192020', [2_019, 2_020]],
    ['Курс-2019/2020/Z', '2019/2020', [2_019, 2_020]],
    ['Курс 2019-2020', '2019-2020', [2_019, 2_020]],
    [String.raw`Курс-2019\/2020`, String.raw`2019\/2020`, [2_019, 2_020]],
    ['Курс-2019/20', '2019/20', [2_019, 2_020]],
    ['Курс 2019-20', '2019-20', [2_019, 2_020]],
    ['КА-21/22', '21/22', [2_021, 2_022]],
    ['КА 21-22', '21-22', [2_021, 2_022]],
    ['Курс 2019', '2019', [2_019]],
  ])('reads %s as one token', (text, written, years) => {
    expect(tokensIn(text)).toEqual([{ text: written, years }]);
  });

  test('reads two years that do not follow each other as two single years', () => {
    expect(tokensIn('Курс 2019/2021')).toEqual([
      { text: '2019', years: [2_019] },
      { text: '2021', years: [2_021] },
    ]);
  });

  test('finds no token touching another digit, outside 1990-2049, or in two digits that do not follow each other', () => {
    for (const text of [
      'Курс-20192021',
      'Курс-120194',
      'Курс 1989',
      'Курс 2050',
      'КА-21/23',
      'Математика 1',
    ]) {
      expect(tokensIn(text)).toEqual([]);
    }
  });

  test('reads the tokens left to right, each the first rule that applies', () => {
    expect(tokensIn('Курс 2019-2020 (2019/20) 2021')).toEqual([
      { text: '2019-2020', years: [2_019, 2_020] },
      { text: '2019/20', years: [2_019, 2_020] },
      { text: '2021', years: [2_021] },
    ]);
  });
});

describe('the year pattern of a token', () => {
  test.each([
    ['20192020', String.raw`(?<start>\d{4})(?<end>\d{4})`],
    ['2019/2020', defaultYearPattern],
    ['2019-2020', String.raw`(?<start>\d{4})-(?<end>\d{4})`],
    [String.raw`2019\/2020`, defaultYearPattern],
    ['2019/20', String.raw`(?<start>\d{4})/(?<end>\d{2})`],
    ['2019-20', String.raw`(?<start>\d{4})-(?<end>\d{2})`],
    ['19/20', String.raw`(?<start>\d{2})/(?<end>\d{2})`],
    ['19-20', String.raw`(?<start>\d{2})-(?<end>\d{2})`],
    ['2019', startYear],
    ['2020', endYear],
  ])('reads %s of 2019/2020 with its own form', (text, yearPattern) => {
    const [token] = yearTokens(text);

    expect(token === undefined ? null : tokenYearPattern(token, 2_019)).toBe(
      yearPattern,
    );
  });

  test('is none for a token naming another year', () => {
    for (const text of ['2018/2019', '2021', '2018']) {
      const [token] = yearTokens(text);

      expect(
        token === undefined ? 'no token' : tokenYearPattern(token, 2_019),
      ).toBeNull();
    }
  });
});

describe('templates', () => {
  test('are equal for cells that differ only in their year', () => {
    expect(templateOf('Мрежна безбедност-2024/2025', 2_024)).toBe(
      templateOf('Мрежна безбедност-2019/2020', 2_019),
    );
    expect(templateOf('Компјутерски компоненти 2023', 2_023)).toBe(
      'Компјутерски компоненти {YYYY:0}',
    );
  });

  test('differ by the written form and by the year relative to the cell', () => {
    expect(templateOf('Курс-2024/2025', 2_024)).not.toBe(
      templateOf('Курс-2024-2025', 2_024),
    );
    expect(templateOf('Курс-2023/2024', 2_024)).not.toBe(
      templateOf('Курс-2024/2025', 2_024),
    );
  });
});

describe('branches', () => {
  test('split on | outside groups and classes, after unwrapping one capturing group', () => {
    expect(branchesOf('(Курс-2024/2025|Course-2024/2025)')).toEqual([
      'Курс-2024/2025',
      'Course-2024/2025',
    ]);
    expect(branchesOf(String.raw`(a)|(b|c)|[x|y]|\|z`)).toEqual([
      'a',
      'b|c',
      '[x|y]',
      String.raw`\|z`,
    ]);
  });

  test('keep a non-capturing group and two groups side by side', () => {
    expect(branchesOf('(?:a|b)')).toEqual(['(?:a|b)']);
    expect(branchesOf('(a)(b)')).toEqual(['(a)(b)']);
  });
});

describe('a generalised branch', () => {
  test('keeps the text before the token (kind A), without trailing white space', () => {
    expect(generalisedBranch('Мрежна безбедност-2024/2025', 2_024, 'A')).toBe(
      'Мрежна безбедност-',
    );
    expect(generalisedBranch('Компјутерски компоненти 2024', 2_024, 'A')).toBe(
      'Компјутерски компоненти',
    );
  });

  test('puts the digit class of the token in its place (kind B)', () => {
    expect(generalisedBranch('Курс-2024/2025/Z', 2_024, 'B')).toBe(
      String.raw`Курс-\d{4}/\d{4}/Z`,
    );
    expect(generalisedBranch('Курс-20242025-Z', 2_024, 'B')).toBe(
      String.raw`Курс-\d{8}-Z`,
    );
    expect(generalisedBranch('КА-24/25', 2_024, 'B')).toBe(
      String.raw`КА-\d{2}/\d{2}`,
    );
  });

  test('drops a leading and a trailing .*', () => {
    expect(generalisedBranch('.*Курс.*2024/2025.*', 2_024, 'A')).toBe('Курс');
    expect(generalisedBranch('.*Курс-2024/2025.*', 2_024, 'B')).toBe(
      String.raw`Курс-\d{4}/\d{4}`,
    );
    expect(generalisedBranch(String.raw`Курс\.*2024`, 2_024, 'A')).toBe(
      String.raw`Курс\.*`,
    );
  });

  test('is none without exactly one token naming the cell year, or with nothing before it', () => {
    expect(generalisedBranch('Курс', 2_024, 'A')).toBeNull();
    expect(generalisedBranch('Курс-2023/2024', 2_024, 'B')).toBeNull();
    expect(
      generalisedBranch('Курс-2024/2025 2024-2025', 2_024, 'A'),
    ).toBeNull();
    expect(generalisedBranch('2024/2025 Курс', 2_024, 'A')).toBeNull();
    expect(generalisedBranch('(Курс-2024/2025', 2_024, 'A')).toBeNull();
  });
});

describe('the year pattern of a branch', () => {
  test('is the form in which its lines write the year, when they agree', () => {
    expect(
      branchYearPattern('Системи на знаење-2019', 2_019, [
        'Системи на знаење-2019/2020/Z',
        'Системи на знаење-2019/2020/L',
      ]),
    ).toBe(defaultYearPattern);
  });

  test("falls back to the cell's own form when the lines disagree, lack the year, or are none", () => {
    for (const lines of [
      ['Курс-2019/2020/Z', 'Курс-2019-2020'],
      ['Курс-2019/2020/Z', 'Курс без година'],
      [],
    ]) {
      expect(branchYearPattern('Курс-2019', 2_019, lines)).toBe(startYear);
    }
  });

  test('is none without a token naming the cell year', () => {
    expect(branchYearPattern('Курс', 2_019, ['Курс-2019/2020'])).toBeNull();
  });
});

describe('covering', () => {
  test('holds for a literal inside the leading literal text of the other', () => {
    expect(covers('Машинска визија', 'Машинска визија-')).toBeTruthy();
    expect(covers('Kappa-', 'Old Kappa-')).toBeTruthy();
    expect(covers('Kappa-', String.raw`Kappa-\d{4}`)).toBeTruthy();
    expect(covers('Kappa-', 'Kap+a-')).toBeFalsy();
  });

  test('holds for L1.*L2 over a literal holding L1 and then L2', () => {
    expect(
      covers('Неструктурирани бази.*-', 'Неструктурирани бази на податоци-'),
    ).toBeTruthy();
    expect(covers('Бази.*Неструктурирани', 'Неструктурирани бази')).toBeFalsy();
  });

  test('holds for a prefix ending at an atom boundary', () => {
    expect(covers(String.raw`Курс \d`, String.raw`Курс \d{4}-x`)).toBeFalsy();
    expect(
      covers(String.raw`Курс \d{4}`, String.raw`Курс \d{4}-x`),
    ).toBeTruthy();
    expect(covers('Курс (a|b)', 'Курс (a|b)?')).toBeFalsy();
    expect(covers('Курс', 'Курс')).toBeFalsy();
  });
});

describe('joining alternatives', () => {
  test('adds a new branch, and nothing already there or covered', () => {
    expect(
      joinAlternatives(['Курс-'], ['Course-', 'Курс-', 'Old Course-']),
    ).toEqual(['Курс-', 'Course-']);
  });

  test("puts a covering branch in the first covered one's place, so the course's own name stays first", () => {
    expect(
      joinAlternatives(
        ['Машинска визија-', 'Machine Vision-', 'Машинска визија -'],
        ['Машинска визија'],
      ),
    ).toEqual(['Машинска визија', 'Machine Vision-']);
  });

  test('joins each branch to the all-years mapping of its year pattern, created when missing', () => {
    const joined = withAlternatives(
      {
        allYears: new Map([[defaultYearPattern, ['Курс-']]]),
        onlyInYear: new Map([['2024/2025', 'Курс-2024/2025|Course 2024']]),
      },
      [
        { branch: 'Course-', yearPattern: defaultYearPattern },
        { branch: 'Course', yearPattern: startYear },
        { branch: 'Курс стар', yearPattern: startYear },
      ],
    );

    expect([...joined.allYears]).toEqual([
      [defaultYearPattern, ['Курс-', 'Course-']],
      [startYear, ['Course', 'Курс стар']],
    ]);
    expect([...joined.onlyInYear]).toEqual([
      ['2024/2025', 'Курс-2024/2025|Course 2024'],
    ]);
  });
});
