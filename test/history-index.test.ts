import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { splitHistory } from '../directus/extensions/directus-extension-course-search/src/history.js';
import { type ActionContext } from '../directus/extensions/directus-extension-data-operations/src/coordination/action-support.js';
import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { decideCompletion } from '../directus/extensions/directus-extension-data-operations/src/coordination/decisions.js';
import { type Domain } from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  coordinatorActions,
  parseCoordinatorInput,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import {
  claimStaleAfterMs,
  maxRowsPerPage,
  type OperationsState,
  pageSize,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/state.js';
import { statusAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import {
  duplicateUserIds,
  historyRowProblem,
  isExactLabel,
  labelBytes,
  maxLabelBytes,
  missingLabels,
  pageCoverage,
  pageLabels,
  planMemberships,
  splitHistoryEntries,
  splitHistoryLines,
} from '../directus/extensions/directus-extension-data-operations/src/history-contract.js';
import { registerWriteGuards } from '../directus/extensions/directus-extension-data-operations/src/write-guard.js';
import {
  describeFailureScript,
  pagesWithTokenScript,
  splitEntriesScript,
  summaryScript,
} from '../src/flows/history-script.js';
import { FakeCoordination } from './data-coordination-helpers.js';
import {
  fakeHistoryPort,
  freshHistory,
  membershipGuardMessage,
} from './history-index-helpers.js';

const uuid = '6c6b4e8e-5c1d-4b3f-9a0e-1f2d3c4b5a69';
const processA = 'process-a';
const firstPage = 'p0001';
const secondPage = 'p0002';
const history: Domain = 'history_index';
const graphA = 'graph-a';
const noEntryIdPattern = /No entry id/u;
const noRowListPattern = /read_histories/u;
const noClaimTokenPattern = /claim token/u;

// LF, CRLF, a trailing lone CR, empty lines, exact repeats, whitespace and
// case variants, a lone CR inside a line, Cyrillic and LIKE metacharacters.
const vector: Array<null | string | undefined> = [
  'A\r\nB\n\n C ',
  'A\r\nB\r',
  '',
  'A\nA\nA',
  'a\nA\n a\na \nA',
  'Дизајн на софтвер\r\nДизајн на софтвер\r\n',
  'A\rB\nC',
  '\r\n\r\n',
  'A\r\r\nB',
  'A\r\r',
  'X\n\r\r\r\nY',
  'A\n\r\r',
  '\r\r\r\n',
  'Under_score 100%\nUnder_score 100%',
  null,
  undefined,
];

type PageRows = Array<{ entries: string[]; id: number }>;

const claimed = z.object({ claimed: z.literal(true), token: z.string() });
const indexed = z.object({
  entriesCreated: z.number(),
  membershipsRemoved: z.number(),
  membershipsWritten: z.number(),
  page: z.string(),
  users: z.number(),
});
const errorShape = z.object({ code: z.string(), status: z.number() });

const context = (fake: FakeCoordination, owner = processA): ActionContext => ({
  owner,
  staleAfterMs: claimStaleAfterMs,
  store: fake.store,
});

const failureOf = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (error) {
    return errorShape.parse(error);
  }
};

const claimDomain = async (
  fake: FakeCoordination,
  domain: Domain,
): Promise<string> => {
  const outcome = await runAction(
    { action: 'claim', domain, retry: false },
    context(fake),
  );
  return claimed.parse(outcome).token;
};

const planHistory = (fake: FakeCoordination, token: string) =>
  runAction({ action: 'plan_pages', source: 'history', token }, context(fake));

const indexPage = async (
  fake: FakeCoordination,
  input: { page?: string; rows: PageRows; token: string },
  owner = processA,
) => {
  const outcome = await runAction(
    {
      action: 'index_page',
      page: input.page ?? firstPage,
      rows: input.rows,
      token: input.token,
    },
    context(fake, owner),
  );
  return indexed.parse(outcome);
};

// A fake with three raw histories, the history domain dirty and a plan of
// one page over the three users.
const seeded = async () => {
  const fake = new FakeCoordination();
  fake.sourceIds.history = [1, 2, 3];
  fake.data.history.users = [
    { coursesCount: 3, id: 1 },
    { coursesCount: 2, id: 2 },
    { coursesCount: null, id: 3 },
  ];
  fake.sourceWrite('moodle_users');
  const token = await claimDomain(fake, history);
  await planHistory(fake, token);
  return { fake, token };
};

const pageRows = (): PageRows => [
  { entries: splitHistoryEntries('Alpha\nBeta\nAlpha'), id: 1 },
  { entries: splitHistoryEntries('alpha\r\n Alpha\r\nAlpha \r'), id: 2 },
  { entries: splitHistoryEntries(null), id: 3 },
];

const memberships = (fake: FakeCoordination) =>
  fake.data.history.memberships.map(({ entry, moodle_user, sort }) => [
    moodle_user,
    entry,
    sort,
  ]);

const labelsOf = (fake: FakeCoordination) =>
  fake.data.history.entries.map(({ label }) => label);

const indexOptions = (rows: unknown) => ({
  action: 'index_page',
  page: firstPage,
  rows,
  token: uuid,
});

const liveState = (claim: object): OperationsState => ({
  calculationFingerprint: null,
  claim: {
    domain: history,
    fingerprint: graphA,
    heartbeatAgeMs: 0,
    heartbeatAt: 't',
    owner: processA,
    pages: null,
    ranges: [],
    retries: 0,
    revision: 1,
    staged: [],
    startedAt: 't',
    token: uuid,
    ...claim,
  },
  completedRevision: 0,
  dirtyDomains: [history],
  finishedAt: null,
  importState: 'idle',
  inputRevisions: { enrollments: 1, history_index: 1 },
  lastError: null,
  lastRunRetries: 0,
  publicationFingerprint: null,
  publicationOutcomes: null,
  publicationState: 'idle',
  requestedRevision: 1,
  sourceRevision: 1,
  startedAt: null,
});

// Runs a Flow script body the way the Run Script operation does: the body
// assigns module.exports, which receives the data chain.
const runScript = (code: string, data: unknown): unknown => {
  const sandbox: { module: { exports: unknown } } = {
    module: { exports: undefined },
  };
  runInNewContext(code, sandbox);
  const script = sandbox.module.exports;
  if (typeof script !== 'function') {
    throw new TypeError('The script must assign module.exports');
  }
  return (script as (input: unknown) => unknown)(data);
};

describe('history contract', () => {
  test('splits exactly like the Search extension over the shared vector', () => {
    for (const raw of vector) {
      expect(splitHistoryLines(raw)).toEqual(splitHistory(raw));
    }

    expect(splitHistoryLines('A\r\nB\n\n C ')).toEqual(['A', 'B', ' C ']);
    expect(splitHistoryLines('A\r\nB\r')).toEqual(['A', 'B']);
    expect(splitHistoryLines('A\rB\nC')).toEqual(['A\rB', 'C']);
  });

  test('keeps the first occurrence of an exact repeat and every variant apart', () => {
    expect(splitHistoryEntries('A\nA\nA')).toEqual(['A']);
    expect(splitHistoryEntries('a\nA\n a\na \nA')).toEqual([
      'a',
      'A',
      ' a',
      'a ',
    ]);
    expect(
      splitHistoryEntries('Дизајн на софтвер\r\nДизајн на софтвер\r\n'),
    ).toEqual(['Дизајн на софтвер']);
    expect(splitHistoryEntries('\r\n\r\n')).toEqual([]);
    expect(splitHistoryEntries(undefined)).toEqual([]);

    for (const raw of vector) {
      expect(splitHistoryEntries(raw)).toEqual([...new Set(splitHistory(raw))]);
    }
  });

  test('accepts every entry the splitter emits, and nothing it never emits', () => {
    for (const raw of vector) {
      const entries = splitHistoryEntries(raw);

      expect(entries.every((entry) => isExactLabel(entry))).toBeTruthy();
      expect(
        parseCoordinatorInput(indexOptions([{ entries, id: 1 }])).action,
      ).toBe('index_page');
    }

    expect(splitHistoryEntries('Course X\r\r')).toEqual(['Course X\r']);
    expect(splitHistoryEntries('x\n\r\r\r\ny')).toEqual(['x', '\r', 'y']);
  });

  test('accepts as a label exactly the strings the splitter can emit', () => {
    expect(isExactLabel('A')).toBeTruthy();
    expect(isExactLabel(' A ')).toBeTruthy();
    expect(isExactLabel('A\rB')).toBeTruthy();
    // Only one trailing CR is dropped per line: 'A\r\r' yields 'A\r'.
    expect(isExactLabel('A\r')).toBeTruthy();
    expect(isExactLabel('\r')).toBeTruthy();
    expect(isExactLabel('')).toBe(false);
    expect(isExactLabel('A\nB')).toBe(false);
    expect(isExactLabel('A\r\nB')).toBe(false);
    expect(isExactLabel('\n')).toBe(false);

    // Every such string comes back unchanged from the raw text label + CR.
    for (const label of ['A', 'A\r', '\r', '\r\r', ' a\rb ']) {
      expect(splitHistoryEntries(`${label}\r`)).toEqual([label]);
    }
  });

  test('bounds one user by entry count and entry size in bytes', () => {
    const cyrillic = 'Д'.repeat(maxLabelBytes / 2 + 1);

    expect(labelBytes('Дизајн')).toBe(12);
    expect(historyRowProblem(['A', 'x'.repeat(maxLabelBytes)])).toBeNull();
    expect(historyRowProblem(['x'.repeat(maxLabelBytes + 1)])).toBe(
      `a history line of ${maxLabelBytes + 1} bytes, one entry holds at most ${maxLabelBytes} bytes; shorten that line in the raw Courses history`,
    );
    // Bytes, not characters: fewer than 2 048 characters, over 2 048 bytes.
    expect(cyrillic.length).toBeLessThan(maxLabelBytes);
    expect(historyRowProblem([cyrillic])).toContain(
      `${maxLabelBytes + 2} bytes`,
    );
    expect(historyRowProblem(['A\nB'])).toContain('line feed');
    expect(historyRowProblem([''])).toContain('empty');
    expect(
      historyRowProblem(
        Array.from({ length: maxRowsPerPage + 1 }, (_, index) => `L${index}`),
      ),
    ).toContain(`${maxRowsPerPage + 1} distinct history lines`);
  });
});

describe('page helpers', () => {
  test('finds duplicated users, distinct labels in first-seen order and missing labels', () => {
    const page = [
      { entries: ['B', 'A'], id: 5 },
      { entries: ['A', 'C'], id: 2 },
      { entries: [], id: 5 },
    ];

    expect(duplicateUserIds(page)).toEqual([5]);
    expect(pageLabels(page)).toEqual(['B', 'A', 'C']);
    expect(missingLabels(['B', 'A', 'C'], new Map([['A', 1]]))).toEqual([
      'B',
      'C',
    ]);
  });

  test('plans unique pairs with first-occurrence sort in a deterministic order', () => {
    const ids = new Map([
      ['A', 10],
      ['B', 11],
    ]);

    expect(
      planMemberships(
        [
          { entries: ['B', 'A', 'B'], id: 9 },
          { entries: ['A'], id: 4 },
          { entries: [], id: 6 },
        ],
        ids,
      ),
    ).toEqual([
      { entry: 10, moodle_user: 4, sort: 0 },
      { entry: 11, moodle_user: 9, sort: 0 },
      { entry: 10, moodle_user: 9, sort: 1 },
    ]);
    expect(() => planMemberships([{ entries: ['Z'], id: 1 }], ids)).toThrow(
      noEntryIdPattern,
    );
  });
});

describe('option contract', () => {
  test('parses an index page and treats the rendered text undefined as absent', () => {
    expect(coordinatorActions).toContain('index_page');
    expect(
      parseCoordinatorInput({
        action: 'index_page',
        page: firstPage,
        rows: '[{"id":7,"entries":["A"," a "],"extra":1}]',
        token: uuid,
      }),
    ).toEqual({
      action: 'index_page',
      page: firstPage,
      rows: [{ entries: ['A', ' a '], id: 7 }],
      token: uuid,
    });
    expect(
      parseCoordinatorInput({
        action: 'claim',
        domain: history,
        retry: 'undefined',
      }),
    ).toEqual({ action: 'claim', domain: history, retry: false });
  });

  test('refuses an oversized page, a broken or over-long label and a bad user id as a 400', () => {
    const oversized = Array.from({ length: pageSize + 1 }, (_, index) => ({
      entries: ['A'],
      id: index + 1,
    }));

    for (const rows of [
      oversized,
      [{ entries: ['A\nB'], id: 1 }],
      [{ entries: ['x'.repeat(maxLabelBytes + 1)], id: 1 }],
      [{ entries: [''], id: 1 }],
      [{ entries: ['A'], id: 0 }],
      'undefined',
    ]) {
      expect(() => parseCoordinatorInput(indexOptions(rows))).toThrow(
        expect.objectContaining({
          code: 'COORDINATION_INVALID_OPTIONS',
          status: 400,
        }),
      );
    }

    expect(
      parseCoordinatorInput(indexOptions(oversized.slice(0, pageSize))).action,
    ).toBe('index_page');
    // The refusal names the Moodle user whose raw history needs fixing.
    expect(() =>
      parseCoordinatorInput(
        indexOptions([
          { entries: ['A'], id: 7 },
          { entries: ['A', 'x'.repeat(maxLabelBytes + 5)], id: 42 },
        ]),
      ),
    ).toThrow(
      `rows.1.entries: Moodle user 42: a history line of ${maxLabelBytes + 5} bytes`,
    );
  });

  test('keeps the refusal of a page full of invalid labels bounded', () => {
    const badLines = Array.from({ length: 200 }, (_, line) => `bad ${line}\n`);
    const rows = Array.from({ length: pageSize }, (_, index) => ({
      entries: badLines,
      id: index + 1,
    }));
    const failure = (() => {
      try {
        parseCoordinatorInput(indexOptions(rows));
        return null;
      } catch (error) {
        return z.object({ message: z.string() }).parse(error);
      }
    })();

    expect(failure?.message).toContain('Moodle user 1:');
    expect(failure?.message).toContain(`and ${pageSize - 5} more issues`);
    expect(failure?.message.length).toBeLessThan(1_800);
  });
});

describe('index writer', () => {
  test('creates each exact label once and one membership per user and entry', async () => {
    const { fake, token } = await seeded();
    const before = fake.data.sourceRevision;

    await expect(indexPage(fake, { rows: pageRows(), token })).resolves.toEqual(
      {
        entriesCreated: 5,
        membershipsRemoved: 0,
        membershipsWritten: 5,
        page: firstPage,
        users: 3,
      },
    );
    expect(labelsOf(fake)).toEqual([
      'Alpha',
      'Beta',
      'alpha',
      ' Alpha',
      'Alpha ',
    ]);
    expect(memberships(fake)).toEqual([
      [1, 1, 0],
      [1, 2, 1],
      [2, 3, 0],
      [2, 4, 1],
      [2, 5, 2],
    ]);
    expect(
      fake.data.history.entries.every(
        ({ review_state }) => review_state === 'needs_mapping',
      ),
    ).toBeTruthy();
    // The entry statement bumped the revision like the source trigger
    // does; the claim adopted it, so the run can still complete.
    expect(fake.data.sourceRevision).toBe(before + 1);
    expect(fake.data.claim?.revision).toBe(before + 1);
    expect(fake.data.dirtyDomains).toEqual([
      history,
      'enrollments',
      'publication',
    ]);

    // A replay creates nothing, replaces the same rows and bumps nothing.
    await expect(indexPage(fake, { rows: pageRows(), token })).resolves.toEqual(
      {
        entriesCreated: 0,
        membershipsRemoved: 5,
        membershipsWritten: 5,
        page: firstPage,
        users: 3,
      },
    );
    expect(fake.data.sourceRevision).toBe(before + 1);
    await expect(
      runAction({ action: 'complete', token }, context(fake)),
    ).resolves.toEqual({
      completed: true,
      domain: history,
      installed: 0,
      retries: 0,
      revision: before + 1,
    });
    expect(fake.data.dirtyDomains).toEqual(['enrollments', 'publication']);
  });

  test('never updates an existing entry and never deletes entries or mappings', async () => {
    const { fake, token } = await seeded();
    fake.data.history.entries.push({
      id: 40,
      label: 'Alpha',
      review_reason: 'checked by hand',
      review_state: 'mapped',
    });
    fake.data.history.mappings.push({ academic_year: 1, course: 1, entry: 40 });
    fake.data.history.memberships.push(
      { entry: 40, moodle_user: 1, sort: 0 },
      { entry: 40, moodle_user: 7, sort: 0 },
    );

    await expect(
      indexPage(fake, { rows: pageRows(), token }),
    ).resolves.toMatchObject({
      entriesCreated: 4,
      membershipsRemoved: 1,
      membershipsWritten: 5,
    });
    expect(fake.data.history.entries[0]).toEqual({
      id: 40,
      label: 'Alpha',
      review_reason: 'checked by hand',
      review_state: 'mapped',
    });
    expect(fake.data.history.mappings).toEqual([
      { academic_year: 1, course: 1, entry: 40 },
    ]);
    // A user outside the page keeps its memberships.
    expect(memberships(fake)).toContainEqual([7, 40, 0]);

    // The next snapshot no longer carries Alpha for anyone in the page.
    await expect(
      indexPage(fake, {
        rows: [
          { entries: ['Beta'], id: 1 },
          { entries: [], id: 2 },
          { entries: [], id: 3 },
        ],
        token,
      }),
    ).resolves.toMatchObject({
      entriesCreated: 0,
      membershipsRemoved: 5,
      membershipsWritten: 1,
    });
    expect(labelsOf(fake)).toContain('Alpha');
    expect(fake.data.history.mappings).toHaveLength(1);
    expect(memberships(fake)).toEqual([
      [7, 40, 0],
      [1, 41, 0],
    ]);
  });

  test('reports the index against the raw counts without listing anyone', async () => {
    const { fake, token } = await seeded();
    await indexPage(fake, { rows: pageRows(), token });

    // User 1 counts 3 raw lines but carries 2 distinct entries, user 2
    // counts 2 but carries 3 variants, user 3 has no count and no entries.
    await expect(statusAction(context(fake))).resolves.toMatchObject({
      historyIndex: {
        countMismatches: 2,
        entries: 5,
        indexedUsers: 2,
        memberships: 5,
        needsMapping: 5,
        users: 3,
      },
    });
  });
});

describe('multi-page runs', () => {
  test('indexes two planned pages serially, each adopting the revision its own entries caused', async () => {
    const fake = new FakeCoordination();
    const ids = Array.from({ length: pageSize + 3 }, (_, index) => index + 1);
    fake.sourceIds.history = ids;
    fake.sourceWrite('moodle_users');
    const token = await claimDomain(fake, history);
    const plan = z
      .object({ pages: z.array(z.object({ rows: z.number() })) })
      .parse(await planHistory(fake, token));

    expect(plan.pages.map(({ rows }) => rows)).toEqual([pageSize, 3]);

    const rowsOf = (from: number, to: number, label: string): PageRows =>
      ids
        .filter((id) => id >= from && id <= to)
        .map((id) => ({ entries: [label, `${label} ${id % 2}`], id }));
    const start = fake.data.sourceRevision;

    await expect(
      indexPage(fake, { rows: rowsOf(1, pageSize, 'First'), token }),
    ).resolves.toMatchObject({
      entriesCreated: 3,
      membershipsWritten: pageSize * 2,
      users: pageSize,
    });
    expect(fake.data.claim?.revision).toBe(start + 1);
    await expect(
      indexPage(fake, {
        page: secondPage,
        rows: rowsOf(pageSize + 1, pageSize + 3, 'Second'),
        token,
      }),
    ).resolves.toMatchObject({
      entriesCreated: 3,
      membershipsWritten: 6,
      page: secondPage,
      users: 3,
    });
    expect(fake.data.claim?.revision).toBe(start + 2);
    expect(fake.data.claim?.staged).toEqual([firstPage, secondPage]);
    await expect(
      runAction({ action: 'complete', token }, context(fake)),
    ).resolves.toEqual({
      completed: true,
      domain: history,
      installed: 0,
      retries: 0,
      revision: start + 2,
    });
    expect(fake.data.history.memberships).toHaveLength(pageSize * 2 + 6);
    expect(fake.data.dirtyDomains).toEqual(['enrollments', 'publication']);
  });
});

describe('index guards', () => {
  test('refuses a page that does not name exactly the users of its planned range', async () => {
    const { fake, token } = await seeded();
    const [one, two] = pageRows();

    if (one === undefined || two === undefined) {
      throw new Error('no page rows');
    }

    // A Read Data capped by QUERY_LIMIT_MAX answers the first users only.
    const truncated = await failureOf(
      indexPage(fake, { rows: [one, two], token }),
    );
    const outside = await failureOf(
      indexPage(fake, {
        rows: [...pageRows(), { entries: ['Alpha'], id: 99 }],
        token,
      }),
    );
    const swapped = await failureOf(
      indexPage(fake, { rows: [one, two, { entries: [], id: 4 }], token }),
    );

    for (const failure of [truncated, outside, swapped]) {
      expect(failure).toEqual({
        code: 'COORDINATION_PAGE_INCOMPLETE',
        status: 409,
      });
    }

    expect(fake.data.history.entries).toEqual([]);
    expect(fake.data.history.memberships).toEqual([]);
    expect(fake.data.claim?.staged).toEqual([]);
    expect(fake.data.claim?.token).toBe(token);
    await expect(
      runAction({ action: 'complete', token }, context(fake)),
    ).rejects.toMatchObject({ code: 'COORDINATION_PAGES_MISSING' });
  });

  test('refuses a page of a plan stored without its ranges', async () => {
    const { fake, token } = await seeded();
    const claim = fake.data.claim;

    if (claim === null) {
      throw new Error('no claim');
    }

    claim.ranges = [];

    await expect(
      failureOf(indexPage(fake, { rows: pageRows(), token })),
    ).resolves.toEqual({ code: 'COORDINATION_PAGE_INCOMPLETE', status: 409 });
    expect(fake.data.history.entries).toEqual([]);
  });

  test('writes memberships only after the writer opened the guard of its transaction', async () => {
    const data = freshHistory();
    const port = fakeHistoryPort(
      () => data,
      () => {},
    );

    await expect(port.deleteMemberships([1])).rejects.toThrow(
      membershipGuardMessage,
    );
    await expect(
      port.insertMemberships([{ entry: 1, moodle_user: 1, sort: 0 }]),
    ).rejects.toThrow(membershipGuardMessage);

    await port.openWriter();

    await expect(
      port.insertMemberships([{ entry: 1, moodle_user: 1, sort: 0 }]),
    ).resolves.toBe(1);
    expect(pageCoverage([1, 2, 3], [3, 1, 9])).toEqual({
      missing: 1,
      unexpected: 1,
    });
  });

  test('refuses duplicates, an unplanned page, a stale token and a foreign owner without writing', async () => {
    const { fake, token } = await seeded();
    const duplicate = [
      { entries: ['A'], id: 1 },
      { entries: ['B'], id: 1 },
    ];

    await expect(
      failureOf(indexPage(fake, { rows: duplicate, token })),
    ).resolves.toEqual({ code: 'COORDINATION_DUPLICATE_ROWS', status: 400 });
    await expect(
      failureOf(indexPage(fake, { page: secondPage, rows: pageRows(), token })),
    ).resolves.toEqual({ code: 'COORDINATION_PAGE_UNPLANNED', status: 409 });
    await expect(
      failureOf(indexPage(fake, { rows: pageRows(), token: uuid })),
    ).resolves.toEqual({ code: 'COORDINATION_CLAIM_MISMATCH', status: 409 });
    await expect(
      failureOf(indexPage(fake, { rows: pageRows(), token }, 'process-b')),
    ).resolves.toEqual({ code: 'COORDINATION_OWNER_MISMATCH', status: 409 });
    expect(fake.data.history.entries).toEqual([]);
    expect(fake.data.history.memberships).toEqual([]);
  });

  test('refuses a page under an enrollment claim', async () => {
    const fake = new FakeCoordination();
    fake.graphs = { calculation: graphA, publication: graphA };
    fake.data.calculationFingerprint = graphA;
    fake.sourceIds.history = [1];
    fake.sourceIds.rules = [1];
    fake.sourceWrite('academic_years');
    const token = await claimDomain(fake, 'enrollments');

    // The users are never planned under an enrollment claim; a page
    // planned from its rules still names p0001 for the writer to refuse.
    await expect(failureOf(planHistory(fake, token))).resolves.toEqual({
      code: 'COORDINATION_DOMAIN_MISMATCH',
      status: 409,
    });

    await runAction(
      { action: 'plan_pages', source: 'rules', token },
      context(fake),
    );

    await expect(
      failureOf(indexPage(fake, { rows: [{ entries: ['A'], id: 1 }], token })),
    ).resolves.toEqual({ code: 'COORDINATION_DOMAIN_MISMATCH', status: 409 });
    expect(fake.data.history.entries).toEqual([]);
  });

  test('discards a page overtaken by a source change and leaves the prior index in place', async () => {
    const { fake, token } = await seeded();
    await indexPage(fake, { rows: pageRows(), token });
    const before = memberships(fake);
    fake.sourceWrite('moodle_users');

    await expect(
      failureOf(
        indexPage(fake, {
          rows: [
            { entries: ['Gamma'], id: 1 },
            { entries: [], id: 2 },
            { entries: [], id: 3 },
          ],
          token,
        }),
      ),
    ).resolves.toEqual({ code: 'COORDINATION_SOURCE_CHANGED', status: 409 });
    expect(memberships(fake)).toEqual(before);
    expect(labelsOf(fake)).not.toContain('Gamma');
    expect(fake.data.claim).toBeNull();
    expect(fake.data.lastError?.code).toBe('SOURCE_CHANGED');
    expect(fake.data.dirtyDomains).toContain(history);
  });

  test('refuses to complete a planned history run with a page still missing', async () => {
    const { fake, token } = await seeded();

    await expect(
      failureOf(runAction({ action: 'complete', token }, context(fake))),
    ).resolves.toEqual({ code: 'COORDINATION_PAGES_MISSING', status: 409 });
    expect(fake.data.claim?.token).toBe(token);

    const check = { currentFingerprint: graphA, owner: processA, token: uuid };

    expect(
      decideCompletion(
        liveState({ pages: [firstPage, secondPage], staged: [firstPage] }),
        check,
      ),
    ).toEqual({ kind: 'pages_missing', missing: [secondPage] });
    // A history run that never planned cannot mark the index current.
    expect(decideCompletion(liveState({}), check)).toEqual({
      kind: 'unplanned',
    });
    expect(decideCompletion(liveState({ pages: [] }), check)).toEqual({
      kind: 'ok',
    });
    expect(
      decideCompletion(
        liveState({ domain: 'publication', pages: [firstPage] }),
        check,
      ),
    ).toEqual({ kind: 'ok' });
  });
});

describe('derived index guards', () => {
  test('refuse every Directus item write on the memberships with a 403', () => {
    const registered: Array<{ event: string; handler: () => never }> = [];
    registerWriteGuards((event, handler) => {
      if (event.startsWith('moodle_history_memberships.')) {
        registered.push({ event, handler });
      }
    });

    expect(registered.map(({ event }) => event)).toEqual([
      'moodle_history_memberships.items.create',
      'moodle_history_memberships.items.update',
      'moodle_history_memberships.items.delete',
    ]);

    for (const { handler } of registered) {
      expect(() => handler()).toThrow(
        expect.objectContaining({
          code: 'COORDINATION_WRITE_GUARDED',
          status: 403,
        }),
      );
    }
  });

  test('mark the index stale when an entry is deleted, not when it is reviewed', async () => {
    const { fake, token } = await seeded();
    await indexPage(fake, { rows: pageRows(), token });
    await runAction({ action: 'complete', token }, context(fake));

    fake.sourceWrite('moodle_course_entries', 'update');

    expect(fake.data.dirtyDomains).toEqual(['enrollments', 'publication']);

    fake.sourceWrite('moodle_course_entries', 'delete');

    expect(fake.data.dirtyDomains).toEqual([
      history,
      'enrollments',
      'publication',
    ]);
    await expect(
      runAction(
        { action: 'claim', domain: history, retry: false },
        context(fake),
      ),
    ).resolves.toMatchObject({ claimed: true });
  });
});

describe('run scripts', () => {
  test('split the histories of a page exactly like the contract', () => {
    const page = vector.map((Courses, index) => ({ Courses, id: index + 1 }));

    expect(runScript(splitEntriesScript, { read_histories: page })).toEqual(
      page.map(({ Courses, id }) => ({
        entries: splitHistoryEntries(Courses),
        id,
      })),
    );
    expect(() =>
      runScript(splitEntriesScript, { read_histories: null }),
    ).toThrow(noRowListPattern);
  });

  test('describe the first failure of a run in a bounded message', () => {
    const pageFailure = {
      code: 'COORDINATION_INVALID_OPTIONS',
      message: `Invalid coordination options (rows.3.entries: Moodle user 42: a history line ${'x'.repeat(2_000)}`,
      ok: false,
      page: secondPage,
      stage: 'index',
    };
    const described = z.string().parse(
      runScript(describeFailureScript, {
        index: {
          failed: [pageFailure, { code: 'NO_RESULT', ok: false }],
          ok: false,
        },
      }),
    );

    expect(described).toContain(
      `failed at page ${secondPage} (index): COORDINATION_INVALID_OPTIONS Invalid coordination options (rows.3.entries: Moodle user 42:`,
    );
    expect(described).toContain('1 more page(s) failed as well.');
    expect(described.length).toBeLessThan(600);
    expect(
      runScript(describeFailureScript, {
        index: { code: 'X', message: 'plan refused', ok: false, stage: 'plan' },
      }),
    ).toContain('failed at the run (plan): X plan refused.');
    expect(runScript(describeFailureScript, { index: null })).toContain(
      'failed at the run: NO_RESULT no result.',
    );
  });

  test('attach the claim token to every page and sum the page results', () => {
    const pages = [
      { from: 1, rows: 2, to: 2, token: firstPage },
      { from: 5, rows: 1, to: 5, token: secondPage },
    ];

    expect(
      runScript(pagesWithTokenScript, {
        $trigger: { token: uuid },
        plan_pages: { pages },
      }),
    ).toEqual(pages.map((page) => ({ ...page, claim: uuid })));
    expect(() =>
      runScript(pagesWithTokenScript, { $trigger: {}, plan_pages: { pages } }),
    ).toThrow(noClaimTokenPattern);

    const failure = { code: 'X', message: 'boom', ok: false, page: secondPage };

    expect(
      runScript(summaryScript, {
        index_pages: [
          {
            entriesCreated: 2,
            membershipsWritten: 7,
            page: firstPage,
            users: 3,
          },
          failure,
          null,
        ],
      }),
    ).toEqual({
      entriesCreated: 2,
      failed: [failure, { code: 'NO_RESULT', ok: false }],
      membershipsWritten: 7,
      ok: false,
      pages: 3,
      users: 3,
    });
    expect(runScript(summaryScript, { index_pages: [] })).toMatchObject({
      ok: true,
      pages: 0,
    });
  });
});
