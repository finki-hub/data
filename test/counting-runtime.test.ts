import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { parseCoordinatorInput } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import { sqlPort } from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-port.js';
import {
  countedLinesSql,
  enrollmentsSql,
  stageSql,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import {
  pageSize,
  pageSourceTables,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { openGuardSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/write-guards.js';
import {
  countedLineSources,
  countPairs,
  defaultYearPattern,
  type ExplicitMapping,
  type LabelledRow,
  type Membership,
  type PatternMapping,
  resolveLines,
} from '../directus/extensions/directus-extension-data-operations/src/enrollment-lines.js';
import { pagesScript } from '../src/flows/count-enrollments-scripts.js';
import {
  countedFromMatches,
  type CountingSources,
  FakeCoordination,
} from './data-coordination-helpers.js';
import { claimEnrollments, context, runScript } from './flow-script-helpers.js';

// An enrollments run as the coordinator and the Flows carry it out: plan
// source entries pages the history lines, the matcher Run Script stages
// each page's matches, and the completion rebuilds the counted lines and
// every count. The completion's SQL is pinned here; the fake port applies
// the same rules (countedFromMatches), and an integration scenario proves
// the SQL equal to resolveLines on a database.

const scriptPath = join(
  import.meta.dirname,
  '..',
  'directus',
  'flows',
  'match-history-lines.cjs',
);
const matchScript = await readFile(scriptPath, 'utf8');
const collator = new Intl.Collator('en');

const planAnswer = z.object({
  pages: z.array(
    z.object({
      from: z.number(),
      rows: z.number(),
      to: z.number(),
      token: z.string(),
    }),
  ),
  total: z.number(),
});

const matchAnswer = z.object({
  rows: z.array(
    z.object({
      entry: z.number(),
      pattern_mapping: z.number(),
      year_label: z.string().nullable(),
    }),
  ),
});

const years: readonly LabelledRow[] = [
  { id: 1, label: '2024/2025' },
  { id: 2, label: '2025/2026' },
  { id: 3, label: '2026/2027' },
];

// History lines: three courses' own lines in several year forms, a line
// with no year, a year no academic year carries, one line mapped by hand,
// and enough electives that the lines fill two pages.
const named = [
  'Alpha-2024/2025/Z',
  'Alpha-2025/2026/L',
  'Alpha 2025-2026',
  'Alpha-без година',
  'Alpha-2030/2031/Z',
  'Beta-2025/2026/Z',
  'Beta-2026/2027/Z',
  'Gamma-2025/2026/Z',
  'Gamma Lab-2025/2026/Z',
];
const lines: readonly LabelledRow[] = [
  ...named,
  ...Array.from({ length: 280 }, (_, index) => `Elective ${String(index)}`),
].map((label, index) => ({ id: index + 1, label }));

const mappings: readonly PatternMapping[] = [
  // Alpha in every year its lines name, in two year forms.
  {
    course: 1,
    id: 1,
    onlyInYear: null,
    pattern: '^Alpha-',
    yearPattern: defaultYearPattern,
  },
  {
    course: 1,
    id: 2,
    onlyInYear: null,
    pattern: '^Alpha ',
    yearPattern: String.raw`(?<start>\d{4})-(?<end>\d{4})`,
  },
  // Beta in every year, but 2026/2027 counts its lab only.
  {
    course: 2,
    id: 3,
    onlyInYear: null,
    pattern: '^Beta-',
    yearPattern: defaultYearPattern,
  },
  { course: 2, id: 4, onlyInYear: 3, pattern: 'Lab-', yearPattern: null },
  // Gamma by its own name; its lab line is mapped to Beta by hand.
  {
    course: 3,
    id: 5,
    onlyInYear: null,
    pattern: '^Gamma',
    yearPattern: defaultYearPattern,
  },
];

const explicit: readonly ExplicitMapping[] = [
  { academicYear: 2, course: 2, entry: 9 },
];

// Users 1-6 hold the named lines; every elective is held by user 7.
const memberships: readonly Membership[] = [
  ...[1, 2, 3].map((moodleUser) => ({ entry: 1, moodleUser })),
  { entry: 2, moodleUser: 1 },
  { entry: 3, moodleUser: 4 },
  { entry: 4, moodleUser: 5 },
  { entry: 5, moodleUser: 5 },
  { entry: 6, moodleUser: 2 },
  { entry: 7, moodleUser: 6 },
  { entry: 8, moodleUser: 3 },
  { entry: 9, moodleUser: 6 },
  ...lines.slice(named.length).map(({ id }) => ({ entry: id, moodleUser: 7 })),
];

const counting: CountingSources = {
  courses: [1, 2, 3],
  explicit,
  mappings,
  memberships,
  years,
};

type MatchRow = z.infer<typeof matchAnswer>['rows'][number];

type RunSources = {
  readonly lines: readonly LabelledRow[];
  readonly mappings: readonly PatternMapping[];
};

const runSources: RunSources = { lines, mappings };

// Plans, matches every page with the matcher script and stages it through
// the operation's own option schema, then completes the claim: what the
// dispatcher and its page Flow do. Answers the staged rows too.
const countedRun = async (
  fake: FakeCoordination,
  sources: RunSources = runSources,
) => {
  const staged: MatchRow[] = [];
  const token = await claimEnrollments(fake);
  const plan = planAnswer.parse(
    await runAction(
      { action: 'plan_pages', source: 'entries', token },
      context(fake),
    ),
  );
  const pages = z
    .array(z.object({ from: z.number(), to: z.number(), token: z.string() }))
    .parse(
      runScript(pagesScript, { $trigger: { claim: token, revision: 0 }, plan }),
    );
  for (const page of pages) {
    const pageLines = sources.lines.filter(
      ({ id }) => id >= page.from && id <= page.to,
    );
    const { rows } = matchAnswer.parse(
      runScript(matchScript, {
        $trigger: { ...page, rows: pageLines.length },
        count_mappings: [{ count: { id: String(sources.mappings.length) } }],
        read_entries: pageLines,
        read_mappings: sources.mappings.map((mapping) => ({
          id: mapping.id,
          only_in_year: mapping.onlyInYear,
          pattern: mapping.pattern,
          year_pattern: mapping.yearPattern,
        })),
      }),
    );
    staged.push(...rows);
    await runAction(
      parseCoordinatorInput({
        action: 'stage_page',
        page: page.token,
        rows,
        token,
      }),
      context(fake),
    );
  }
  return {
    completed: await runAction({ action: 'complete', token }, context(fake)),
    plan,
    staged,
  };
};

// An all-years pattern mapping of course 1.
const courseOneMapping = (
  id: number,
  pattern: string,
  yearPattern: string,
): PatternMapping => ({
  course: 1,
  id,
  onlyInYear: null,
  pattern,
  yearPattern,
});

// A match of mapping 1 that read 2025/2026 from the line.
const yearMatch = (entry: number) => ({
  entry,
  pattern_mapping: 1,
  year_label: '2025/2026',
});

const byLine = <Row extends { readonly entry: number }>(rows: readonly Row[]) =>
  rows.toSorted(
    (left, right) =>
      left.entry - right.entry ||
      collator.compare(JSON.stringify(left), JSON.stringify(right)),
  );

describe('plan source entries', () => {
  test('pages the history lines of an enrollments claim by id, 250 per page', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.entries = lines.map(({ id }) => id);
    const token = await claimEnrollments(fake);
    const plan = planAnswer.parse(
      await runAction(
        { action: 'plan_pages', source: 'entries', token },
        context(fake),
      ),
    );

    expect(pageSourceTables.entries).toBe('moodle_course_entries');
    expect(pageSize).toBe(250);
    expect(plan).toMatchObject({
      pages: [
        { from: 1, rows: 250, to: 250, token: 'p0001' },
        { from: 251, rows: 39, to: 289, token: 'p0002' },
      ],
      total: 2,
    });
    expect(fake.data.claim?.pages).toEqual(['p0001', 'p0002']);
  });

  test('is refused under any claim but enrollments, and history under an enrollments claim', async () => {
    const fake = new FakeCoordination();
    const history = z
      .object({ token: z.string() })
      .parse(
        await runAction(
          { action: 'claim', domain: 'history_index', retry: false },
          context(fake),
        ),
      ).token;

    await expect(
      runAction(
        { action: 'plan_pages', source: 'entries', token: history },
        context(fake),
      ),
    ).rejects.toMatchObject({
      code: 'COORDINATION_DOMAIN_MISMATCH',
      message:
        'plan_pages source entries: claim domain history_index, expected enrollments',
    });
    expect(fake.data.claim?.pages).toBeNull();

    const other = new FakeCoordination();
    const enrollments = await claimEnrollments(other);

    await expect(
      runAction(
        { action: 'plan_pages', source: 'history', token: enrollments },
        context(other),
      ),
    ).rejects.toMatchObject({
      message:
        'plan_pages source history: claim domain enrollments, expected history_index',
    });
  });

  test('completes an empty plan with a 0 for every course and year', async () => {
    const fake = new FakeCoordination();
    fake.counting = { ...counting, explicit: [] };
    const token = await claimEnrollments(fake);
    await runAction(
      { action: 'plan_pages', source: 'entries', token },
      context(fake),
    );

    await expect(
      runAction({ action: 'complete', token }, context(fake)),
    ).resolves.toMatchObject({ counted: 0, installed: 9 });
    expect(fake.data.enrollments.map(({ count }) => count)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  test('discards the matches of a replaced plan, so the completion installs only the current plan', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.entries = Array.from(
      { length: 300 },
      (_, index) => index + 1,
    );
    fake.counting = {
      courses: [1],
      explicit: [],
      mappings: [{ course: 1, id: 1, onlyInYear: null }],
      memberships: [1, 2, 3, 290].map((entry) => ({
        entry,
        moodleUser: entry,
      })),
      years: [{ id: 1, label: '2025/2026' }],
    };
    const token = await claimEnrollments(fake);
    const plan = () =>
      runAction(
        { action: 'plan_pages', source: 'entries', token },
        context(fake),
      );
    const stage = (page: string, rows: Array<ReturnType<typeof yearMatch>>) =>
      runAction({ action: 'stage_page', page, rows, token }, context(fake));

    await expect(plan()).resolves.toMatchObject({ discarded: 0, total: 2 });

    await stage('p0001', [yearMatch(1), yearMatch(2)]);
    await stage('p0002', [yearMatch(290)]);

    expect(fake.data.candidates).toHaveLength(3);

    fake.sourceIds.entries = [1, 2, 3];

    await expect(plan()).resolves.toMatchObject({ discarded: 3, total: 1 });
    expect(fake.data.candidates).toEqual([]);
    expect(fake.data.claim?.pages).toEqual(['p0001']);
    expect(fake.data.claim?.staged).toEqual([]);
    await expect(
      runAction({ action: 'complete', token }, context(fake)),
    ).rejects.toMatchObject({
      code: 'COORDINATION_PAGES_MISSING',
      extensions: { missing: ['p0001'] },
    });

    await stage('p0001', [yearMatch(3)]);
    const revision = fake.data.sourceRevision;

    await expect(
      runAction({ action: 'complete', token }, context(fake)),
    ).resolves.toEqual({
      completed: true,
      counted: 1,
      domain: 'enrollments',
      installed: 1,
      retries: 0,
      revision,
    });
    expect(fake.data.enrollments).toEqual([
      { academicYear: 1, count: 1, course: 1, revision },
    ]);
    expect(fake.data.candidates).toEqual([]);
  });
});

describe('an enrollments run', () => {
  test('counts exactly what resolveLines and countPairs count', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.entries = lines.map(({ id }) => id);
    fake.counting = counting;

    const { completed, plan } = await countedRun(fake);
    const resolved = resolveLines({ explicit, lines, mappings, years });
    const expected = countPairs({
      counted: resolved,
      courses: counting.courses.map((id) => ({ id })),
      memberships,
      years,
    });

    expect(plan.total).toBe(2);
    expect(completed).toMatchObject({
      completed: true,
      counted: resolved.length,
      installed: 9,
    });
    expect(byLine(fake.data.countedLines)).toEqual(byLine(resolved));
    expect(
      fake.data.enrollments.map(({ academicYear, count, course }) => ({
        academicYear,
        count,
        course,
      })),
    ).toEqual(expected);
    // Alpha 2024/2025: users 1-3; 2025/2026: the default and the
    // other year form, users 1 and 4; no year and 2030/2031 count nowhere.
    // Beta 2026/2027 counts only its only-in-year mapping, which matches
    // no line; Gamma's lab counts for Beta by hand.
    expect(expected.map(({ count }) => count)).toEqual([
      3, 2, 0, 0, 2, 0, 0, 1, 0,
    ]);
  });

  // lineYear reads <start>/<start+1> from any 2 or 4 digits, so a line can
  // name a year no academic year carries, down to -1/0 from an end year
  // 0000: the stage takes it, and it counts nowhere.
  test('stages a year that names no academic year, which counts nowhere', async () => {
    const oddLines: readonly LabelledRow[] = [
      { id: 1, label: 'Alpha-0999/1000/Z' },
      { id: 2, label: 'Alpha 9999' },
      { id: 3, label: 'Alpha 0000' },
    ];
    const oddMappings = [
      courseOneMapping(1, '^Alpha-', defaultYearPattern),
      courseOneMapping(2, '^Alpha 9', String.raw`(?<start>\d{4})`),
      courseOneMapping(3, '^Alpha 0', String.raw`(?<end>\d{4})`),
    ];
    const fake = new FakeCoordination();
    fake.sourceIds.entries = [1, 2, 3];
    fake.counting = {
      courses: [1],
      explicit: [],
      mappings: oddMappings,
      memberships: [1, 2, 3].map((entry) => ({ entry, moodleUser: entry })),
      years,
    };

    const { completed, staged } = await countedRun(fake, {
      lines: oddLines,
      mappings: oddMappings,
    });

    expect(staged).toEqual([
      { entry: 1, pattern_mapping: 1, year_label: '999/1000' },
      { entry: 2, pattern_mapping: 2, year_label: '9999/10000' },
      { entry: 3, pattern_mapping: 3, year_label: '-1/0' },
    ]);
    expect(
      resolveLines({
        explicit: [],
        lines: oddLines,
        mappings: oddMappings,
        years,
      }),
    ).toEqual([]);
    expect(completed).toMatchObject({ counted: 0, installed: 3 });
    expect(fake.data.enrollments.map(({ count }) => count)).toEqual([0, 0, 0]);
  });

  test('stages matches as rows of their claim and page, a repeated one refused', async () => {
    const fake = new FakeCoordination();
    fake.sourceIds.entries = [1];
    const token = await claimEnrollments(fake);
    await runAction(
      { action: 'plan_pages', source: 'entries', token },
      context(fake),
    );
    const row = { entry: 1, pattern_mapping: 1, year_label: '2024/2025' };

    await runAction(
      { action: 'stage_page', page: 'p0001', rows: [row], token },
      context(fake),
    );

    expect(fake.data.candidates).toEqual([{ ...row, page: 'p0001', token }]);
    await expect(
      runAction(
        {
          action: 'stage_page',
          page: 'p0001',
          rows: [row, { ...row, year_label: null }],
          token,
        },
        context(fake),
      ),
    ).rejects.toMatchObject({
      code: 'COORDINATION_DUPLICATE_ROWS',
      message: 'Duplicate matches: entry 1 / pattern mapping 1',
    });
  });

  test('applies the counting rules in the fake completion as resolveLines does', () => {
    const matches = [
      { entry: 9, pattern_mapping: 5, year_label: '2025/2026' },
      { entry: 7, pattern_mapping: 3, year_label: '2026/2027' },
      { entry: 5, pattern_mapping: 1, year_label: '2030/2031' },
    ];

    // The explicit line, the replaced year and the year without a row
    // count nowhere by a pattern.
    expect(countedFromMatches(counting, matches)).toEqual([
      {
        academicYear: 2,
        course: 2,
        entry: 9,
        patternMapping: null,
        source: 'explicit',
      },
    ]);
  });
});

describe('the completion statements', () => {
  test('rebuild the counted lines by the three precedence rules for the claim', () => {
    const [explicitSource, patternSource] = countedLineSources;

    expect(countedLinesSql).toContain(
      `SELECT e."entry", e."course", e."academic_year", '${explicitSource}', NULL FROM "moodle_course_mappings" e`,
    );
    expect(countedLinesSql).toContain(
      `COALESCE(p."only_in_year", y."id"), '${patternSource}', p."id"`,
    );
    expect(countedLinesSql).toContain(
      'LEFT JOIN "academic_years" y ON p."only_in_year" IS NULL AND y."label" = m."year_label"',
    );
    expect(countedLinesSql).toContain('WHERE m."claim_token" = ?');
    expect(countedLinesSql).toContain(
      'NOT EXISTS (SELECT 1 FROM "moodle_course_mappings" x WHERE x."entry" = m."entry")',
    );
    expect(countedLinesSql).toContain(
      'SELECT 1 FROM "moodle_pattern_mappings" o WHERE o."course" = p."course" AND o."only_in_year" = y."id"',
    );
    expect(countedLinesSql.match(/\?/gu)).toHaveLength(1);
  });

  test('count every course and academic year, distinct users, 0 when no line counts', () => {
    expect(enrollmentsSql).toContain(
      'FROM "courses" c CROSS JOIN "academic_years" y',
    );
    expect(enrollmentsSql).toContain(
      'LEFT JOIN "moodle_counted_lines" l ON l."course" = c."id" AND l."academic_year" = y."id"',
    );
    expect(enrollmentsSql).toContain('COUNT(DISTINCT h."moodle_user")');
    expect(enrollmentsSql.match(/\?/gu)).toHaveLength(1);
    expect(stageSql).toContain(
      'INSERT INTO "data_operation_matches" ("claim_token", "page_token", "entry", "pattern_mapping", "year_label")',
    );
    expect(stageSql).toContain(
      'SELECT ?, ?, rows."entry", rows."pattern_mapping", rows."year_label"',
    );
    expect(stageSql).toContain(
      'json_to_recordset(?::json) AS rows("entry" integer, "pattern_mapping" integer, "year_label" text)',
    );
  });

  test('run in order behind both write guards, bound to the claim and its revision', async () => {
    const sent: Array<{ bindings: unknown; sql: string }> = [];
    const port = sqlPort({
      raw: async (sql: string, bindings?: unknown) => {
        sent.push({ bindings, sql });
        return {
          rowCount: sql.startsWith('INSERT INTO "moodle') ? 5 : 9,
          rows: [],
        };
      },
    });

    await expect(port.installEnrollments('token-1', 4)).resolves.toEqual({
      counted: 5,
      installed: 9,
    });
    expect(sent).toEqual([
      { bindings: [], sql: openGuardSql('moodle_counted_lines') },
      { bindings: [], sql: openGuardSql('course_enrollments') },
      { bindings: [], sql: 'DELETE FROM "moodle_counted_lines"' },
      { bindings: ['token-1'], sql: countedLinesSql },
      { bindings: [], sql: 'DELETE FROM "course_enrollments"' },
      { bindings: [4], sql: enrollmentsSql },
    ]);
  });
});
