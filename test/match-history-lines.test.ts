import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  maxRowsPerPage,
  pageSize,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import {
  defaultYearPattern,
  lineYear,
  type PatternMapping,
  resolveLines,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { refusalOf, runScript } from './flow-script-helpers.js';
import { lineYearVectors } from './line-year-vectors.js';

// The matcher Run Script of "Data / Match history lines", run in node:vm
// the way the Run Script operation runs it, on one page of history lines
// against every pattern mapping.

const scriptPath = join(
  import.meta.dirname,
  '..',
  'directus',
  'flows',
  'match-history-lines.cjs',
);
const matchScript = await readFile(scriptPath, 'utf8');

const answerSchema = z.strictObject({
  entries: z.number(),
  mappings: z.number(),
  rows: z.array(
    z.strictObject({
      entry: z.number(),
      pattern_mapping: z.number(),
      year_label: z.string().nullable(),
    }),
  ),
});

type Answer = z.infer<typeof answerSchema>;

type EntryRow = { readonly id: unknown; readonly label: unknown };

type MappingRow = {
  readonly id: unknown;
  readonly only_in_year: unknown;
  readonly pattern: unknown;
  readonly year_pattern: unknown;
};

const math1 = 'Математика 1-';
const badTrigger = 'Invalid trigger payload: expected {token, from, to, rows}';

// A pattern mapping as read_mappings answers it.
const mappingRow = (mapping: PatternMapping): MappingRow => ({
  id: mapping.id,
  only_in_year: mapping.onlyInYear,
  pattern: mapping.pattern,
  year_pattern: mapping.yearPattern,
});

// The message resolveLines fails with on these mappings.
const resolveFailure = (mappings: readonly PatternMapping[]): string =>
  refusalOf(() =>
    resolveLines({ explicit: [], lines: [], mappings, years: [] }),
  );

// Mapping 7 of course 10, all years with the default year pattern, with
// the given fields changed.
const mapping7 = (fields: Partial<PatternMapping>): PatternMapping => ({
  course: 10,
  id: 7,
  onlyInYear: null,
  pattern: 'x',
  yearPattern: defaultYearPattern,
  ...fields,
});

const notOne = 'expected exactly one of year_pattern, only_in_year';

const entriesOf = (...labels: readonly string[]): EntryRow[] =>
  labels.map((label, index) => ({ id: 41 + index, label }));

// The planned page of the given entries, as the dispatcher passes it.
const pageOf = (entries: readonly EntryRow[]) => {
  const ids = entries.map(({ id }) => (typeof id === 'number' ? id : 0));
  return {
    claim: '8c0f1a52-3b4d-4e6f-9a7b-1c2d3e4f5a6b',
    from: Math.min(...ids),
    rows: entries.length,
    to: Math.max(...ids),
    token: 'p0003',
  };
};

const allYears = (
  id: number,
  pattern: string,
  yearPattern: string = defaultYearPattern,
): MappingRow => ({
  id,
  only_in_year: null,
  pattern,
  year_pattern: yearPattern,
});

const onlyIn = (id: number, pattern: string, year: number): MappingRow => ({
  id,
  only_in_year: year,
  pattern,
  year_pattern: null,
});

// count_mappings as Directus answers it: one aggregate row, the count as
// text.
const countOf = (count: number) => [{ count: { id: String(count) } }];

const chainOf = (
  entries: readonly EntryRow[],
  mappings: readonly MappingRow[],
  page: unknown = pageOf(entries),
) => ({
  $trigger: page,
  count_mappings: countOf(mappings.length),
  read_entries: entries,
  read_mappings: mappings,
});

const run = (
  entries: readonly EntryRow[],
  mappings: readonly MappingRow[],
): Answer =>
  answerSchema.parse(runScript(matchScript, chainOf(entries, mappings)));

const refusal = (chain: unknown): string =>
  refusalOf(() => runScript(matchScript, chain));

// A page where no precedence rule applies: no explicit mapping, and no
// only-in-year mapping shares a course with an all-years one, so the
// completion keeps every staged row whose year label names an academic
// year.
const agreementYears = [
  { id: 1, label: '2023/2024' },
  { id: 2, label: '2024/2025' },
  { id: 3, label: '2025/2026' },
];

const agreementLabels = [
  'Математика 1-2025/2026/Z',
  'Математика 1-2023/2024/L',
  'Математика 1-2030/2031/Z',
  'Калкулус-2024/2025/L',
  'Компјутерски компоненти 2024-2025',
  'Компјутерски компоненти-2024/2025/L',
  'Автономна роботика-2024/25',
  'ВЕЗИЛКА',
];

const agreementMappings: PatternMapping[] = [
  {
    course: 10,
    id: 1,
    onlyInYear: null,
    pattern: math1,
    yearPattern: defaultYearPattern,
  },
  {
    course: 20,
    id: 2,
    onlyInYear: null,
    pattern: 'Компјутерски компоненти',
    yearPattern: String.raw`(?<start>\d{4})-(?<end>\d{4})`,
  },
  { course: 30, id: 3, onlyInYear: 3, pattern: 'Калкулус-', yearPattern: null },
  {
    course: 40,
    id: 4,
    onlyInYear: null,
    pattern: 'роботика',
    yearPattern: String.raw`(?<start>\d{4})/(?<end>\d{2})`,
  },
];

const agreementYearIds = new Map(
  agreementYears.map(({ id, label }) => [label, id]),
);

const onlyInYears = new Map(
  agreementMappings.map(({ id, onlyInYear }) => [id, onlyInYear]),
);

// A staged row as the completion reads it: the mapping's own year, or the
// academic year its year label names; nothing when neither exists.
const completedRow = (row: Answer['rows'][number]) => {
  const year =
    row.year_label === null
      ? onlyInYears.get(row.pattern_mapping)
      : agreementYearIds.get(row.year_label);
  return year === undefined || year === null
    ? []
    : [{ entry: row.entry, mapping: row.pattern_mapping, year }];
};

describe('match-history-lines.cjs', () => {
  test('stages each match: only-in-year without a year, all-years with the year it reads', () => {
    const entries = entriesOf(
      'Математика 1-2025/2026/Z',
      'Калкулус-2024/2025/L',
      'Математика 1',
      'Компјутерски компоненти 2024-2025',
      'ВЕЗИЛКА',
    );

    expect(
      run(entries, [
        allYears(1, math1),
        onlyIn(2, 'Калкулус-|Математика 1', 9),
        allYears(
          3,
          'Компјутерски компоненти',
          String.raw`(?<start>\d{4})-(?<end>\d{4})`,
        ),
      ]),
    ).toEqual({
      entries: 5,
      mappings: 3,
      rows: [
        { entry: 41, pattern_mapping: 1, year_label: '2025/2026' },
        { entry: 41, pattern_mapping: 2, year_label: null },
        { entry: 42, pattern_mapping: 2, year_label: null },
        // Line 43 matches mapping 1, which reads no year from it.
        { entry: 43, pattern_mapping: 2, year_label: null },
        { entry: 44, pattern_mapping: 3, year_label: '2024/2025' },
      ],
    });
  });

  test('tests each pattern against the whole line, ^ at its start', () => {
    expect(
      run(
        entriesOf('Математика 2-2024/2025/L', 'ССП - Математика 2-2024/2025/L'),
        [allYears(1, '^Математика 2-')],
      ).rows,
    ).toEqual([{ entry: 41, pattern_mapping: 1, year_label: '2024/2025' }]);
  });

  test('answers no row for a page no mapping matches, or without mappings', () => {
    const entries = entriesOf('ВЕЗИЛКА');

    expect(run(entries, [allYears(1, math1)])).toEqual({
      entries: 1,
      mappings: 1,
      rows: [],
    });
    expect(run(entries, [])).toEqual({ entries: 1, mappings: 0, rows: [] });
  });

  test.each(lineYearVectors)(
    'reads the year lineYear reads: %s on %j',
    (yearPattern, label, year) => {
      const { rows } = run(entriesOf(label), [allYears(7, '^', yearPattern)]);

      expect(lineYear(yearPattern, label)).toBe(year);
      expect(rows).toEqual(
        year === null
          ? []
          : [{ entry: 41, pattern_mapping: 7, year_label: year }],
      );
    },
  );

  test('stages exactly the pattern matches resolveLines counts when no precedence applies', () => {
    const staged = run(
      entriesOf(...agreementLabels),
      agreementMappings.map(mappingRow),
    ).rows.flatMap(completedRow);
    const counted = resolveLines({
      explicit: [],
      lines: agreementLabels.map((label, index) => ({ id: 41 + index, label })),
      mappings: agreementMappings,
      years: agreementYears,
    });

    expect(staged).toEqual(
      counted.map(({ academicYear, entry, patternMapping }) => ({
        entry,
        mapping: patternMapping,
        year: academicYear,
      })),
    );
    expect(staged).toHaveLength(5);
  });
});

describe('match-history-lines.cjs limits', () => {
  // 250 lines that every one of the mappings matches.
  const fullPage = entriesOf(
    ...Array.from(
      { length: pageSize },
      (_, index) => `Line ${String(index)}-2025/2026/Z`,
    ),
  );
  const matchingAll = (count: number): MappingRow[] =>
    Array.from({ length: count }, (_, index) => allYears(index + 1, 'Line'));

  test('declares the coordinator limits: 250 lines a page, 10,000 rows', () => {
    expect([pageSize, maxRowsPerPage]).toEqual([250, 10_000]);
  });

  test('answers a page of 250 lines with exactly 10,000 rows', () => {
    const answer = run(fullPage, matchingAll(maxRowsPerPage / pageSize));

    expect([answer.entries, answer.mappings, answer.rows.length]).toEqual([
      250, 40, 10_000,
    ]);
  });

  test('refuses a page that would stage more than 10,000 rows', () => {
    expect(
      refusal(
        chainOf(fullPage, [
          ...matchingAll(maxRowsPerPage / pageSize),
          allYears(99, '^Line 7-'),
        ]),
      ),
    ).toBe('Page p0003: matches 10001, max 10000');
  });

  test('refuses a page of more than 250 lines', () => {
    const entries = entriesOf(
      ...Array.from(
        { length: pageSize + 1 },
        (_, index) => `Line ${String(index)}`,
      ),
    );

    expect(refusal(chainOf(entries, []))).toBe(
      'Page p0003: entries 251, max 250',
    );
  });
});

describe('match-history-lines.cjs refusals', () => {
  const entries = entriesOf('Математика 1-2025/2026/Z', 'ВЕЗИЛКА');
  const valid = allYears(7, math1);
  const page = pageOf(entries);

  test.each([
    [null, badTrigger],
    [{ ...page, token: 'x0003' }, badTrigger],
    [{ ...page, from: 0 }, badTrigger],
    [{ ...page, to: 40 }, badTrigger],
    [{ ...page, rows: 0 }, badTrigger],
    [{ ...page, rows: 3 }, 'Page p0003: entries 2, planned 3'],
    [{ ...page, to: 41 }, 'read_entries: entry outside page p0003'],
  ])('refuses the page %j', (trigger, message) => {
    expect(refusal(chainOf(entries, [valid], trigger))).toBe(message);
  });

  test.each([
    [null, 'read_entries: no entry list'],
    [
      [
        { id: 41, label: 'A' },
        { id: 41, label: 'B' },
      ],
      'read_entries: entry outside page p0003',
    ],
    [[{ id: 41, label: 'A' }, null], 'read_entries: entry outside page p0003'],
    [
      [
        { id: 41, label: 'A' },
        { id: 42, label: '' },
      ],
      'History line 42: label missing',
    ],
    [
      [
        { id: 41, label: 'A' },
        { id: 42, label: 7 },
      ],
      'History line 42: label missing',
    ],
  ])('refuses the entries %j', (rows, message) => {
    expect(
      refusal({
        $trigger: page,
        count_mappings: countOf(1),
        read_entries: rows,
        read_mappings: [valid],
      }),
    ).toBe(message);
  });

  test.each([
    [null, 'read_mappings: no mapping list'],
    [
      [{ ...valid, id: 0 }],
      'read_mappings: expected {id, pattern, year_pattern, only_in_year}',
    ],
    [
      [math1],
      'read_mappings: expected {id, pattern, year_pattern, only_in_year}',
    ],
    [[valid, valid], 'Pattern mapping 7: duplicate'],
    [[{ ...valid, pattern: '' }], 'Pattern mapping 7: pattern missing'],
    [[{ ...valid, pattern: null }], 'Pattern mapping 7: pattern missing'],
    [
      [{ ...valid, only_in_year: 3 }],
      'Pattern mapping 7: expected exactly one of year_pattern, only_in_year',
    ],
    [
      [{ ...valid, year_pattern: null }],
      'Pattern mapping 7: expected exactly one of year_pattern, only_in_year',
    ],
    [
      [{ ...valid, year_pattern: '' }],
      'Pattern mapping 7: expected exactly one of year_pattern, only_in_year',
    ],
    [
      [{ ...valid, only_in_year: 0, year_pattern: null }],
      'Pattern mapping 7: expected exactly one of year_pattern, only_in_year',
    ],
    [
      [{ ...valid, pattern: 'Тајно име: (' }],
      'Pattern mapping 7: invalid regular expression (Unterminated group)',
    ],
    [
      [{ ...valid, pattern: String.raw`Веб\-програмирање` }],
      'Pattern mapping 7: invalid regular expression (Invalid escape)',
    ],
    [
      [{ ...valid, year_pattern: String.raw`(?<start>\d{4})**` }],
      'Pattern mapping 7: invalid year pattern (Nothing to repeat)',
    ],
    [
      [{ ...valid, year_pattern: String.raw`(?<year>\d{4})` }],
      'Pattern mapping 7: invalid year pattern (no group named start or end)',
    ],
    // Every mapping is checked before any compiles.
    [
      [
        { ...valid, pattern: '(' },
        { ...valid, id: 8, pattern: '' },
      ],
      'Pattern mapping 8: pattern missing',
    ],
  ])('refuses the mappings %j', (rows, message) => {
    expect(
      refusal({
        $trigger: page,
        count_mappings: countOf(Array.isArray(rows) ? rows.length : 0),
        read_entries: entries,
        read_mappings: rows,
      }),
    ).toBe(message);
  });

  test.each([
    [
      [mapping7({ pattern: 'Тајно име: (' })],
      7,
      'invalid regular expression (Unterminated group)',
    ],
    [
      [mapping7({ yearPattern: String.raw`(?<start>\d{4})**` })],
      7,
      'invalid year pattern (Nothing to repeat)',
    ],
    [
      [mapping7({ yearPattern: String.raw`\d{4}` })],
      7,
      'invalid year pattern (no group named start or end)',
    ],
    [[mapping7({ pattern: '' })], 7, 'pattern missing'],
    [[mapping7({ onlyInYear: 3 })], 7, notOne],
    [[mapping7({ yearPattern: null })], 7, notOne],
    [[mapping7({ yearPattern: '' })], 7, notOne],
    [[mapping7({ onlyInYear: 3, yearPattern: '' })], 7, notOne],
    [[mapping7({ onlyInYear: 0, yearPattern: null })], 7, notOne],
    [[mapping7({ onlyInYear: -3, yearPattern: null })], 7, notOne],
    [[mapping7({ onlyInYear: 1.5, yearPattern: null })], 7, notOne],
    // Every mapping's fields are checked before any pattern compiles.
    [
      [mapping7({ pattern: '(' }), mapping7({ id: 8, pattern: '' })],
      8,
      'pattern missing',
    ],
    [
      [mapping7({ pattern: '(' }), mapping7({ id: 8, onlyInYear: 3 })],
      8,
      notOne,
    ],
    // Then mapping by mapping, the pattern before the year pattern.
    [
      [mapping7({ yearPattern: '(' }), mapping7({ id: 8, pattern: '(' })],
      7,
      'invalid year pattern (Unterminated group)',
    ],
  ])(
    'refuses unusable mappings with the text resolveLines fails with (%#)',
    (mappings, id, fault) => {
      const message = `Pattern mapping ${String(id)}: ${fault}`;

      expect(refusal(chainOf(entries, mappings.map(mappingRow)))).toBe(message);
      expect(resolveFailure(mappings)).toBe(message);
    },
  );

  test('never quotes a label or a pattern', () => {
    const secret = 'Тајно име';
    const messages = [
      refusal(chainOf(entries, [{ ...valid, pattern: `${secret}: (` }])),
      refusal(chainOf(entries, [{ ...valid, year_pattern: `${secret}(` }])),
      refusal(
        chainOf(entriesOf(secret, `${secret} 2`), [valid], {
          ...page,
          rows: 3,
        }),
      ),
    ];

    expect(messages.filter((message) => message.includes(secret))).toEqual([]);
  });
});

// Directus cuts a read with limit -1 at QUERY_LIMIT_MAX: a mappings list
// that differs from their count is never matched as a smaller set.
describe('match-history-lines.cjs mapping count', () => {
  const entries = entriesOf('Математика 1-2025/2026/Z');
  const valid = allYears(7, math1);

  test('refuses a mappings read shorter or longer than their count', () => {
    const second = { ...valid, id: 8 };

    expect(
      refusal({ ...chainOf(entries, [valid]), count_mappings: countOf(2) }),
    ).toBe('read_mappings: mappings 1, expected 2');
    expect(
      refusal({
        ...chainOf(entries, [valid, second]),
        count_mappings: countOf(1),
      }),
    ).toBe('read_mappings: mappings 2, expected 1');
    expect(
      refusal({ ...chainOf(entries, []), count_mappings: countOf(267) }),
    ).toBe('read_mappings: mappings 0, expected 267');
  });

  test('takes the count as text or as a number', () => {
    for (const id of ['1', 1]) {
      expect(
        answerSchema.parse(
          runScript(matchScript, {
            ...chainOf(entries, [valid]),
            count_mappings: [{ count: { id } }],
          }),
        ).mappings,
      ).toBe(1);
    }
  });

  test.each([
    [undefined],
    [null],
    [[]],
    [[...countOf(1), ...countOf(1)]],
    [[{ count: '1' }]],
    [[{ count: { id: '-1' } }]],
    [[{ count: { id: '1.5' } }]],
    [[{ count: { id: 1.5 } }]],
    [[{ count: { id: null } }]],
  ])('refuses the count %j', (counted) => {
    expect(
      refusal({ ...chainOf(entries, [valid]), count_mappings: counted }),
    ).toBe('count_mappings: expected 1 count row');
  });
});
