import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  historyPageBudget,
  legacyPatternBudget,
  legacyRulePageSize,
  pageSize,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { planEnrollmentPages } from '../directus/extensions/directus-extension-data-operations/src/enrollment-pages.js';
import {
  enrollmentLimits,
  historyRanges,
  legacyRuleRanges,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-ranges.js';
import { expectedEnrollments } from './expected-exports.js';
import {
  makeSyntheticDataset,
  metacharacterCourseName,
  withMetacharacterCourse,
} from './fixtures/synthetic-data.js';
import {
  checkedPage,
  claim,
  type LegacyRule,
  type LegacyUser,
  refusalOf,
  runScript,
  seededRules,
  usersOf,
  yearId,
} from './legacy-enrollment-helpers.js';

const flowsDirectory = join(import.meta.dirname, '..', 'directus', 'flows');
const countScript = await readFile(
  join(flowsDirectory, 'count-history-page.cjs'),
  'utf8',
);
const sumScript = await readFile(
  join(flowsDirectory, 'sum-counts.cjs'),
  'utf8',
);

const countResult = z.object({
  rows: z.array(
    z.object({
      academic_year: z.number(),
      count: z.number(),
      course: z.number(),
    }),
  ),
  rules: z.number(),
  users: z.number(),
});
const coordinationFailure = z.object({
  code: z.string(),
  extensions: z.record(z.string(), z.unknown()),
  message: z.string(),
});

const nothingCounted = /; nothing was counted\.$/u;
const nothingStaged = /; nothing was staged\.$/u;
const compileRefusal =
  /^Rule \d+ \(course 99 \/ academic year \d+\) has a pattern that does not compile as a unicode regular expression \(Nothing to repeat\); nothing was counted\.$/u;
const escapeRefusal =
  /^Rule 1 \(course 1 \/ academic year 1\) has a pattern that does not compile as a unicode regular expression \(Invalid escape\); nothing was counted\.$/u;
const budgetRefusal =
  /^Page p0002 holds 800001 bytes of Courses history, more than the 800000-byte budget; nothing was counted\.$/u;
const cyrillicBudgetRefusal =
  /holds 800002 bytes of Courses history, more than the 800000-byte budget/u;
const plannedBytesRefusal =
  /^Page p0002 holds 13 bytes of Courses history, planned 14; nothing was counted\.$/u;
const patternBudgetRefusal =
  /^Rule page of page p0002 holds 1000001 bytes of pattern, more than the 1000000-byte budget; nothing was counted\.$/u;
const plannedPatternRefusal =
  /^Rule page of page p0002 holds 4 bytes of pattern, planned 5; nothing was counted\.$/u;
const overBudgetPlan =
  /^Moodle user 17 holds 800001 bytes of Courses history, more than the 800000-byte budget of one legacy rule page; nothing was planned\.$/u;
const overBudgetRule =
  /^Rule 12 holds a pattern of 1000001 bytes, more than the 1000000-byte pattern budget of one legacy rule page; nothing was planned\.$/u;
const unknownMode =
  /^Rule 4 has the mode "manual"; every enrollment rule must be mapped_entries or legacy_regex, so nothing was planned\.$/u;
const flagsInScript = /new RegExp\([^)]*'[a-fh-z]*g[a-z]*'\)/u;
const forbiddenInScript = /\bconsole\b|\brequire\(|\bimport\b|\bprocess\b/u;
const nameOrHistory = /Alpha|C\+\+|Course-|Theta/u;

const alphaEntry = 'Alpha Course-2025/2026';

const count = (
  users: readonly LegacyUser[],
  rules: readonly LegacyRule[],
  page: unknown = checkedPage(users, rules),
) =>
  countResult.parse(
    runScript(countScript, {
      check_page: page,
      read_rules: rules,
      read_users: users,
    }),
  );

const countKey = (course: number, year: number): string => `${course}/${year}`;

const countsOf = (
  results: ReadonlyArray<z.infer<typeof countResult>>,
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const { rows } of results) {
    for (const row of rows) {
      const key = countKey(row.course, row.academic_year);
      counts.set(key, (counts.get(key) ?? 0) + row.count);
    }
  }
  return counts;
};

// The committed checkpoint counts of the synthetic dataset, by course id
// and year id.
const committedCounts = async (): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  const committed = await expectedEnrollments('synthetic');
  for (const [key, value] of Object.entries(committed)) {
    const separator = key.indexOf('/');
    counts.set(
      countKey(
        Number(key.slice(0, separator)),
        yearId(key.slice(separator + 1)),
      ),
      value,
    );
  }
  return counts;
};

const rule = (
  id: number,
  pattern: unknown,
  extra: Partial<LegacyRule> = {},
): LegacyRule => ({ academic_year: 1, course: id, id, pattern, ...extra });

describe('legacy page planning', () => {
  test('keeps the measured budgets and page sizes', () => {
    expect(historyPageBudget).toBe(800_000);
    expect(legacyPatternBudget).toBe(1_000_000);
    expect(legacyRulePageSize).toBe(500);
    expect(pageSize).toBe(250);
    expect(enrollmentLimits).toEqual({
      budget: 800_000,
      patternBudget: 1_000_000,
      rulePageSize: 500,
      userPageSize: 250,
    });
    // The Run Script holds every page to the same limits.
    expect(countScript).toContain('const budget = 800_000;');
    expect(countScript).toContain('const patternBudget = 1_000_000;');
    expect(countScript).toContain('const maxRules = 500;');
    expect(countScript).toContain('const maxUsers = 250;');
  });

  test('splits history pages at 250 users and at the byte budget', () => {
    const small = Array.from({ length: 600 }, (_, index) => ({
      bytes: 1_000,
      id: 600 - index,
    }));

    expect(
      historyRanges(small).map(({ bytes, from, rows, to }) => [
        from,
        to,
        rows,
        bytes,
      ]),
    ).toEqual([
      [1, 250, 250, 250_000],
      [251, 500, 250, 250_000],
      [501, 600, 100, 100_000],
    ]);

    // 250 histories of 40,000 bytes: the budget holds 20 of them a page.
    const long = Array.from({ length: 250 }, (_, index) => ({
      bytes: 40_000,
      id: index + 1,
    }));

    expect(historyRanges(long).map(({ bytes, rows }) => [rows, bytes])).toEqual(
      [...Array.from({ length: 12 }, () => [20, 800_000]), [10, 400_000]],
    );
    // A page closes before the user that would exceed it; ids keep gaps.
    expect(
      historyRanges([
        { bytes: 600_000, id: 1 },
        { bytes: 200_001, id: 4 },
        { bytes: 0, id: 9 },
      ]),
    ).toEqual([
      { bytes: 600_000, from: 1, rows: 1, to: 1 },
      { bytes: 200_001, from: 4, rows: 2, to: 9 },
    ]);
    expect(historyRanges([])).toEqual([]);
  });

  test('splits legacy rule pages at 500 rules and at the pattern budget, and refuses one pattern over it', () => {
    const short = Array.from({ length: 1_001 }, (_, index) => ({
      bytes: 30,
      id: index + 1,
    }));

    expect(legacyRuleRanges(short).map(({ rows }) => rows)).toEqual([
      500, 500, 1,
    ]);

    // No pattern length cap: a long pattern takes a page of its own.
    expect(
      legacyRuleRanges([
        { bytes: 30, id: 10 },
        { bytes: 999_990, id: 11 },
        { bytes: 30, id: 12 },
      ]),
    ).toEqual([
      { bytes: 30, from: 10, rows: 1, to: 10 },
      { bytes: 999_990, from: 11, rows: 1, to: 11 },
      { bytes: 30, from: 12, rows: 1, to: 12 },
    ]);

    let failure: unknown = null;
    try {
      legacyRuleRanges([
        { bytes: 5, id: 3 },
        { bytes: 1_000_001, id: 12 },
      ]);
    } catch (error) {
      failure = error;
    }

    const parsed = coordinationFailure.parse(failure);

    expect(parsed.code).toBe('COORDINATION_PAGE_OVER_BUDGET');
    expect(parsed.message).toMatch(overBudgetRule);
    expect(parsed.extensions).toMatchObject({
      budget: 1_000_000,
      bytes: 1_000_001,
      rule: 12,
    });
  });

  test('refuses one history over the budget, naming the user and sizes only', () => {
    let failure: unknown = null;
    try {
      historyRanges([
        { bytes: 5, id: 3 },
        { bytes: 800_001, id: 17 },
      ]);
    } catch (error) {
      failure = error;
    }

    const parsed = coordinationFailure.parse(failure);

    expect(parsed.code).toBe('COORDINATION_PAGE_OVER_BUDGET');
    expect(parsed.message).toMatch(overBudgetPlan);
    expect(parsed.extensions).toMatchObject({
      budget: 800_000,
      bytes: 800_001,
      user: 17,
    });
  });
});

describe('enrollments plan order', () => {
  test('plans mapped pages, then every history page crossed with each legacy rule page and its zero page', () => {
    const rules = [
      ...Array.from({ length: 3 }, (_, index) => ({
        bytes: 0,
        id: index + 1,
        mode: 'mapped_entries',
      })),
      ...Array.from({ length: 501 }, (_, index) => ({
        bytes: 20,
        id: index + 10,
        mode: 'legacy_regex',
      })),
    ];
    const users = Array.from({ length: 260 }, (_, index) => ({
      bytes: 100,
      id: index + 1,
    }));
    const pages = planEnrollmentPages({ rules, users });

    expect(
      pages.map((page) => [page.token, page.kind, page.from, page.to]),
    ).toEqual([
      ['p0001', 'mapped', 1, 3],
      ['p0002', 'legacy', 1, 250],
      ['p0003', 'legacy', 251, 260],
      ['p0004', 'legacy_zeros', 10, 509],
      ['p0005', 'legacy', 1, 250],
      ['p0006', 'legacy', 251, 260],
      ['p0007', 'legacy_zeros', 510, 510],
    ]);
    expect(pages[1]).toEqual({
      bytes: 25_000,
      from: 1,
      kind: 'legacy',
      rows: 250,
      rules: { bytes: 10_000, from: 10, rows: 500, to: 509 },
      to: 250,
      token: 'p0002',
    });
    expect(pages[5]).toMatchObject({
      bytes: 1_000,
      rows: 10,
      rules: { bytes: 20, from: 510, rows: 1, to: 510 },
    });
  });

  test('plans the zero pages alone when no Moodle user exists, and nothing legacy without legacy rules', () => {
    expect(
      planEnrollmentPages({
        rules: [
          { bytes: 9, id: 4, mode: 'legacy_regex' },
          { bytes: 0, id: 2, mode: 'mapped_entries' },
        ],
        users: [],
      }),
    ).toEqual([
      { from: 2, kind: 'mapped', rows: 1, to: 2, token: 'p0001' },
      { from: 4, kind: 'legacy_zeros', rows: 1, to: 4, token: 'p0002' },
    ]);
    expect(
      planEnrollmentPages({
        rules: [{ bytes: 0, id: 2, mode: 'mapped_entries' }],
        users: [{ bytes: 1, id: 1 }],
      }),
    ).toEqual([{ from: 2, kind: 'mapped', rows: 1, to: 2, token: 'p0001' }]);
    expect(planEnrollmentPages({ rules: [], users: [] })).toEqual([]);
  });

  test('refuses a rule whose mode is neither family', () => {
    expect(() =>
      planEnrollmentPages({
        rules: [
          { bytes: 1, id: 3, mode: 'legacy_regex' },
          { bytes: 1, id: 4, mode: 'manual' },
        ],
        users: [],
      }),
    ).toThrow(unknownMode);
  });
});

describe('legacy page count script', () => {
  test('agrees with the committed checkpoint counts for every course and academic year', async () => {
    const dataset = makeSyntheticDataset();
    const rules = await seededRules(dataset);
    const users = usersOf(dataset);
    const result = count(users, rules);

    expect(result.users).toBe(9);
    expect(result.rules).toBe(rules.length);
    expect(result.rows.every((row) => row.count > 0)).toBeTruthy();

    const counted = countsOf([result]);
    const oracle = await committedCounts();

    expect(oracle.size).toBe(rules.length);
    expect(
      Object.fromEntries(
        oracle.keys().map((key) => [key, counted.get(key) ?? 0]),
      ),
    ).toEqual(Object.fromEntries(oracle));
  });

  test('sums to the checkpoint counts across history and rule pages', async () => {
    const dataset = makeSyntheticDataset();
    const rules = await seededRules(dataset);
    const users = usersOf(dataset);
    const results = [];
    for (const userPage of [users.slice(0, 4), users.slice(4)]) {
      for (const rulePage of [rules.slice(0, 50), rules.slice(50)]) {
        results.push(count(userPage, rulePage));
      }
    }

    expect(countsOf(results)).toEqual(
      new Map([...(await committedCounts())].filter(([, value]) => value > 0)),
    );
  });

  test('lets a whole-text pattern cross line boundaries and counts a repeated entry once', async () => {
    const dataset = makeSyntheticDataset();
    const counted = countsOf([
      count(usersOf(dataset), await seededRules(dataset)),
    ]);

    // Theta 2021/2022 needs the lab right after the lecture (LF or CRLF):
    // users 4 and 5, not user 6, whose history also lists both entries.
    expect(counted.get(countKey(7, yearId('2021/2022')))).toBe(2);
    // User 3 lists Alpha 2024/2025 twice and counts once.
    expect(counted.get(countKey(1, yearId('2024/2025')))).toBe(2);
    // Iota 2.0 is not escaped: the dot matches the X of user 8.
    expect(counted.get(countKey(8, yearId('2022/2023')))).toBe(1);
  });

  test('ignores null and non-string histories and tests an empty one like the checkpoint', async () => {
    const users = [
      { Courses: null, id: 1 },
      { Courses: 42, id: 2 },
      { Courses: { text: alphaEntry }, id: 3 },
      { Courses: '', id: 4 },
      { Courses: alphaEntry, id: 5 },
    ];
    const result = count(users, [rule(1, alphaEntry), rule(2, '^$')]);

    expect(result.rows).toEqual([
      { academic_year: 1, count: 1, course: 1 },
      { academic_year: 1, count: 1, course: 2 },
    ]);

    // The checkpoint counted ^$ for Alpha 2025/2026 over Moodle users 7
    // to 9: the empty history of user 9 only.
    const committed = await expectedEnrollments('empty-history-pattern');
    const later = usersOf(makeSyntheticDataset()).filter(({ id }) => id >= 7);

    expect(count(later, [rule(1, '^$')]).rows).toEqual([
      { academic_year: 1, count: committed['1/2025/2026'], course: 1 },
    ]);
    expect(committed['1/2025/2026']).toBe(1);
  });

  test('compiles with the u flag only, so every user is tested afresh', () => {
    const users = [1, 2, 3].map((id) => ({ Courses: 'Rule X-1', id }));

    expect(count(users, [rule(1, 'X-1')]).rows).toEqual([
      { academic_year: 1, count: 3, course: 1 },
    ]);
    expect(
      count(
        [{ Courses: alphaEntry, id: 1 }],
        [rule(1, String.raw`Alpha Course\u{2D}2025/2026`)],
      ).rows,
    ).toHaveLength(1);
    expect(
      refusalOf(() =>
        count(
          [{ Courses: alphaEntry, id: 1 }],
          [rule(1, String.raw`Alpha Course\-2025/2026`)],
        ),
      ),
    ).toMatch(escapeRefusal);
    expect(countScript).toContain("new RegExp(rule.pattern, 'u')");
    expect(countScript).not.toMatch(flagsInScript);
    expect(countScript).not.toMatch(forbiddenInScript);
    expect(sumScript).not.toMatch(forbiddenInScript);
  });

  test('refuses a metacharacter course name by rule id', async () => {
    const dataset = withMetacharacterCourse(makeSyntheticDataset());
    const rules = await seededRules(dataset);
    const message = refusalOf(() => count(usersOf(dataset), rules));

    expect(message).toMatch(compileRefusal);
    expect(message).not.toContain(metacharacterCourseName);
  });
});

describe('legacy page count refusals', () => {
  test('holds a page to the byte budget, counting UTF-8 bytes', () => {
    const rules = [rule(1, 'never')];
    const atBudget = [{ Courses: 'a'.repeat(800_000), id: 1 }];

    expect(count(atBudget, rules).rows).toEqual([]);
    expect(
      refusalOf(() => count([{ Courses: 'a'.repeat(800_001), id: 1 }], rules)),
    ).toMatch(budgetRefusal);
    expect(
      refusalOf(() => count([{ Courses: 'ж'.repeat(400_001), id: 1 }], rules)),
    ).toMatch(cyrillicBudgetRefusal);

    const users = [{ Courses: 'Rule Ж-1 abc', id: 1 }];
    const planned = checkedPage(users, rules);

    expect(
      refusalOf(() =>
        count(users, rules, {
          ...planned,
          users: { ...planned.users, bytes: planned.users.bytes + 1 },
        }),
      ),
    ).toMatch(plannedBytesRefusal);
  });

  test('holds a rule page to the pattern budget and to its planned pattern bytes, with no length cap', () => {
    const users = [{ Courses: `${'x'.repeat(2_049)} Rule 1`, id: 1 }];

    // A pattern of any length within the budget counts like the checkpoint.
    expect(count(users, [rule(1, 'x'.repeat(2_049))]).rows).toEqual([
      { academic_year: 1, count: 1, course: 1 },
    ]);
    expect(
      refusalOf(() =>
        count(users, [
          rule(1, 'x'.repeat(600_000)),
          rule(2, 'y'.repeat(400_001)),
        ]),
      ),
    ).toMatch(patternBudgetRefusal);

    // A pattern edited after planning no longer has the planned bytes.
    const planned = checkedPage(users, [rule(1, 'Ж-1a')]);

    expect(refusalOf(() => count(users, [rule(1, 'x-1a')], planned))).toMatch(
      plannedPatternRefusal,
    );
  });

  test('takes at most 250 users and 500 rules a page', () => {
    const users = Array.from({ length: 251 }, (_, index) => ({
      Courses: null,
      id: index + 1,
    }));
    const rules = Array.from({ length: 501 }, (_, index) =>
      rule(index + 1, 'never'),
    );

    expect(count(users.slice(0, 250), rules.slice(0, 500)).users).toBe(250);
    expect(refusalOf(() => count(users, rules.slice(0, 1)))).toMatch(
      nothingCounted,
    );
    expect(refusalOf(() => count(users.slice(0, 1), rules))).toMatch(
      nothingCounted,
    );
  });

  const pageUsers = [
    { Courses: 'Rule 1', id: 3 },
    { Courses: null, id: 4 },
  ];
  const pageRules = [rule(10, 'Rule 1'), rule(12, 'Rule 2')];
  const page = checkedPage(pageUsers, pageRules);

  test.each([
    ['no checked page', pageUsers, pageRules, null],
    ['no user list', null, pageRules, page],
    ['a truncated user list', pageUsers.slice(0, 1), pageRules, page],
    [
      'a user outside the page',
      [pageUsers[0], { Courses: null, id: 9 }],
      pageRules,
      page,
    ],
    ['a repeated user', [pageUsers[0], pageUsers[0]], pageRules, page],
    ['a user that is not an object', [pageUsers[0], 'user 4'], pageRules, page],
    ['no rule list', pageUsers, null, page],
    ['a truncated rule list', pageUsers, pageRules.slice(0, 1), page],
    ['a rule outside the page', pageUsers, [pageRules[0], rule(13, 'x')], page],
    ['a repeated rule', pageUsers, [pageRules[0], pageRules[0]], page],
    [
      'a rule without a course',
      pageUsers,
      [pageRules[0], rule(12, 'x', { course: 0 })],
      page,
    ],
    [
      'a textual academic year',
      pageUsers,
      [pageRules[0], { ...rule(12, 'x'), academic_year: '1' }],
      page,
    ],
    [
      'a rule without a pattern',
      pageUsers,
      [pageRules[0], rule(12, null)],
      page,
    ],
    ['a numeric pattern', pageUsers, [pageRules[0], rule(12, 12)], page],
    ['an empty pattern', pageUsers, [pageRules[0], rule(12, '')], page],
    [
      'a pattern that is not the planned one',
      pageUsers,
      [pageRules[0], rule(12, 'Rule 22')],
      page,
    ],
    [
      'a repeated course/year',
      pageUsers,
      [pageRules[0], rule(12, 'x', { course: 10 })],
      page,
    ],
  ])('refuses %s before counting', (...row) => {
    const [, readUsers, readRules, checked] = row;
    const message = refusalOf(() =>
      runScript(countScript, {
        check_page: checked,
        read_rules: readRules,
        read_users: readUsers,
      }),
    );

    expect(message).toMatch(nothingCounted);
    expect(message).not.toMatch(nameOrHistory);
    expect(message.length).toBeLessThan(400);
  });
});

describe('zero fill script', () => {
  const zeroPage = {
    cells: ['p0002', 'p0003'],
    claim,
    from: 10,
    revision: 7,
    rows: 3,
    to: 14,
    token: 'p0004',
  };
  const zeroRules = [
    { academic_year: 5, course: 3, id: 10 },
    { academic_year: 6, course: 3, id: 12 },
    { academic_year: 6, course: 4, id: 14 },
  ];
  const fill = (
    readSums: unknown,
    readRules: unknown = zeroRules,
    page: unknown = zeroPage,
  ) =>
    runScript(sumScript, {
      check_zeros: page,
      read_rules: readRules,
      read_sums: readSums,
    });

  test('stages an explicit zero for every legacy pair without a staged count', () => {
    expect(
      fill([{ academic_year: 6, course: 3, sum: { count: '4' } }]),
    ).toEqual({
      counted: 1,
      rows: [
        { academic_year: 5, count: 0, course: 3 },
        { academic_year: 6, count: 0, course: 4 },
      ],
      rules: 3,
      total: 4,
      zeros: 2,
    });
    expect(fill([])).toMatchObject({ counted: 0, rules: 3, zeros: 3 });
    expect(
      fill([
        { academic_year: 5, course: 3, sum: { count: 2 } },
        { academic_year: 6, course: 3, sum: { count: '0' } },
        { academic_year: 6, course: 4, sum: { count: '9' } },
      ]),
    ).toEqual({ counted: 3, rows: [], rules: 3, total: 11, zeros: 0 });
  });

  test.each([
    ['no aggregate list', null],
    [
      'a sum of a pair outside the page',
      [{ academic_year: 6, course: 9, sum: { count: '1' } }],
    ],
    [
      'a pair summed twice',
      [
        { academic_year: 6, course: 3, sum: { count: '1' } },
        { academic_year: 6, course: 3, sum: { count: '2' } },
      ],
    ],
    [
      'a fractional sum',
      [{ academic_year: 6, course: 3, sum: { count: '1.5' } }],
    ],
    ['a negative sum', [{ academic_year: 6, course: 3, sum: { count: '-1' } }]],
    [
      'a sum beyond an integer column',
      [{ academic_year: 6, course: 3, sum: { count: '9999999999' } }],
    ],
    [
      'a textual group',
      [{ academic_year: '6', course: 3, sum: { count: '1' } }],
    ],
    [
      'a count instead of a sum',
      [{ academic_year: 6, count: { count: '1' }, course: 3 }],
    ],
    [
      'an extra aggregate',
      [
        {
          academic_year: 6,
          course: 3,
          max: { count: '1' },
          sum: { count: '1' },
        },
      ],
    ],
    [
      'an extra summed field',
      [{ academic_year: 6, course: 3, sum: { count: '1', revision: '7' } }],
    ],
  ])('refuses %s instead of staging zeros', (_name, readSums) => {
    expect(refusalOf(() => fill(readSums))).toMatch(nothingStaged);
  });

  test.each([
    ['a truncated rule list', zeroRules.slice(0, 2), zeroPage],
    [
      'a rule outside the page',
      [...zeroRules.slice(0, 2), { ...zeroRules[2], id: 15 }],
      zeroPage,
    ],
    ['a repeated rule', [...zeroRules.slice(0, 2), zeroRules[0]], zeroPage],
    [
      'a rule without a year',
      [{ ...zeroRules[0], academic_year: null }, ...zeroRules.slice(1)],
      zeroPage,
    ],
    ['no checked page', zeroRules, null],
    [
      'a page without its cell list',
      zeroRules,
      { ...zeroPage, cells: 'p0002' },
    ],
  ])('refuses %s before staging', (_name, readRules, page) => {
    expect(refusalOf(() => fill([], readRules, page))).toMatch(nothingStaged);
  });
});
