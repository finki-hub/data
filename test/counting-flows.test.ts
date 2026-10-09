import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import operationApp from '../directus/extensions/directus-extension-data-operations/src/app.js';
import { parseCoordinatorInput } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import {
  pagesCheckScript,
  pagesScript,
} from '../src/flows/count-enrollments-scripts.js';
import { dispatcherFlow } from '../src/flows/count-enrollments.js';
import {
  coordinateOperation,
  flowFamilyCodes,
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import {
  mappingCountQuery,
  mappingsQuery,
  matchFailureCode,
  matchFlow,
  matchingFlows,
  matchScriptPath,
  pageEntriesQuery,
} from '../src/flows/match-history-lines.js';
import { flowFamily } from '../src/flows/registry.js';
import { pagePlanScript, planQuery } from '../src/flows/shared.js';
import { claim, refusalOf, runScript } from './flow-script-helpers.js';

// The Flows of an enrollments run: "Data / Count enrollments" lists the
// planned pages and checks their answers; "Data / Match history lines"
// checks one page against the plan, reads its lines, the number of pattern
// mappings and every mapping, matches them and stages the matches. The
// coordinator operation's form is here too. The dispatcher's graph is in
// automatic-processing.test.ts, the matcher script in
// match-history-lines.test.ts.

const family = /^6a1d9f0e-2b3c-4d5e-8f70-0000000017[0-9a-f]{2}$/u;
const scriptPath = join(
  import.meta.dirname,
  '..',
  'directus',
  'flows',
  'match-history-lines.cjs',
);
const matchScript = await readFile(scriptPath, 'utf8');
const triggerClaim = '{{ $trigger.claim }}';

const stepOf =
  (flow: FlowTemplate) =>
  (key: string): OperationTemplate | undefined =>
    flow.operations.find((operation) => operation.key === key);

const keyIn =
  (flow: FlowTemplate) =>
  (id: null | string | undefined): string | undefined =>
    flow.operations.find((operation) => operation.id === id)?.key;

const matchStep = stepOf(matchFlow);
const matchKeyOf = keyIn(matchFlow);

// The keys along the resolve edges from the entry of a Flow.
const mainRow = (flow: FlowTemplate): string[] => {
  const order = [];
  let key = keyIn(flow)(flow.entry);
  while (key !== undefined) {
    order.push(key);
    key = keyIn(flow)(stepOf(flow)(key)?.resolve);
  }
  return order;
};

// The answer of plan_pages with source entries: two pages of lines.
const plan = {
  discarded: 0,
  pages: [
    { from: 1, rows: 250, to: 260, token: 'p0001' },
    { from: 261, rows: 3, to: 270, token: 'p0002' },
  ],
  source: 'entries',
  total: 2,
};

const pagePayloads = plan.pages.map((page) => ({
  ...page,
  claim,
  revision: 11,
}));

// The check of the dispatcher over the page answers.
const check = (results: unknown) =>
  runScript(pagesCheckScript, { match_pages: results, pages: pagePayloads });

describe('the dispatcher scripts', () => {
  test('hand every planned page, with the claim and revision, to the matching Flow', () => {
    expect(
      runScript(pagesScript, { $trigger: { claim, revision: 11 }, plan }),
    ).toEqual(pagePayloads);
    expect(
      runScript(pagesScript, {
        $trigger: { claim, revision: 11 },
        plan: { ...plan, pages: [], total: 0 },
      }),
    ).toEqual([]);
    expect(
      refusalOf(() => runScript(pagesScript, { $trigger: { claim }, plan })),
    ).toBe('Invalid trigger payload: expected {claim, revision}');
    expect(
      refusalOf(() =>
        runScript(pagesScript, {
          $trigger: { claim, revision: 11 },
          plan: { families: [], total: 0 },
        }),
      ),
    ).toBe('plan_pages: no page list');
    expect(
      refusalOf(() =>
        runScript(pagesScript, {
          $trigger: { claim, revision: 11 },
          plan: { pages: [plan.pages[0], { from: 9 }] },
        }),
      ),
    ).toBe('Plan page 2: token missing');
  });

  test('accept the pages only when each answered its own summary, and relay the first failure', () => {
    const answers = [
      { entries: 250, mappings: 3, ok: true, page: 'p0001', staged: 7 },
      { entries: 3, mappings: 3, ok: true, page: 'p0002', staged: 0 },
    ];

    expect(check(answers)).toEqual({ pages: 2, staged: 7 });
    expect(
      refusalOf(() =>
        check([
          {
            code: matchFailureCode,
            message:
              'Pattern mapping 12: invalid regular expression (Unterminated group)',
            ok: false,
            page: 'p0001',
            stage: 'match',
          },
          answers[1],
        ]),
      ),
    ).toBe(
      'Page p0001 failed [match MATCH_FAILED]: Pattern mapping 12: invalid regular expression (Unterminated group)',
    );

    // A page that answered nothing, another page's summary or no count.
    for (const answer of [
      null,
      { ...answers[1], page: 'p0001' },
      { ...answers[1], staged: -1 },
      { ...answers[1], ok: undefined },
    ]) {
      expect(refusalOf(() => check([answers[0], answer]))).toBe(
        'Page p0002: invalid summary',
      );
    }

    expect(refusalOf(() => check([answers[0]]))).toBe(
      'match_pages: results 1, expected 2',
    );
  });
});

describe('the matching Flow', () => {
  test('is the one Flow of family 17, with deterministic ids and activity logging', () => {
    expect(flowFamily(flowFamilyCodes.matching).templates).toEqual([matchFlow]);
    expect(matchingFlows).toEqual([matchFlow]);
    expect(matchFlow).toMatchObject({
      accountability: 'activity',
      id: '6a1d9f0e-2b3c-4d5e-8f70-000000001701',
      name: 'Data / Match history lines',
      options: { return: '$last' },
      trigger: 'operation',
    });

    for (const id of [
      matchFlow.id,
      matchFlow.entry,
      ...matchFlow.operations.map((operation) => operation.id),
    ]) {
      expect(id).toMatch(family);
    }

    expect(matchScriptPath).toBe(scriptPath);
    expect(matchStep('match_lines')?.options).toEqual({ code: matchScript });
    expect(
      dispatcherFlow.operations.map(({ options }) => options['flow']),
    ).toContain(matchFlow.id);
  });

  test('checks the page against the plan, reads its lines and every mapping, matches and stages them at once', () => {
    expect(mainRow(matchFlow)).toEqual([
      'read_plan',
      'check_page',
      'read_entries',
      'count_mappings',
      'read_mappings',
      'match_lines',
      'stage_matches',
      'answer',
    ]);

    const reads = {
      count_mappings: ['moodle_pattern_mappings', mappingCountQuery],
      read_entries: ['moodle_course_entries', pageEntriesQuery],
      read_mappings: ['moodle_pattern_mappings', mappingsQuery],
      read_plan: ['data_operations', planQuery],
    } as const;

    for (const [key, [collection, query]] of Object.entries(reads)) {
      expect(matchStep(key)).toMatchObject({
        options: { collection, emitEvents: false, permissions: '$full', query },
        type: 'item-read',
      });
    }

    expect(pageEntriesQuery).toEqual({
      fields: ['id', 'label'],
      filter: {
        id: { _between: ['{{ check_page.from }}', '{{ check_page.to }}'] },
      },
      limit: -1,
      sort: ['id'],
    });
    expect(mappingsQuery).toEqual({
      fields: ['id', 'pattern', 'year_pattern', 'only_in_year'],
      limit: -1,
      sort: ['id'],
    });
    // One aggregate row, whatever QUERY_LIMIT_MAX is: the matcher compares
    // the mappings read with it.
    expect(mappingCountQuery).toEqual({ aggregate: { count: ['id'] } });
    expect(matchStep('check_page')?.options).toEqual({ code: pagePlanScript });
    expect(matchStep('stage_matches')).toMatchObject({
      options: {
        action: 'stage_page',
        page: '{{ check_page.token }}',
        rows: '{{ match_lines.rows }}',
        token: '{{ check_page.claim }}',
      },
      type: coordinateOperation,
    });
    expect(matchStep('answer')?.options).toEqual({
      json: {
        entries: '{{ match_lines.entries }}',
        mappings: '{{ match_lines.mappings }}',
        ok: true,
        page: '{{ stage_matches.page }}',
        staged: '{{ stage_matches.staged }}',
      },
    });

    // One stage per page and no plan or completion: the dispatcher owns
    // the claim's plan and its end.
    expect(
      matchFlow.operations
        .map(({ options }) => options['action'])
        .filter((action) => action !== undefined && action !== 'fail'),
    ).toEqual(['stage_page']);
  });

  test('fails the claim from every step that can reject, and answers the step code, its message and the page', () => {
    const rejecting = matchFlow.operations.filter(
      ({ reject }) => reject !== null,
    );

    expect(rejecting.map(({ key }) => key)).toEqual([
      'read_plan',
      'check_page',
      'read_entries',
      'count_mappings',
      'read_mappings',
      'match_lines',
      'stage_matches',
    ]);

    const recordCodes = rejecting.map((source) => {
      const failure = matchStep(matchKeyOf(source.reject) ?? '');
      const record = matchStep(matchKeyOf(failure?.resolve) ?? '');

      expect(failure?.options).toEqual({
        action: 'fail',
        code: matchFailureCode,
        message: `{{ ${source.key}.message }}`,
        token: triggerClaim,
      });
      expect(record?.options).toMatchObject({
        json: {
          message: `{{ ${source.key}.message }}`,
          ok: false,
          page: '{{ $trigger.token }}',
        },
      });

      return record?.options['json'];
    });

    expect(
      recordCodes.map((json) =>
        json !== null && typeof json === 'object' && 'code' in json
          ? json.code
          : null,
      ),
    ).toEqual([
      '{{ read_plan.code }}',
      'PAGE_PLAN_MISMATCH',
      '{{ read_entries.code }}',
      '{{ count_mappings.code }}',
      '{{ read_mappings.code }}',
      matchFailureCode,
      '{{ stage_matches.code }}',
    ]);
  });
});

describe('the page plan check', () => {
  const page = {
    claim,
    from: 10,
    revision: 7,
    rows: 3,
    to: 14,
    token: 'p0002',
  };
  const firstPage = { ...page, from: 1, rows: 4, to: 9, token: 'p0001' };
  // The status row as read_plan answers it: an entries plan of two pages
  // under the current enrollments claim.
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

  test.each([
    {
      name: 'a consistent sub-range',
      reason: 'Page p0002: range 10-10 (1 row), planned 10-14 (3 rows)',
      trigger: { ...page, rows: 1, to: 10 },
    },
    {
      name: 'the range of another page under this token',
      reason: 'Page p0002: range 1-9 (4 rows), planned 10-14 (3 rows)',
      trigger: { ...firstPage, token: 'p0002' },
    },
    {
      name: 'a row count off by one',
      reason: 'Page p0002: range 10-14 (2 rows), planned 10-14 (3 rows)',
      trigger: { ...page, rows: 2 },
    },
    {
      name: 'a page the claim never planned',
      reason: 'Page p0003: not planned under this claim',
      trigger: { ...page, token: 'p0003' },
    },
    {
      name: 'another claim',
      reason: 'Page p0002: claim is not the current claim',
      trigger: { ...page, claim: 'another claim' },
    },
    {
      name: 'another revision',
      reason: 'Page p0002: revision 6, expected 7',
      trigger: { ...page, revision: 6 },
    },
    {
      name: 'a history index claim',
      readPlan: [{ ...status, claim_domain: 'history_index' }],
      reason: 'Page p0002: claim domain history_index, expected enrollments',
    },
    {
      name: 'a publication claim',
      readPlan: [{ ...status, claim_domain: 'publication' }],
      reason: 'Page p0002: claim domain publication, expected enrollments',
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
      reason: 'Page p0002: claim is not the current claim',
    },
    {
      name: 'a claim without a plan',
      readPlan: [{ ...status, claim_pages: null }],
      reason: 'Page p0002: not planned under this claim',
    },
    {
      name: 'a plan stored without ranges',
      readPlan: [{ ...status, claim_pages: ['p0001', 'p0002'] }],
      reason: 'Page p0002: not planned under this claim',
    },
  ])('refuses $name before a line is read', ({ readPlan, reason, trigger }) => {
    const message = refusalOf(() =>
      checked(trigger ?? page, readPlan ?? [status]),
    );

    expect(message).toBe(reason);
    expect(message).not.toContain(claim);
  });

  test.each([[[]], [[status, status]], [null], [[null]]])(
    'refuses a status read of %j',
    (readPlan) => {
      expect(refusalOf(() => checked(page, readPlan))).toBe(
        'read_plan: expected 1 status row',
      );
    },
  );

  test.each([
    ['a page without its claim', { ...page, claim: '' }],
    ['a token that is not a page token', { ...page, token: 'page 2' }],
  ])('refuses %s as a malformed payload', (_name, trigger) => {
    expect(refusalOf(() => checked(trigger))).toBe(
      'Invalid trigger payload: expected {claim, token, from, to, rows, revision}',
    );
  });

  test.each([
    ['a reversed range', { ...page, from: 14, to: 10 }],
    ['a page without its revision', { ...page, revision: undefined }],
  ])('refuses %s', (_name, trigger) => {
    expect(refusalOf(() => checked(trigger))).toBe(
      'Invalid trigger payload: page p0002: from, to, rows, revision must be integers',
    );
  });
});

// The stage_page example of the rows note.
const stageExample = /^stage_page: (?<rows>\[.*?\]) \(/u;

// A field of the coordinator operation's Studio form, with its note.
const formField = (name: string) =>
  z
    .looseObject({
      field: z.literal(name),
      meta: z.looseObject({
        note: z.string(),
        options: z.looseObject({
          choices: z
            .array(z.object({ text: z.string(), value: z.string() }))
            .optional(),
        }),
      }),
    })
    .parse(
      z
        .array(z.looseObject({ field: z.string() }))
        .parse(operationApp.options)
        .find(({ field }) => field === name),
    );

describe('the coordinator operation form', () => {
  test('offers the history and entries plan sources, each with its claim domain', () => {
    const source = formField('source');

    expect(source.meta.options.choices?.map(({ value }) => value)).toEqual([
      'history',
      'entries',
    ]);
    expect(source.meta.note).toBe(
      'plan_pages: history (history_index claim), entries (enrollments claim).',
    );
  });

  test('shows the match rows stage_page takes, as an example it accepts', () => {
    const { note } = formField('rows').meta;
    const example = stageExample.exec(note)?.groups;

    expect(note).toBe(
      'stage_page: [{ "entry": 7, "pattern_mapping": 3, "year_label": "2025/2026" }] (at most 10000 matches); index_page: [{ "id": 7, "entries": ["exact history line", "..."] }] for this page only (at most 250 users).',
    );
    expect(
      parseCoordinatorInput({
        action: 'stage_page',
        page: 'p0001',
        rows: example?.['rows'],
        token: claim,
      }),
    ).toMatchObject({
      rows: [{ entry: 7, pattern_mapping: 3, year_label: '2025/2026' }],
    });
  });
});
