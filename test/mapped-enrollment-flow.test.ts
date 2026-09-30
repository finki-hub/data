import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import type { DirectusRequest } from '../src/directus-request.js';

import { coordinatorActions } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import {
  mappedCheckScript,
  mappedPagesScript,
} from '../src/flows/count-enrollments-scripts.js';
import { mappedPageFlow } from '../src/flows/count-mapped-enrollment-page.js';
import { mappedPagesFlow } from '../src/flows/count-mapped-enrollment-pages.js';
import {
  mappedCountQuery,
  mappedEnrollmentFlows,
  mappedPairFlow,
} from '../src/flows/count-mapped-enrollments.js';
import {
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  insertionOrder,
} from '../src/flows/flow-template.js';
import { installFlowFamily } from '../src/flows/registry.js';
import {
  candidateRowsScript,
  mappedEnrollmentFlowIds,
  pagePlanScript,
  planQuery,
  rulePairsScript,
} from '../src/flows/shared.js';

const scriptPath = join(
  import.meta.dirname,
  '..',
  'directus',
  'flows',
  'count-mapped-enrollments.cjs',
);
const countScript = await readFile(scriptPath, 'utf8');
const claim = '8c0f1a52-3b4d-4e6f-9a7b-1c2d3e4f5a6b';
const family = /^6a1d9f0e-2b3c-4d5e-8f70-0000000011[0-9a-f]{2}$/u;
const flowBody = z.object({ id: z.string(), status: z.string() });
const knownActions: readonly string[] = coordinatorActions;
const pairLabel = /course 3 \/ academic year 5/u;
// Errors thrown inside node:vm belong to the sandbox realm, so they are
// matched by message rather than by the host Error class.
const readCountRefusal = /^read_count: /u;
const requestRefusal = /^Invalid trigger payload: /u;
const pageRefusal =
  /^(?:Invalid trigger payload|check_page|read_rules|Page p\d{4}|Rule \d+): /u;
const planRefusal = /^Page p\d{4}: .+$/u;
const legacyRefusal =
  /^Rule 12 \(page p0002\): mode legacy_regex, expected mapped_entries$/u;
const modelessRefusal =
  /^Rule 12 \(page p0002\): mode none, expected mapped_entries$/u;
// The fault each refused page names.
const subRange = /: range 10-10 \(1 row\), planned 10-14 \(3 rows\)$/u;
const otherRange = /: range 1-9 \(4 rows\), planned 10-14 \(3 rows\)$/u;
const otherRows = /: range 10-14 \(2 rows\), planned 10-14 \(3 rows\)$/u;
const unplanned = /: not planned under this claim$/u;
const foreign = /: claim is not the current claim$/u;
const revision = /: revision 6, expected 7$/u;
const historyDomain = /: claim domain history_index, expected enrollments$/u;
const publicationDomain = /: claim domain publication, expected enrollments$/u;
const otherKind = /: kind legacy(?:_zeros)?, expected mapped$/u;
const statusRefusal = /^read_plan: expected 1 status row$/u;
const pairFailure =
  /Pair course 3 \/ academic year 5 failed \[validate INVALID_AGGREGATE\]: read_count: expected 1 aggregate row x+$/u;
const candidateRefusal =
  /^(?:count_pairs: results \w+, expected \d+|Pair course \d+ \/ academic year \d+: (?:invalid count|no count))$/u;
const logicalOperators = /_and|_none|_or|_some/u;
const collator = new Intl.Collator('en');

// Runs a Flow script body the way the Run Script operation does: the body
// assigns module.exports, which receives the whole data chain.
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

// The message of the error a script threw (from the sandbox realm).
const refusalOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return z.object({ message: z.string() }).parse(error).message;
  }
  throw new Error('The script answered instead of refusing');
};

const flowIds = (flow: FlowTemplate): string[] => [
  flow.id,
  ...flow.operations.map(({ id }) => id),
];

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

const pairTrigger = { academic_year: 5, claim, course: 3, revision: 7 };

const count = (readCount: unknown, trigger: unknown = pairTrigger) =>
  runScript(countScript, { $trigger: trigger, read_count: readCount });

describe('mapped count query', () => {
  // Probe on the pinned engine (task-11/00-relation-filter-probe.log): the
  // plain nested path keeps course and year on ONE joined mapping row,
  // while a `_some` whose nested filter holds two conditions is silently
  // dropped (every user matches) and two separate `_some` blocks match the
  // course of one mapping and the year of another.
  test('aggregates distinct Moodle users through one mapping row', () => {
    expect(JSON.stringify(step(mappedPairFlow, 'read_count').options)).toBe(
      '{"collection":"moodle_users","emitEvents":false,"permissions":"$full","query":{"aggregate":{"countDistinct":["id"]},"filter":{"history_memberships":{"entry":{"mappings":{"academic_year":{"_eq":"{{ $trigger.academic_year }}"},"course":{"_eq":"{{ $trigger.course }}"}}}}}}}',
    );
    expect(step(mappedPairFlow, 'read_count').options['query']).toBe(
      mappedCountQuery,
    );
    expect(JSON.stringify(mappedCountQuery)).not.toMatch(logicalOperators);
  });
});

describe('count script', () => {
  test('is the file installed into the Flow', () => {
    expect(step(mappedPairFlow, 'shape_count').options).toEqual({
      code: countScript,
    });
  });

  test('answers exactly course, academic year, count and revision', () => {
    const result = count([{ countDistinct: { id: '2' } }]);

    expect(result).toEqual({
      academic_year: 5,
      count: 2,
      course: 3,
      revision: 7,
    });
    expect(Object.keys(result as object)).toEqual([
      'academic_year',
      'count',
      'course',
      'revision',
    ]);
    expect(count([{ countDistinct: { id: 4 } }])).toMatchObject({ count: 4 });
  });

  test('turns a successful empty match into an explicit zero', () => {
    expect(count([{ countDistinct: { id: '0' } }])).toMatchObject({
      count: 0,
    });
  });

  test.each([
    ['an empty result', []],
    ['no result', null],
    ['an object instead of rows', { countDistinct: { id: '2' } }],
    [
      'two rows',
      [{ countDistinct: { id: '2' } }, { countDistinct: { id: '1' } }],
    ],
    ['a non-numeric count', [{ countDistinct: { id: 'two' } }]],
    ['a negative count', [{ countDistinct: { id: '-1' } }]],
    ['a fraction', [{ countDistinct: { id: '1.5' } }]],
    ['an exponent', [{ countDistinct: { id: '1e3' } }]],
    ['an empty count', [{ countDistinct: { id: '' } }]],
    [
      'a count beyond an integer column',
      [{ countDistinct: { id: '9999999999' } }],
    ],
    ['a plain count', [{ count: { id: '2' } }]],
    [
      'an extra aggregate',
      [{ count: { id: '3' }, countDistinct: { id: '2' } }],
    ],
    ['an extra field', [{ countDistinct: { Name: '1', id: '2' } }]],
    [
      'an extra aggregate after the count',
      [{ countDistinct: { id: '2' }, count: { id: '3' } }],
    ],
    ['an extra field after id', [{ countDistinct: { id: '2', Name: '1' } }]],
    ['a null aggregate', [{ countDistinct: null }]],
  ])('refuses %s instead of writing a count', (_name, readCount) => {
    expect(() => count(readCount)).toThrow(readCountRefusal);
  });

  test.each([
    ['no trigger payload', null],
    ['a missing course', { ...pairTrigger, course: undefined }],
    ['a textual course', { ...pairTrigger, course: '3' }],
    ['a zero course', { ...pairTrigger, course: 0 }],
    ['a negative year', { ...pairTrigger, academic_year: -5 }],
    ['a fractional year', { ...pairTrigger, academic_year: 5.5 }],
    ['a negative revision', { ...pairTrigger, revision: -1 }],
    ['a textual revision', { ...pairTrigger, revision: '7' }],
  ])('refuses %s even when the read answered', (_name, trigger) => {
    expect(() => count([{ countDistinct: { id: '0' } }], trigger)).toThrow(
      requestRefusal,
    );
  });
});

// The second planned page of a rules plan, as the parent passes it on.
const page = {
  claim,
  from: 10,
  revision: 7,
  rows: 3,
  to: 14,
  token: 'p0002',
};

describe('page plan script', () => {
  const firstPage = { ...page, from: 1, rows: 4, to: 9, token: 'p0001' };
  // The status row as read_plan answers it: a rules plan of two pages under
  // the current enrollments claim.
  const status = {
    claim_domain: 'enrollments',
    claim_pages: [
      { from: 1, rows: 4, to: 9, token: 'p0001' },
      { from: 10, rows: 3, to: 14, token: 'p0002' },
    ],
    claim_revision: 7,
    claim_token: claim,
  };
  const checked = (trigger: unknown = page, readPlan: unknown = [status]) =>
    runScript(pagePlanScript, { $trigger: trigger, read_plan: readPlan });

  test('answers the page exactly as the claim planned it', () => {
    expect(checked()).toEqual(page);
    expect(checked(firstPage)).toEqual(firstPage);
  });

  test('answers a mapped page of an enrollments plan', () => {
    const enrollmentsPlan = {
      ...status,
      claim_pages: status.claim_pages.map((entry) => ({
        ...entry,
        kind: 'mapped',
      })),
    };

    expect(checked(page, [enrollmentsPlan])).toEqual(page);
  });

  test.each([
    {
      name: 'a consistent sub-range',
      reason: subRange,
      trigger: { ...page, rows: 1, to: 10 },
    },
    {
      name: 'the range of another page under this token',
      reason: otherRange,
      trigger: { ...firstPage, token: 'p0002' },
    },
    {
      name: 'a row count off by one',
      reason: otherRows,
      trigger: { ...page, rows: 2 },
    },
    {
      name: 'a page the claim never planned',
      reason: unplanned,
      trigger: { ...page, token: 'p0003' },
    },
    {
      name: 'another claim',
      reason: foreign,
      trigger: { ...page, claim: 'another claim' },
    },
    {
      name: 'another revision',
      reason: revision,
      trigger: { ...page, revision: 6 },
    },
    {
      name: 'a history index claim',
      readPlan: [{ ...status, claim_domain: 'history_index' }],
      reason: historyDomain,
    },
    {
      name: 'a publication claim',
      readPlan: [{ ...status, claim_domain: 'publication' }],
      reason: publicationDomain,
    },
    {
      name: 'no current claim',
      readPlan: [
        {
          claim_domain: null,
          claim_pages: null,
          claim_revision: null,
          claim_token: null,
        },
      ],
      reason: foreign,
    },
    {
      name: 'a claim without a plan',
      readPlan: [{ ...status, claim_pages: null }],
      reason: unplanned,
    },
    {
      name: 'a plan stored without ranges',
      readPlan: [{ ...status, claim_pages: ['p0001', 'p0002'] }],
      reason: unplanned,
    },
    {
      name: 'a legacy page of an enrollments plan',
      readPlan: [
        {
          ...status,
          claim_pages: [
            status.claim_pages[0],
            {
              bytes: 10,
              from: 10,
              kind: 'legacy',
              rows: 3,
              rules: { from: 20, rows: 1, to: 20 },
              to: 14,
              token: 'p0002',
            },
          ],
        },
      ],
      reason: otherKind,
    },
    {
      name: 'a zero page of an enrollments plan',
      readPlan: [
        {
          ...status,
          claim_pages: [
            status.claim_pages[0],
            { from: 10, kind: 'legacy_zeros', rows: 3, to: 14, token: 'p0002' },
          ],
        },
      ],
      reason: otherKind,
    },
  ])('refuses $name before a rule is read', ({ readPlan, reason, trigger }) => {
    const message = refusalOf(() =>
      checked(trigger ?? page, readPlan ?? [status]),
    );

    expect(message).toMatch(planRefusal);
    expect(message).toMatch(reason);
  });

  test.each([[[]], [[status, status]], [null], [[null]]])(
    'refuses a status read of %j before a rule is read',
    (readPlan) => {
      expect(() => checked(page, readPlan)).toThrow(statusRefusal);
    },
  );

  test.each([
    ['a page without its claim', { ...page, claim: '' }, [status]],
    ['a page without its revision', { ...page, revision: undefined }, [status]],
    ['a reversed range', { ...page, from: 14, to: 10 }, [status]],
    [
      'a token that is not a page token',
      { ...page, token: 'page 2' },
      [status],
    ],
  ])('refuses %s as a malformed page', (_name, trigger, readPlan) => {
    expect(() => checked(trigger, readPlan)).toThrow(pageRefusal);
  });

  test('never names a claim token in a refusal', () => {
    const message = refusalOf(() =>
      checked({ ...page, claim: 'another claim' }),
    );

    expect(message).toMatch(planRefusal);
    expect(message).not.toContain(claim);
    expect(message).not.toContain('another claim');
  });
});

describe('rule page scripts', () => {
  const rules = [
    { academic_year: 5, course: 3, id: 10, mode: 'mapped_entries' },
    { academic_year: 6, course: 3, id: 12, mode: 'mapped_entries' },
    { academic_year: 6, course: 4, id: 14, mode: 'mapped_entries' },
  ];
  const pairs = (readRules: unknown, planned: unknown = page) =>
    runScript(rulePairsScript, { check_page: planned, read_rules: readRules });

  test('turns the rules of a complete mapped page into pair payloads', () => {
    expect(pairs(rules)).toEqual([
      { academic_year: 5, claim, course: 3, revision: 7 },
      { academic_year: 6, claim, course: 3, revision: 7 },
      { academic_year: 6, claim, course: 4, revision: 7 },
    ]);
    expect(pairs([], { ...page, rows: 0 })).toEqual([]);
  });

  // stage_page replaces the page whole and the completion replaces every
  // installed row, so the mapped rules of a mixed page are never staged
  // alone.
  test.each([
    ['a legacy rule', 'legacy_regex', legacyRefusal],
    ['a rule without a mode', null, modelessRefusal],
  ])(
    'refuses a page with %s instead of staging its mapped rules',
    (_name, mode, refusal) => {
      expect(() => pairs([rules[0], { ...rules[1], mode }, rules[2]])).toThrow(
        refusal,
      );
    },
  );

  test.each([
    ['a truncated read', rules.slice(0, 2), page],
    ['no rule list', null, page],
    [
      'a rule outside the page',
      [...rules.slice(0, 2), { ...rules[2], id: 15 }],
      page,
    ],
    ['a repeated rule', [...rules.slice(0, 2), rules[0]], page],
    [
      'a rule without a course',
      [{ ...rules[0], course: null }, ...rules.slice(1)],
      page,
    ],
    ['no planned page', rules, undefined],
  ])('refuses %s before counting anything', (_name, readRules, planned) => {
    expect(() =>
      runScript(rulePairsScript, {
        check_page: planned,
        read_rules: readRules,
      }),
    ).toThrow(pageRefusal);
  });

  const requested = [
    { academic_year: 5, claim, course: 3, revision: 7 },
    { academic_year: 6, claim, course: 4, revision: 7 },
  ];
  const rows = (results: unknown) =>
    runScript(candidateRowsScript, {
      count_pairs: results,
      pair_payloads: requested,
    });

  test('stages every successful count, zero included', () => {
    expect(
      rows([
        { academic_year: 5, count: 2, course: 3, revision: 7 },
        { academic_year: 6, count: 0, course: 4, revision: 7 },
      ]),
    ).toEqual([
      { academic_year: 5, count: 2, course: 3 },
      { academic_year: 6, count: 0, course: 4 },
    ]);
    expect(
      runScript(candidateRowsScript, { count_pairs: [], pair_payloads: [] }),
    ).toEqual([]);
  });

  test('refuses the whole page when one pair failed, naming only its ids', () => {
    const failure = {
      academic_year: 5,
      code: 'INVALID_AGGREGATE',
      course: 3,
      message: `read_count: expected 1 aggregate row ${'x'.repeat(2_000)}`,
      ok: false,
      stage: 'validate',
    };

    expect(() =>
      rows([failure, { academic_year: 6, count: 0, course: 4, revision: 7 }]),
    ).toThrow(pairLabel);

    let message = '';
    try {
      rows([failure, { academic_year: 6, count: 0, course: 4, revision: 7 }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('INVALID_AGGREGATE');
    expect(message).toContain('validate');
    expect(message).toMatch(pairFailure);
    expect(message.length).toBeLessThan(600);
  });

  test.each([
    ['a missing result', [null, null]],
    [
      'fewer results than pairs',
      [{ academic_year: 5, count: 2, course: 3, revision: 7 }],
    ],
    ['no result list', null],
    [
      'a result for another pair',
      [
        { academic_year: 5, count: 2, course: 9, revision: 7 },
        { academic_year: 6, count: 0, course: 4, revision: 7 },
      ],
    ],
    [
      'a result at another revision',
      [
        { academic_year: 5, count: 2, course: 3, revision: 8 },
        { academic_year: 6, count: 0, course: 4, revision: 7 },
      ],
    ],
    [
      'a negative count',
      [
        { academic_year: 5, count: -2, course: 3, revision: 7 },
        { academic_year: 6, count: 0, course: 4, revision: 7 },
      ],
    ],
    [
      'a textual count',
      [
        { academic_year: 5, count: '2', course: 3, revision: 7 },
        { academic_year: 6, count: 0, course: 4, revision: 7 },
      ],
    ],
  ])('refuses %s instead of staging a zero', (_name, results) => {
    expect(() => rows(results)).toThrow(candidateRefusal);
  });
});

describe('mapped enrollment Flow templates', () => {
  test('use deterministic ids, unique keys, tree edges and activity logging', () => {
    const ids = mappedEnrollmentFlows.flatMap(flowIds);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => family.test(id))).toBeTruthy();
    expect(mappedEnrollmentFlows.map(({ id }) => id)).toEqual([
      mappedEnrollmentFlowIds.pair,
      mappedEnrollmentFlowIds.page,
      mappedEnrollmentFlowIds.pages,
    ]);

    for (const flow of mappedEnrollmentFlows) {
      const own = new Set(flow.operations.map(({ id }) => id));
      const keys = flow.operations.map(({ key }) => key);
      const places = flow.operations.map(
        ({ position_x, position_y }) => `${position_x}/${position_y}`,
      );

      expect(flow.accountability).toBe('activity');
      expect(flow.trigger).toBe('operation');
      expect(flow.options).toEqual({ return: '$last' });
      expect(flow.description.length).toBeGreaterThan(80);
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

      // Every Flow holds a coordinator step (the runner its fail steps);
      // the runner is a declared root of the calculation graph, so the
      // managed graph fingerprint covers every query and script.
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
    }
  });

  test('check the claim, read, validate and answer one pair', () => {
    expect(keyOf(mappedPairFlow, mappedPairFlow.entry)).toBe('check_claim');
    expect(step(mappedPairFlow, 'check_claim')).toMatchObject({
      options: { action: 'heartbeat', token: '{{ $trigger.claim }}' },
      type: coordinateOperation,
    });
    expect(
      ['check_claim', 'read_count', 'shape_count'].map((key) =>
        edges(mappedPairFlow, key),
      ),
    ).toEqual([
      ['read_count', 'claim_failed'],
      ['shape_count', 'read_failed'],
      [null, 'shape_failed'],
    ]);
    expect(step(mappedPairFlow, 'shape_failed').options).toEqual({
      json: {
        academic_year: '{{ $trigger.academic_year }}',
        code: 'INVALID_AGGREGATE',
        course: '{{ $trigger.course }}',
        message: '{{ $last.message }}',
        ok: false,
        stage: 'validate',
      },
    });
    expect(step(mappedPairFlow, 'read_failed').options).toMatchObject({
      json: { code: '{{ $last.code }}', ok: false, stage: 'read' },
    });
    expect(step(mappedPairFlow, 'claim_failed').options).toMatchObject({
      json: { code: '{{ $last.code }}', ok: false, stage: 'claim' },
    });
  });

  test('check the page against the stored plan, read it whole, count its pairs serially and stage them at once', () => {
    expect(keyOf(mappedPageFlow, mappedPageFlow.entry)).toBe('read_plan');
    expect(step(mappedPageFlow, 'read_plan').options).toEqual({
      collection: 'data_operations',
      emitEvents: false,
      permissions: '$full',
      query: {
        fields: [
          'claim_token',
          'claim_domain',
          'claim_revision',
          'claim_pages',
        ],
        limit: 1,
        sort: ['id'],
      },
    });
    expect(step(mappedPageFlow, 'read_plan').options['query']).toBe(planQuery);
    expect(step(mappedPageFlow, 'check_page').options).toEqual({
      code: pagePlanScript,
    });
    // The rules are read from the checked page only, never from the
    // caller's range, and only the mapped ones: an enrollments plan cuts
    // mapped pages from the mapped rules, legacy rules may lie between.
    expect(step(mappedPageFlow, 'read_rules').options).toEqual({
      collection: 'course_enrollment_rules',
      emitEvents: false,
      permissions: '$full',
      query: {
        fields: ['id', 'course', 'academic_year', 'mode'],
        filter: {
          id: {
            _between: ['{{ check_page.from }}', '{{ check_page.to }}'],
          },
          mode: { _eq: 'mapped_entries' },
        },
        limit: -1,
        sort: ['id'],
      },
    });
    expect(step(mappedPageFlow, 'pair_payloads').options).toEqual({
      code: rulePairsScript,
    });
    expect(step(mappedPageFlow, 'count_pairs')).toMatchObject({
      options: {
        flow: mappedEnrollmentFlowIds.pair,
        iterationMode: 'serial',
        payload: '{{ pair_payloads }}',
      },
      type: 'trigger',
    });
    expect(step(mappedPageFlow, 'candidate_rows').options).toEqual({
      code: candidateRowsScript,
    });
    expect(step(mappedPageFlow, 'stage_candidates')).toMatchObject({
      options: {
        action: 'stage_page',
        page: '{{ check_page.token }}',
        rows: '{{ candidate_rows }}',
        token: '{{ check_page.claim }}',
      },
      type: coordinateOperation,
    });
    expect(
      [
        'read_plan',
        'check_page',
        'read_rules',
        'pair_payloads',
        'count_pairs',
        'candidate_rows',
        'stage_candidates',
      ].map((key) => edges(mappedPageFlow, key)),
    ).toEqual([
      ['check_page', 'plan_failed'],
      ['read_rules', 'page_failed'],
      ['pair_payloads', 'rules_failed'],
      ['count_pairs', 'payloads_failed'],
      ['candidate_rows', 'pairs_failed'],
      ['stage_candidates', 'candidates_failed'],
      [null, 'stage_failed'],
    ]);
    expect(step(mappedPageFlow, 'page_failed').options).toMatchObject({
      json: { code: 'PAGE_PLAN_MISMATCH', ok: false, stage: 'page' },
    });
    expect(step(mappedPageFlow, 'payloads_failed').options).toMatchObject({
      json: { code: 'INVALID_RULE_PAGE', ok: false, stage: 'pairs' },
    });

    // The failure records carry the page, the stage, the code and the
    // message only: no claim, rule, pair list, name, address or history.
    for (const key of [
      'plan_failed',
      'page_failed',
      'rules_failed',
      'payloads_failed',
      'pairs_failed',
      'candidates_failed',
      'stage_failed',
    ]) {
      const { options, type } = step(mappedPageFlow, key);

      expect(type).toBe('transform');
      expect(
        Object.keys(
          z.record(z.string(), z.unknown()).parse(options['json']),
        ).toSorted((left, right) => collator.compare(left, right)),
      ).toEqual(['code', 'message', 'ok', 'page', 'stage']);
    }
  });
});

// The runner of the mapped_entries family: the family as the dispatcher's
// "Data / Run enrollment family" hands it over, and its page payloads.
const familyPages = [
  { from: 1, kind: 'mapped', rows: 3, to: 4, token: 'p0001' },
  { from: 9, kind: 'mapped', rows: 1, to: 9, token: 'p0002' },
];
const mappedFamily = {
  claim,
  kind: 'mapped_entries',
  pages: familyPages,
  revision: 7,
  runner: mappedEnrollmentFlowIds.pages,
};
const pagePayloads = [
  { claim, from: 1, revision: 7, rows: 3, to: 4, token: 'p0001' },
  { claim, from: 9, revision: 7, rows: 1, to: 9, token: 'p0002' },
];
const pageAnswers = [
  { page: 'p0001', replaced: 0, staged: 3 },
  { page: 'p0002', replaced: 0, staged: 1 },
];
const checkedAnswers = (answers: unknown) =>
  runScript(mappedCheckScript, {
    count_pages: answers,
    mapped_pages: pagePayloads,
  });

describe('mapped family runner', () => {
  test('hands every mapped page of its family, with the claim and revision, to the page Flow', () => {
    expect(runScript(mappedPagesScript, { $trigger: mappedFamily })).toEqual(
      pagePayloads,
    );
    expect(
      runScript(mappedPagesScript, {
        $trigger: { ...mappedFamily, pages: [] },
      }),
    ).toEqual([]);
    expect(
      refusalOf(() =>
        runScript(mappedPagesScript, {
          $trigger: { ...mappedFamily, revision: null },
        }),
      ),
    ).toContain('{claim, revision, pages}');
    expect(
      refusalOf(() =>
        runScript(mappedPagesScript, {
          $trigger: {
            ...mappedFamily,
            pages: [familyPages[0], { ...familyPages[1], kind: 'legacy' }],
          },
        }),
      ),
    ).toBe('Family page 2: kind legacy, expected mapped');
  });

  test('accepts a mapped page only when it staged every planned pair, zeros included', () => {
    expect(checkedAnswers(pageAnswers)).toEqual({ pages: 2, staged: 4 });
    // A page that left out its zero rows would install fewer pairs than
    // the rules name; the check refuses it before the completion.
    expect(
      refusalOf(() =>
        checkedAnswers([pageAnswers[0], { ...pageAnswers[1], staged: 0 }]),
      ),
    ).toBe('Mapped page p0002: invalid summary');
    expect(
      refusalOf(() =>
        checkedAnswers([
          {
            code: 'COORDINATION_SOURCE_CHANGED',
            message: 'Source changed during run',
            ok: false,
            page: 'p0001',
            stage: 'stage',
          },
          pageAnswers[1],
        ]),
      ),
    ).toBe(
      'Mapped page p0001 failed [stage COORDINATION_SOURCE_CHANGED]: Source changed during run',
    );
    expect(refusalOf(() => checkedAnswers([pageAnswers[0]]))).toBe(
      'count_pages: results 1, expected 2',
    );
  });

  test('runs its pages serially through the page Flow, fails the claim on any failure and answers a summary', () => {
    const flow = mappedPagesFlow;

    expect(flow).toMatchObject({
      id: mappedEnrollmentFlowIds.pages,
      name: 'Data / Count mapped enrollment pages',
      trigger: 'operation',
    });
    expect(keyOf(flow, flow.entry)).toBe('mapped_pages');
    expect(step(flow, 'mapped_pages').options).toEqual({
      code: mappedPagesScript,
    });
    expect(step(flow, 'count_pages')).toMatchObject({
      options: {
        flow: mappedEnrollmentFlowIds.page,
        iterationMode: 'serial',
        payload: '{{ mapped_pages }}',
      },
      type: 'trigger',
    });
    expect(step(flow, 'check_pages').options).toEqual({
      code: mappedCheckScript,
    });
    expect(step(flow, 'answer').options).toEqual({
      json: {
        ok: true,
        pages: '{{ check_pages.pages }}',
        staged: '{{ check_pages.staged }}',
      },
    });

    const main = ['mapped_pages', 'count_pages', 'check_pages'];

    expect(main.map((key) => edges(flow, key)[0])).toEqual([
      'count_pages',
      'check_pages',
      'answer',
    ]);

    for (const key of main) {
      const failing = step(flow, edges(flow, key)[1] ?? '');

      expect(failing).toMatchObject({
        options: {
          action: 'fail',
          code: 'MAPPED_COUNT_FAILED',
          message: `{{ ${key}.message }}`,
          token: '{{ $trigger.claim }}',
        },
        type: coordinateOperation,
      });
      expect(
        step(flow, edges(flow, failing.key)[0] ?? '').options,
      ).toMatchObject({ json: { message: `{{ ${key}.message }}`, ok: false } });
    }
  });
});

describe('mapped enrollment Flow installer', () => {
  test('installs each Flow once and never touches an existing one', async () => {
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
      installFlowFamily(request, flowFamilyCodes.mapped),
    ).resolves.toMatchObject({
      created: mappedEnrollmentFlows.map(({ name }) => name),
      skipped: [],
    });

    const mutations = calls.filter(({ method }) => method !== 'GET');

    expect(
      mutations
        .filter(({ pathname }) => pathname === '/flows')
        .map(({ body }) => flowBody.parse(body).status),
    ).toEqual(['inactive', 'inactive', 'inactive']);
    expect(
      mutations.filter(({ pathname }) => pathname === '/operations'),
    ).toHaveLength(
      mappedEnrollmentFlows.reduce(
        (total, flow) => total + flow.operations.length,
        0,
      ),
    );
    expect(
      mutations
        .filter(({ method }) => method === 'PATCH')
        .map(({ body }) => body),
    ).toEqual(
      mappedEnrollmentFlows.map(({ entry }) => ({
        operation: entry,
        status: 'active',
      })),
    );

    calls.length = 0;

    await expect(
      installFlowFamily(request, flowFamilyCodes.mapped),
    ).resolves.toMatchObject({
      created: [],
      skipped: mappedEnrollmentFlows.map(({ name }) => name),
    });
    expect(calls.filter(({ method }) => method !== 'GET')).toEqual([]);
  });
});
