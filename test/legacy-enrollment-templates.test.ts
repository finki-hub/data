import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import operationApp from '../directus/extensions/directus-extension-data-operations/src/app.js';
import { coordinatorActions } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import {
  legacyEnrollmentFlows,
  legacyParentFlow,
} from '../src/flows/count-legacy-enrollments.js';
import {
  countHistoryPagePath,
  legacyPageFlow,
} from '../src/flows/count-legacy-rule-page.js';
import {
  legacyZerosFlow,
  sumCountsPath,
} from '../src/flows/fill-legacy-zeros.js';
import {
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  insertionOrder,
} from '../src/flows/flow-template.js';
import {
  legacyPageCheckScript,
  legacyPagesCheckScript,
  legacyPagesScript,
  zeroPageCheckScript,
  zeroPagesCheckScript,
} from '../src/flows/legacy-scripts.js';
import { installFlowFamily } from '../src/flows/registry.js';
import {
  legacyEnrollmentFlowIds,
  legacyRuleMode,
} from '../src/flows/shared.js';
import { relayBound } from '../src/flows/text-fragments.js';
import { claim, refusalOf, runScript } from './legacy-enrollment-helpers.js';

const flowsDirectory = join(import.meta.dirname, '..', 'directus', 'flows');
const countScript = await readFile(
  join(flowsDirectory, 'count-history-page.cjs'),
  'utf8',
);
const sumScript = await readFile(
  join(flowsDirectory, 'sum-counts.cjs'),
  'utf8',
);
const otherClaim = 'another claim';
const legacyAnswerRefusal =
  /^(?:Legacy page p\d{4}: invalid summary|count_pages: results \w+, expected \d+)$/u;
const zeroAnswerRefusal =
  /^(?:Zero page p\d{4}: invalid summary|fill_zeros: results \w+, expected \d+)$/u;

// The stored plan of an enrollments claim with one mapped page and two
// legacy rule pages (rules 10-14 and 15) crossed with two history pages.
const plannedPages = [
  { from: 1, kind: 'mapped', rows: 2, to: 3, token: 'p0001' },
  {
    bytes: 120,
    from: 1,
    kind: 'legacy',
    rows: 9,
    rules: { bytes: 60, from: 10, rows: 3, to: 14 },
    to: 9,
    token: 'p0002',
  },
  {
    bytes: 80,
    from: 10,
    kind: 'legacy',
    rows: 4,
    rules: { bytes: 60, from: 10, rows: 3, to: 14 },
    to: 20,
    token: 'p0003',
  },
  { from: 10, kind: 'legacy_zeros', rows: 3, to: 14, token: 'p0004' },
  {
    bytes: 120,
    from: 1,
    kind: 'legacy',
    rows: 9,
    rules: { bytes: 25, from: 15, rows: 1, to: 15 },
    to: 9,
    token: 'p0005',
  },
  {
    bytes: 80,
    from: 10,
    kind: 'legacy',
    rows: 4,
    rules: { bytes: 25, from: 15, rows: 1, to: 15 },
    to: 20,
    token: 'p0006',
  },
  { from: 15, kind: 'legacy_zeros', rows: 1, to: 15, token: 'p0007' },
];
const status = {
  claim_domain: 'enrollments',
  claim_pages: plannedPages,
  claim_revision: 7,
  claim_staged: ['p0001', 'p0002', 'p0003'],
  claim_token: claim,
};
// The legacy page p0002 and the zero page p0004 as the parent passes them.
const cellTrigger = {
  bytes: 120,
  claim,
  from: 1,
  revision: 7,
  rows: 9,
  rules: { bytes: 60, from: 10, rows: 3, to: 14 },
  to: 9,
  token: 'p0002',
};
const zeroTrigger = {
  claim,
  from: 10,
  revision: 7,
  rows: 3,
  to: 14,
  token: 'p0004',
};
const planRefusal = /^Page p\d{4}: .+$/u;
const kindRefusal =
  /: kind (?:legacy|legacy_zeros|mapped|rules), expected (?:legacy|legacy_zeros)$/u;
const rangeRefusal = /: range differs from plan: /u;
const foreignClaim = /: claim is not the current claim$/u;
const otherRevision = /: revision 6, expected 7$/u;
const otherDomain = /: claim domain history_index, expected enrollments$/u;
const unplannedPage = /: not planned under this claim$/u;
const unstagedCells = /: legacy pages not staged: 1 of 2$/u;
const noEnrollmentsPlan = /^Legacy count: no enrollments plan$/u;
const pageFailed =
  /^Legacy page p0003 failed \[count LEGACY_COUNT_FAILED\]: Rule 12 .+$/u;
const zeroFailed = /^Zero page p0004 failed \[sums INVALID_QUERY\]: bad$/u;

describe('legacy plan checks', () => {
  const checkCell = (trigger: unknown, readPlan: unknown = [status]) =>
    runScript(legacyPageCheckScript, {
      $trigger: trigger,
      read_plan: readPlan,
    });
  const checkZeros = (trigger: unknown, readPlan: unknown = [status]) =>
    runScript(zeroPageCheckScript, { $trigger: trigger, read_plan: readPlan });

  test('answer a legacy page exactly as the claim planned it', () => {
    expect(checkCell(cellTrigger)).toEqual({
      claim,
      revision: 7,
      rules: { bytes: 60, from: 10, rows: 3, to: 14 },
      token: 'p0002',
      users: { bytes: 120, from: 1, rows: 9, to: 9 },
    });
  });

  test.each([
    [
      'the mapped page',
      { ...cellTrigger, token: 'p0001' },
      [status],
      kindRefusal,
    ],
    ['a zero page', { ...cellTrigger, token: 'p0004' }, [status], kindRefusal],
    [
      'a page of a rules plan',
      cellTrigger,
      [
        {
          ...status,
          claim_pages: [{ from: 1, rows: 9, to: 9, token: 'p0002' }],
        },
      ],
      kindRefusal,
    ],
    ['other bytes', { ...cellTrigger, bytes: 121 }, [status], rangeRefusal],
    [
      'another user range',
      { ...cellTrigger, to: 8, rows: 8 },
      [status],
      rangeRefusal,
    ],
    [
      'the rules of another rule page',
      { ...cellTrigger, rules: { bytes: 25, from: 15, rows: 1, to: 15 } },
      [status],
      rangeRefusal,
    ],
    [
      'other pattern bytes',
      { ...cellTrigger, rules: { ...cellTrigger.rules, bytes: 61 } },
      [status],
      rangeRefusal,
    ],
    [
      'an unplanned page',
      { ...cellTrigger, token: 'p0009' },
      [status],
      unplannedPage,
    ],
    [otherClaim, { ...cellTrigger, claim: otherClaim }, [status], foreignClaim],
    [
      'another revision',
      { ...cellTrigger, revision: 6 },
      [status],
      otherRevision,
    ],
    [
      'a history index claim',
      cellTrigger,
      [{ ...status, claim_domain: 'history_index' }],
      otherDomain,
    ],
  ])('refuse %s as a legacy page before anything is read', (...row) => {
    const [, trigger, readPlan, reason] = row;
    const message = refusalOf(() => checkCell(trigger, readPlan));

    expect(message).toMatch(planRefusal);
    expect(message).toMatch(reason);
    expect(message).not.toContain(claim);
    expect(message).not.toContain(otherClaim);
  });

  test('answer a zero page with the legacy pages of its rule page once they are staged', () => {
    expect(checkZeros(zeroTrigger)).toEqual({
      cells: ['p0002', 'p0003'],
      claim,
      from: 10,
      revision: 7,
      rows: 3,
      to: 14,
      token: 'p0004',
    });
    expect(
      checkZeros(zeroTrigger, [
        {
          ...status,
          claim_pages: [plannedPages[3]],
          claim_staged: [],
        },
      ]),
    ).toMatchObject({ cells: [] });
  });

  test.each([
    [
      'a zero page whose legacy pages are not all staged',
      zeroTrigger,
      [{ ...status, claim_staged: ['p0001', 'p0002'] }],
      unstagedCells,
    ],
    [
      'a legacy page',
      { ...zeroTrigger, token: 'p0002' },
      [status],
      kindRefusal,
    ],
    [
      'another rule range',
      { ...zeroTrigger, rows: 2, to: 12 },
      [status],
      rangeRefusal,
    ],
    [otherClaim, { ...zeroTrigger, claim: otherClaim }, [status], foreignClaim],
  ])('refuse %s before a sum is read', (...row) => {
    const [, trigger, readPlan, reason] = row;
    const message = refusalOf(() => checkZeros(trigger, readPlan));

    expect(message).toMatch(planRefusal);
    expect(message).toMatch(reason);
  });

  test('list the legacy and zero pages of the enrollments plan for the parent', () => {
    const listed = z
      .object({
        cells: z.array(z.record(z.string(), z.unknown())),
        revision: z.number(),
        zeros: z.array(z.record(z.string(), z.unknown())),
      })
      .parse(
        runScript(legacyPagesScript, {
          $trigger: { claim },
          read_plan: [status],
        }),
      );

    expect(listed.revision).toBe(7);
    expect(listed.cells.map(({ token }) => token)).toEqual([
      'p0002',
      'p0003',
      'p0005',
      'p0006',
    ]);
    expect(listed.cells[0]).toEqual(cellTrigger);
    expect(listed.zeros).toEqual([
      zeroTrigger,
      { claim, from: 15, revision: 7, rows: 1, to: 15, token: 'p0007' },
    ]);
  });

  test.each([
    [otherClaim, { claim: otherClaim }, [status], foreignClaim],
    [
      'a rules plan',
      { claim },
      [
        {
          ...status,
          claim_pages: [{ from: 1, rows: 2, to: 3, token: 'p0001' }],
        },
      ],
      noEnrollmentsPlan,
    ],
    [
      'no plan',
      { claim },
      [{ ...status, claim_pages: null }],
      noEnrollmentsPlan,
    ],
    [
      'a history index claim',
      { claim },
      [{ ...status, claim_domain: 'history_index' }],
      otherDomain,
    ],
  ])('refuse to list the pages of %s', (...row) => {
    const [, trigger, readPlan, reason] = row;
    const message = refusalOf(() =>
      runScript(legacyPagesScript, { $trigger: trigger, read_plan: readPlan }),
    );

    expect(message).toMatch(reason);
    expect(message).not.toContain(claim);
  });
});

// The pages the parent lists for a trigger payload, from the stored plan.
const listedPages = (trigger: unknown) =>
  runScript(legacyPagesScript, { $trigger: trigger, read_plan: [status] });

// A one-rule page names its planned ranges with the singular noun.
describe('legacy range refusals', () => {
  test('count the planned ranges of a one-rule page in the singular', () => {
    const rules = { bytes: 26, from: 15, rows: 1, to: 15 };
    const zeros = { ...zeroTrigger, from: 15, rows: 2, to: 16 };

    expect(
      refusalOf(() =>
        runScript(legacyPageCheckScript, {
          $trigger: { ...cellTrigger, rules, token: 'p0005' },
          read_plan: [status],
        }),
      ),
    ).toBe(
      'Page p0005: range differs from plan: users 1-9 (9 rows, 120 bytes), rules 15-15 (1 row, 25 bytes)',
    );
    expect(
      refusalOf(() =>
        runScript(zeroPageCheckScript, {
          $trigger: { ...zeros, token: 'p0007' },
          read_plan: [status],
        }),
      ),
    ).toBe('Page p0007: range differs from plan: rules 15-15 (1 row)');
  });
});

// "Data / Run enrollment family" hands the parent the whole family; the
// stored plan stays the authority, whatever pages the payload lists.
describe('legacy family payload', () => {
  test('lists the same pages from the family the family runner hands over', () => {
    const family = {
      claim,
      kind: legacyRuleMode.mode,
      pages: plannedPages.slice(0, 2),
      revision: 7,
      runner: legacyEnrollmentFlowIds.parent,
    };

    expect(listedPages(family)).toEqual(listedPages({ claim }));
  });
});

describe('legacy parent checks', () => {
  const cells = [
    { ...cellTrigger },
    { ...cellTrigger, bytes: 80, from: 10, rows: 4, to: 20, token: 'p0003' },
  ];
  const zeros = [zeroTrigger];
  const checkPages = (results: unknown) =>
    runScript(legacyPagesCheckScript, {
      count_pages: results,
      legacy_pages: { cells, revision: 7, zeros },
    });
  const checkFills = (results: unknown) =>
    runScript(zeroPagesCheckScript, {
      fill_zeros: results,
      legacy_pages: { cells, revision: 7, zeros },
    });
  const pageAnswers = [
    { page: 'p0002', rules: 3, staged: 2, users: 9 },
    { page: 'p0003', rules: 3, staged: 0, users: 4 },
  ];

  test('sum the answers of every legacy and zero page', () => {
    expect(checkPages(pageAnswers)).toEqual({ pages: 2, staged: 2 });
    expect(
      checkFills([
        { counted: 2, page: 'p0004', rules: 3, staged: 1, zeros: 1 },
      ]),
    ).toEqual({ counted: 2, pages: 1, pairs: 3, zeros: 1 });
  });

  test('turn the first failed page into a bounded refusal naming its stage', () => {
    const failure = {
      code: 'LEGACY_COUNT_FAILED',
      message: `Rule 12 (course 3 / academic year 6): pattern does not compile ${'x'.repeat(2_000)}`,
      ok: false,
      page: 'p0003',
      stage: 'count',
    };
    const message = refusalOf(() => checkPages([pageAnswers[0], failure]));

    expect(message).toMatch(pageFailed);
    expect(message).toHaveLength(relayBound);
    expect(
      refusalOf(() =>
        checkFills([
          {
            code: 'INVALID_QUERY',
            message: 'bad',
            ok: false,
            page: 'p0004',
            stage: 'sums',
          },
        ]),
      ),
    ).toMatch(zeroFailed);
  });

  test.each([
    ['fewer answers than pages', [pageAnswers[0]]],
    ['no answer list', null],
    ['an answer of another page', [pageAnswers[1], pageAnswers[0]]],
    [
      'a user count off the plan',
      [{ ...pageAnswers[0], users: 8 }, pageAnswers[1]],
    ],
    [
      'a rule count off the plan',
      [{ ...pageAnswers[0], rules: 2 }, pageAnswers[1]],
    ],
    [
      'more staged rows than rules',
      [{ ...pageAnswers[0], staged: 4 }, pageAnswers[1]],
    ],
    ['a missing answer', [null, pageAnswers[1]]],
  ])('refuse %s', (_name, results) => {
    expect(() => checkPages(results)).toThrow(legacyAnswerRefusal);
  });

  test.each([
    [
      'a zero page that counted more pairs than it has',
      [{ counted: 3, page: 'p0004', rules: 3, staged: 1, zeros: 1 }],
    ],
    [
      'staged rows that are not its zeros',
      [{ counted: 2, page: 'p0004', rules: 3, staged: 0, zeros: 1 }],
    ],
    ['no answer', []],
  ])('refuse %s', (_name, results) => {
    expect(() => checkFills(results)).toThrow(zeroAnswerRefusal);
  });
});

const legacyFamily = /^6a1d9f0e-2b3c-4d5e-8f70-0000000012[0-9a-f]{2}$/u;
const flowBody = z.object({ id: z.string(), status: z.string() });
const knownActions: readonly string[] = coordinatorActions;
const logicalOperators = /_and|_none|_or|_some/u;
const collator = new Intl.Collator('en');

const step = (flow: FlowTemplate, key: string) => {
  const found = flow.operations.find((candidate) => candidate.key === key);
  if (found === undefined) {
    throw new Error(`no operation ${key}`);
  }
  return found;
};

const keyOf = (flow: FlowTemplate, id: null | string) =>
  flow.operations.find((candidate) => candidate.id === id)?.key ?? null;

const edges = (flow: FlowTemplate, key: string) => [
  keyOf(flow, step(flow, key).resolve),
  keyOf(flow, step(flow, key).reject),
];

const flowIds = (flow: FlowTemplate): string[] => [
  flow.id,
  ...flow.operations.map(({ id }) => id),
];

const recordKeys = (flow: FlowTemplate, key: string): string[] =>
  Object.keys(
    z.record(z.string(), z.unknown()).parse(step(flow, key).options['json']),
  ).toSorted((left, right) => collator.compare(left, right));

// Every rejection of a child Flow step fails the claim at once, so the
// later pages of the parent's serial run refuse in check_page instead of
// counting (a pathological rule times out once, not once per history
// page), and then answers a record with that step's own code and message.
const expectFailBranches = (
  flow: FlowTemplate,
  branches: ReadonlyArray<readonly [string, string, string]>,
): void => {
  for (const [source, stage, code] of branches) {
    const [, failing] = edges(flow, source);

    expect(failing).toBe(`${stage}_fail`);
    expect(step(flow, failing ?? '')).toMatchObject({
      options: {
        action: 'fail',
        code: 'LEGACY_COUNT_FAILED',
        token: '{{ $trigger.claim }}',
      },
      reject: null,
      type: coordinateOperation,
    });

    const [record] = edges(flow, failing ?? '');

    expect(record).toBe(`${stage}_failed`);
    expect(step(flow, record ?? '').options).toEqual({
      json: {
        code,
        message: `{{ ${source}.message }}`,
        ok: false,
        page: '{{ $trigger.token }}',
        stage,
      },
    });
  }
};

describe('legacy enrollment Flow templates', () => {
  test('use deterministic ids, unique keys, tree edges, activity logging and a coordinator step', () => {
    const ids = legacyEnrollmentFlows.flatMap(flowIds);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => legacyFamily.test(id))).toBeTruthy();
    expect(legacyEnrollmentFlows.map(({ id }) => id)).toEqual([
      legacyEnrollmentFlowIds.page,
      legacyEnrollmentFlowIds.zeros,
      legacyEnrollmentFlowIds.parent,
    ]);
    expect(legacyEnrollmentFlows.map(({ name }) => name)).toEqual([
      'Data / Count legacy rules page',
      'Data / Fill legacy rule zeros',
      'Data / Count legacy enrollments',
    ]);

    for (const flow of legacyEnrollmentFlows) {
      const own = new Set(flow.operations.map(({ id }) => id));
      const keys = flow.operations.map(({ key }) => key);
      const places = flow.operations.map(
        ({ position_x, position_y }) => `${position_x}/${position_y}`,
      );

      expect(flow.accountability).toBe('activity');
      expect(flow.trigger).toBe('operation');
      expect(flow.options).toEqual({ return: '$last' });
      expect(flow.description.length).toBeGreaterThan(120);
      expect(own.has(flow.entry)).toBeTruthy();
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(places).size).toBe(places.length);
      expect(flow.operations.every(({ name }) => name.length > 0)).toBeTruthy();

      for (const edge of ['resolve', 'reject'] as const) {
        const targets = flow.operations
          .map((operation) => operation[edge])
          .filter((target) => target !== null);

        expect(new Set(targets).size).toBe(targets.length);
        expect(targets.every((target) => own.has(target))).toBeTruthy();
      }
      const coordinate = flow.operations.filter(
        ({ type }) => type === coordinateOperation,
      );

      expect(coordinate.length).toBeGreaterThan(0);
      expect(
        coordinate.every(({ options }) =>
          knownActions.includes(String(options['action'])),
        ),
      ).toBeTruthy();
      expect(insertionOrder(flow.operations)).toHaveLength(
        flow.operations.length,
      );

      const reads = flow.operations.filter(({ type }) => type === 'item-read');

      expect(reads.length).toBeGreaterThan(0);

      for (const { options } of reads) {
        expect(JSON.stringify(options)).not.toMatch(logicalOperators);
        expect(options).toMatchObject({
          emitEvents: false,
          permissions: '$full',
        });
      }
    }
  });
});

describe('legacy page Flow template', () => {
  test('check a legacy page against the plan, read bounded rules and users, count and stage it', () => {
    expect(keyOf(legacyPageFlow, legacyPageFlow.entry)).toBe('read_plan');
    expect(step(legacyPageFlow, 'read_plan').options).toEqual({
      collection: 'data_operations',
      emitEvents: false,
      permissions: '$full',
      query: {
        fields: [
          'claim_token',
          'claim_domain',
          'claim_revision',
          'claim_pages',
          'claim_staged',
        ],
        limit: 1,
        sort: ['id'],
      },
    });
    expect(step(legacyPageFlow, 'check_page').options).toEqual({
      code: legacyPageCheckScript,
    });
    expect(step(legacyPageFlow, 'read_rules').options).toEqual({
      collection: 'course_enrollment_rules',
      emitEvents: false,
      permissions: '$full',
      query: {
        fields: ['id', 'course', 'academic_year', 'pattern'],
        filter: {
          id: {
            _between: [
              '{{ check_page.rules.from }}',
              '{{ check_page.rules.to }}',
            ],
          },
          mode: { _eq: 'legacy_regex' },
        },
        limit: -1,
        sort: ['id'],
      },
    });
    // Only the id and the raw history of each user: no name or address.
    expect(step(legacyPageFlow, 'read_users').options).toEqual({
      collection: 'moodle_users',
      emitEvents: false,
      permissions: '$full',
      query: {
        fields: ['id', 'Courses'],
        filter: {
          id: {
            _between: [
              '{{ check_page.users.from }}',
              '{{ check_page.users.to }}',
            ],
          },
        },
        limit: -1,
        sort: ['id'],
      },
    });
    expect(step(legacyPageFlow, 'count_page').options).toEqual({
      code: countScript,
    });
    expect(step(legacyPageFlow, 'stage_counts')).toMatchObject({
      options: {
        action: 'stage_page',
        page: '{{ check_page.token }}',
        rows: '{{ count_page.rows }}',
        token: '{{ check_page.claim }}',
      },
      type: coordinateOperation,
    });
    expect(step(legacyPageFlow, 'answer').options).toEqual({
      json: {
        page: '{{ check_page.token }}',
        rules: '{{ count_page.rules }}',
        staged: '{{ stage_counts.staged }}',
        users: '{{ count_page.users }}',
      },
    });
    expect(
      [
        'read_plan',
        'check_page',
        'read_rules',
        'read_users',
        'count_page',
        'stage_counts',
      ].map((key) => edges(legacyPageFlow, key)),
    ).toEqual([
      ['check_page', 'plan_fail'],
      ['read_rules', 'page_fail'],
      ['read_users', 'rules_fail'],
      ['count_page', 'users_fail'],
      ['stage_counts', 'count_fail'],
      ['answer', 'stage_fail'],
    ]);

    expectFailBranches(legacyPageFlow, [
      ['read_plan', 'plan', '{{ read_plan.code }}'],
      ['check_page', 'page', 'PAGE_PLAN_MISMATCH'],
      ['read_rules', 'rules', '{{ read_rules.code }}'],
      ['read_users', 'users', '{{ read_users.code }}'],
      ['count_page', 'count', 'LEGACY_COUNT_FAILED'],
      ['stage_counts', 'stage', '{{ stage_counts.code }}'],
    ]);
  });
});

describe('zero page Flow template', () => {
  test('fill the zeros of a legacy rule page from the native sum of its own pages only', () => {
    expect(keyOf(legacyZerosFlow, legacyZerosFlow.entry)).toBe('read_plan');
    expect(step(legacyZerosFlow, 'check_zeros').options).toEqual({
      code: zeroPageCheckScript,
    });
    expect(step(legacyZerosFlow, 'read_rules').options).toMatchObject({
      collection: 'course_enrollment_rules',
      query: {
        fields: ['id', 'course', 'academic_year'],
        filter: {
          id: {
            _between: ['{{ check_zeros.from }}', '{{ check_zeros.to }}'],
          },
          mode: { _eq: 'legacy_regex' },
        },
        limit: -1,
        sort: ['id'],
      },
    });
    // The native aggregate reads the candidates of this claim and of the
    // legacy pages of this rule page only: never another claim's, a mapped
    // page's, another rule page's or this zero page's own rows.
    expect(step(legacyZerosFlow, 'read_sums').options).toEqual({
      collection: 'data_operation_results',
      emitEvents: false,
      permissions: '$full',
      query: {
        aggregate: { sum: ['count'] },
        filter: {
          claim_token: { _eq: '{{ check_zeros.claim }}' },
          page_token: { _in: '{{ check_zeros.cells }}' },
        },
        groupBy: ['course', 'academic_year'],
        limit: -1,
      },
    });
    expect(step(legacyZerosFlow, 'sum_counts').options).toEqual({
      code: sumScript,
    });
    expect(step(legacyZerosFlow, 'stage_zeros').options).toEqual({
      action: 'stage_page',
      page: '{{ check_zeros.token }}',
      rows: '{{ sum_counts.rows }}',
      token: '{{ check_zeros.claim }}',
    });
    expect(
      [
        'read_plan',
        'check_zeros',
        'read_rules',
        'read_sums',
        'sum_counts',
        'stage_zeros',
      ].map((key) => edges(legacyZerosFlow, key)),
    ).toEqual([
      ['check_zeros', 'plan_fail'],
      ['read_rules', 'page_fail'],
      ['read_sums', 'rules_fail'],
      ['sum_counts', 'sums_fail'],
      ['stage_zeros', 'zeros_fail'],
      ['answer', 'stage_fail'],
    ]);

    expectFailBranches(legacyZerosFlow, [
      ['read_plan', 'plan', '{{ read_plan.code }}'],
      ['check_zeros', 'page', 'PAGE_PLAN_MISMATCH'],
      ['read_rules', 'rules', '{{ read_rules.code }}'],
      ['read_sums', 'sums', '{{ read_sums.code }}'],
      ['sum_counts', 'zeros', 'ZERO_FILL_FAILED'],
      ['stage_zeros', 'stage', '{{ stage_zeros.code }}'],
    ]);
  });
});

describe('legacy parent Flow template', () => {
  test('is the declared runner of its family and reads the declared mode and page kinds', () => {
    const [legacy, zeros] = legacyRuleMode.pageKinds;

    expect(legacyParentFlow.id).toBe(legacyRuleMode.runnerFlowId);
    expect(legacyParentFlow.description).toContain(legacyRuleMode.mode);
    expect(legacyParentFlow.description).toContain(
      'Called by "Data / Run enrollment family"',
    );
    expect(legacyPagesScript).toContain(`entry.kind === '${legacy}'`);
    expect(legacyPagesScript).toContain(`entry.kind === '${zeros}'`);
    expect(legacyPageCheckScript).toContain(`planned.kind !== '${legacy}'`);
    expect(zeroPageCheckScript).toContain(`planned.kind !== '${zeros}'`);
  });

  test('run the legacy and zero pages serially and fail the claim visibly on any failure', () => {
    expect(keyOf(legacyParentFlow, legacyParentFlow.entry)).toBe('read_plan');
    expect(step(legacyParentFlow, 'legacy_pages').options).toEqual({
      code: legacyPagesScript,
    });
    expect(step(legacyParentFlow, 'count_pages')).toMatchObject({
      options: {
        flow: legacyEnrollmentFlowIds.page,
        iterationMode: 'serial',
        payload: '{{ legacy_pages.cells }}',
      },
      type: 'trigger',
    });
    expect(step(legacyParentFlow, 'fill_zeros')).toMatchObject({
      options: {
        flow: legacyEnrollmentFlowIds.zeros,
        iterationMode: 'serial',
        payload: '{{ legacy_pages.zeros }}',
      },
      type: 'trigger',
    });
    expect(step(legacyParentFlow, 'check_pages').options).toEqual({
      code: legacyPagesCheckScript,
    });
    expect(step(legacyParentFlow, 'check_fills').options).toEqual({
      code: zeroPagesCheckScript,
    });

    const main = [
      'read_plan',
      'legacy_pages',
      'count_pages',
      'check_pages',
      'fill_zeros',
      'check_fills',
    ];

    expect(main.map((key) => edges(legacyParentFlow, key)[0])).toEqual([
      'legacy_pages',
      'count_pages',
      'check_pages',
      'fill_zeros',
      'check_fills',
      'answer',
    ]);

    // Every failure fails the claim (its candidates are discarded, the
    // installed counts stay) and then answers a failure record.
    for (const key of main) {
      const [, failing] = edges(legacyParentFlow, key);
      const failStep = step(legacyParentFlow, failing ?? '');

      expect(failStep).toMatchObject({
        options: {
          action: 'fail',
          code: 'LEGACY_COUNT_FAILED',
          token: '{{ $trigger.claim }}',
        },
        type: coordinateOperation,
      });

      const [record] = edges(legacyParentFlow, failStep.key);

      expect(recordKeys(legacyParentFlow, record ?? '')).toEqual([
        'code',
        'message',
        'ok',
        'stage',
      ]);
      expect(
        step(legacyParentFlow, record ?? '').options['json'],
      ).toMatchObject({ message: `{{ ${key}.message }}`, ok: false });
    }

    expect(step(legacyParentFlow, 'answer').options).toEqual({
      json: {
        counted: '{{ check_fills.counted }}',
        legacyPages: '{{ check_pages.pages }}',
        ok: true,
        pairs: '{{ check_fills.pairs }}',
        staged: '{{ check_pages.staged }}',
        zeroPages: '{{ check_fills.pages }}',
        zeros: '{{ check_fills.zeros }}',
      },
    });
  });
});

describe('coordinator operation form', () => {
  test('offers the enrollments plan source in Studio', () => {
    const source = z
      .array(
        z.looseObject({
          field: z.string(),
          meta: z.looseObject({
            options: z.looseObject({
              choices: z.array(
                z.object({ text: z.string(), value: z.string() }),
              ),
            }),
          }),
        }),
      )
      .parse(
        z
          .array(z.looseObject({ field: z.string() }))
          .parse(operationApp.options)
          .filter(({ field }) => field === 'source'),
      );

    expect(source[0]?.meta.options.choices.map(({ value }) => value)).toEqual([
      'history',
      'rules',
      'enrollments',
    ]);
    expect(source[0]?.meta).toMatchObject({
      note: 'plan_pages: history (history_index claim), rules (enrollments claim, mapped_entries rules only), enrollments (enrollments claim, one family per rule mode).',
    });
  });
});

describe('legacy enrollment Run Script files', () => {
  test('are the files the templates install', () => {
    expect(countHistoryPagePath).toBe(
      join(flowsDirectory, 'count-history-page.cjs'),
    );
    expect(sumCountsPath).toBe(join(flowsDirectory, 'sum-counts.cjs'));
  });
});

describe('legacy enrollment Flow installer', () => {
  test('installs each Flow once, children first, and never touches an existing one', async () => {
    const calls: Array<{ body: unknown; method: string; pathname: string }> =
      [];
    const present = new Set<string>();
    const request: DirectusRequest = async (pathname, init) => {
      const method = init?.method ?? 'GET';
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ body, method, pathname });
      if (method === 'GET') {
        const id = new URL(
          pathname,
          'https://fixture.example',
        ).searchParams.get('filter[id][_eq]');
        return id !== null && present.has(id)
          ? [{ id, operation: `${id}-entry` }]
          : [];
      }
      if (pathname === '/flows') {
        present.add(flowBody.parse(body).id);
      }
      return {};
    };

    await expect(
      installFlowFamily(request, flowFamilyCodes.legacy),
    ).resolves.toMatchObject({
      created: legacyEnrollmentFlows.map(({ name }) => name),
      skipped: [],
    });
    expect(
      calls
        .filter(
          ({ method, pathname }) => method === 'POST' && pathname === '/flows',
        )
        .map(({ body }) => flowBody.parse(body).status),
    ).toEqual(['inactive', 'inactive', 'inactive']);

    calls.length = 0;

    await expect(
      installFlowFamily(request, flowFamilyCodes.legacy),
    ).resolves.toMatchObject({
      created: [],
      skipped: legacyEnrollmentFlows.map(({ name }) => name),
    });
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  });
});
