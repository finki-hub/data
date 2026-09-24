import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { runAction } from '../directus/extensions/directus-extension-data-operations/src/coordination/actions.js';
import { decideClaim } from '../directus/extensions/directus-extension-data-operations/src/coordination/decisions.js';
import {
  calculationDomains,
  coordinatorActionNames,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  graphKindsOf,
  neutralActions,
  pageStepActions,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/fingerprint.js';
import { parseCoordinatorInput } from '../directus/extensions/directus-extension-data-operations/src/coordination/options.js';
import {
  stateRow,
  toState,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-state.js';
import { graphSql } from '../directus/extensions/directus-extension-data-operations/src/coordination/sql-statements.js';
import {
  mappedCheckScript,
  mappedPagesScript,
} from '../src/flows/count-enrollments-scripts.js';
import { dispatcherFlow } from '../src/flows/count-enrollments.js';
import { legacyEnrollmentFlows } from '../src/flows/count-legacy-enrollments.js';
import { mappedEnrollmentFlows } from '../src/flows/count-mapped-enrollments.js';
import {
  coordinateOperation,
  type FlowTemplate,
  type OperationTemplate,
} from '../src/flows/flow-template.js';
import { historyIndexFlows } from '../src/flows/index-histories.js';
import { markPendingFlow } from '../src/flows/mark-pending.js';
import { publicationFlows } from '../src/flows/prepare-public-assets.js';
import {
  automaticProcessingFlows,
  processPendingCron,
  processPendingFlow,
} from '../src/flows/process-pending.js';
import { publishFileFlow } from '../src/flows/publish-one-file.js';
import { publishFlows } from '../src/flows/publish-public-assets.js';
import { snapshotImportFlows } from '../src/flows/snapshot-import.js';
import {
  claimNext,
  context,
  fail,
  finish,
  graphFingerprints,
  graphFlowIds,
  recordingDatabase,
  settled,
  stateRowOf,
  status,
  tablesOf,
  templateFingerprints,
  tick,
} from './automatic-processing-helpers.js';
import { bothGraphs } from './data-coordination-helpers.js';
import { refusalOf, runScript } from './legacy-enrollment-helpers.js';

const boundedCode = /^[A-Z][A-Z_]{0,63}$/u;
const collator = new Intl.Collator('en');
const triggerClaim = '{{ $trigger.claim }}';
const history = 'history_index';
const enrollments = 'enrollments';
const publication = 'publication';
const next = 'next_calculation';

const stateOf = (overrides: Parameters<typeof stateRowOf>[0] = {}) =>
  toState(stateRow.parse(stateRowOf(overrides)));

describe('the scheduled claim', () => {
  test('picks the first pending calculation domain in dependency order and never publication', () => {
    const request = {
      currentFingerprints: graphFingerprints,
      domain: next,
      retry: false,
    } as const;

    expect(decideClaim(stateOf(), request)).toEqual({
      kind: 'nothing_pending',
    });
    expect(
      decideClaim(stateOf({ dirty_domains: [history, enrollments] }), request),
    ).toMatchObject({ domain: history, kind: 'claim' });
    expect(
      decideClaim(
        stateOf({ dirty_domains: [enrollments, publication] }),
        request,
      ),
    ).toMatchObject({ domain: enrollments, kind: 'claim' });
    // A graph change alone queues both calculations, history first.
    expect(
      decideClaim(stateOf({ calculation_fingerprint: 'graph-old' }), request),
    ).toEqual({
      dirtyDomains: [history, enrollments, publication],
      domain: history,
      kind: 'claim',
    });
    expect(
      decideClaim(
        stateOf({
          claim_heartbeat_age_ms: 10,
          claim_owner: 'process-b',
          claim_token: 'held',
          dirty_domains: [history],
        }),
        request,
      ).kind,
    ).toBe('busy');
  });

  test('runs one domain per tick: the history index, then the enrollment counts', async () => {
    const fake = settled('moodle_users');

    const first = await claimNext(fake);

    expect(first.domain).toBe(history);
    await expect(tick(fake)).resolves.toMatchObject({
      claimed: false,
      reason: 'busy',
    });

    await finish(fake, first.token);

    const second = await claimNext(fake);

    expect(second.domain).toBe(enrollments);

    await finish(fake, second.token);

    await expect(tick(fake)).resolves.toEqual({
      claimed: false,
      reason: 'nothing_pending',
    });
    expect(fake.data.dirtyDomains).toEqual([publication]);
  });

  test('reads the status row and the Flow graph only on an idle tick, whatever the answer', async () => {
    const idle = [
      stateRowOf(),
      stateRowOf({
        claim_domain: enrollments,
        claim_fingerprint: graphFingerprints.calculation,
        claim_heartbeat_age_ms: 1_000,
        claim_owner: 'process-b',
        claim_revision: 7,
        claim_token: 'held',
        dirty_domains: [enrollments, publication],
      }),
      stateRowOf({
        dirty_domains: [enrollments, publication],
        last_error_code: 'LEGACY_COUNT_FAILED',
        last_failed_domain: enrollments,
        last_failed_fingerprint: graphFingerprints.calculation,
        last_failed_revision: 7,
      }),
    ];
    const answers = [];
    const read = new Set<string>();
    for (const row of idle) {
      const database = recordingDatabase(row);
      answers.push(
        await runAction(
          { action: 'claim', domain: next, retry: false },
          database.context(),
        ),
      );
      for (const statement of database.statements) {
        for (const table of tablesOf(statement)) {
          read.add(table);
        }
      }
    }

    expect(answers).toEqual([
      { claimed: false, reason: 'nothing_pending' },
      expect.objectContaining({ claimed: false, reason: 'busy' }),
      expect.objectContaining({
        claimed: false,
        domain: enrollments,
        error: 'LEGACY_COUNT_FAILED',
        reason: 'failed',
      }),
    ]);
    // The recursive graph query names its own CTEs "roots" and "managed".
    expect(
      [...read].toSorted((left, right) => collator.compare(left, right)),
    ).toEqual([
      'data_operations',
      'directus_flows',
      'directus_operations',
      'managed',
      'roots',
    ]);
  });
});

describe('failures and changes during a run', () => {
  test('keeps a failed domain failed on every tick until an edit, Mark pending, a graph change or a retry', async () => {
    const fake = settled('course_enrollment_rules');
    const run = await claimNext(fake);

    await expect(
      fail(
        fake,
        run.token,
        'Rule 12 (course 3 / academic year 5) has a pattern that does not compile',
      ),
    ).resolves.toMatchObject({ domain: enrollments, failed: true });

    for (let index = 0; index < 4; index += 1) {
      await expect(tick(fake)).resolves.toMatchObject({
        claimed: false,
        domain: enrollments,
        error: 'LEGACY_COUNT_FAILED',
        reason: 'failed',
      });
    }

    expect(fake.data.claim).toBeNull();

    // A source edit is a newer revision: the next tick runs again.
    fake.sourceWrite('moodle_course_mappings');
    const edited = await claimNext(fake);

    expect(edited.domain).toBe(enrollments);

    await fail(fake, edited.token, 'again');

    // Mark pending moves the revision the same way.
    await runAction({ action: 'mark', domains: [enrollments] }, context(fake));
    const marked = await claimNext(fake);

    expect(marked.domain).toBe(enrollments);

    await fail(fake, marked.token, 'again');

    // A graph change queues the calculations again, history first.
    fake.graphs = bothGraphs('graph-b');
    const regraphed = await claimNext(fake);

    expect(regraphed.domain).toBe(history);

    await finish(fake, regraphed.token);
    const recount = await claimNext(fake);

    expect(recount.domain).toBe(enrollments);

    await fail(fake, recount.token, 'again');

    await expect(
      runAction({ action: 'claim', domain: next, retry: true }, context(fake)),
    ).resolves.toMatchObject({ claimed: true, domain: enrollments });
  });

  test('leaves a source edit made during a run dirty for the next tick, and a graph change too', async () => {
    const fake = settled('moodle_course_mappings');
    const run = await claimNext(fake);
    fake.sourceWrite('moodle_course_mappings');

    await expect(finish(fake, run.token)).rejects.toMatchObject({
      code: 'COORDINATION_SOURCE_CHANGED',
    });
    expect(fake.data.dirtyDomains).toEqual([enrollments, publication]);
    expect(fake.data.lastError?.code).toBe('SOURCE_CHANGED');
    expect(fake.data.lastError?.message).toContain('source change committed');

    const rerun = await claimNext(fake);

    expect(rerun.domain).toBe(enrollments);

    fake.graphs = bothGraphs('graph-b');

    await expect(finish(fake, rerun.token)).rejects.toMatchObject({
      code: 'COORDINATION_FINGERPRINT_CHANGED',
    });
    await expect(claimNext(fake)).resolves.toMatchObject({ domain: history });
  });
});

describe('status', () => {
  test('reports every domain as running, failed, pending or current, and whether the last error still holds', async () => {
    const fake = settled('moodle_users');
    let report = await status(fake);

    expect(report.domains['history_index']).toMatchObject({
      current: false,
      state: 'pending',
      waitingFor: [],
    });
    expect(report.domains['enrollments']).toMatchObject({
      current: false,
      state: 'pending',
      waitingFor: [history],
    });
    expect(report.domains['publication']).toMatchObject({
      current: false,
      state: 'pending',
      waitingFor: [history, enrollments],
    });

    const run = await claimNext(fake);
    report = await status(fake);

    expect(report.domains['history_index']).toMatchObject({
      current: false,
      running: true,
      state: 'running',
    });

    // Through the option contract, as the operation receives it: a
    // message of any length is cut, never refused.
    await runAction(
      parseCoordinatorInput({
        action: 'fail',
        code: 'index_failed',
        message: 'x'.repeat(2_000),
        token: run.token,
      }),
      context(fake),
    );
    report = await status(fake);

    // A failed history run leaves the index stale, and blocking.
    expect(report.domains['history_index']).toMatchObject({
      current: false,
      failed: true,
      state: 'failed',
    });
    expect(report.lastError).toMatchObject({
      blocking: true,
      code: 'INDEX_FAILED',
      domain: history,
      revision: run.revision,
    });
    expect(report.lastError?.message).toHaveLength(600);

    fake.sourceWrite('moodle_users');
    report = await status(fake);

    expect(report.domains['history_index']?.state).toBe('pending');
    expect(report.lastError?.blocking).toBe(false);

    const retried = await claimNext(fake);
    await finish(fake, retried.token);
    report = await status(fake);

    expect(report.domains['history_index']).toEqual({
      current: true,
      failed: false,
      pending: false,
      running: false,
      state: 'current',
      waitingFor: [],
    });
    // The failure stays recorded after the success, marked as not holding.
    expect(report.lastError).toMatchObject({
      blocking: false,
      code: 'INDEX_FAILED',
    });
  });
});

const allTemplates = [
  ...historyIndexFlows,
  ...snapshotImportFlows,
  ...mappedEnrollmentFlows,
  ...legacyEnrollmentFlows,
  ...automaticProcessingFlows,
];

// Every template setup installs, for the fingerprint partition.
const installedTemplates = [
  ...allTemplates,
  ...publicationFlows,
  ...publishFlows,
];

const byText = (left: string, right: string): number =>
  collator.compare(left, right);

const idsOf = (templates: readonly FlowTemplate[]): string[] =>
  templates.map(({ id }) => id).toSorted(byText);

// The ids of these templates that are part of a graph.
const inGraph = (
  graph: ReadonlySet<string>,
  templates: readonly FlowTemplate[],
): string[] => idsOf(templates).filter((id) => graph.has(id));

const calculationFlows = [
  ...historyIndexFlows,
  ...mappedEnrollmentFlows,
  ...legacyEnrollmentFlows,
  dispatcherFlow,
  processPendingFlow,
];

const ungraphedFlows = [
  markPendingFlow,
  ...snapshotImportFlows,
  ...publicationFlows,
];

// The templates with one Flow replaced by an edited copy.
const replaced = (
  templates: readonly FlowTemplate[],
  flow: FlowTemplate,
): FlowTemplate[] =>
  templates.map((candidate) => (candidate.id === flow.id ? flow : candidate));

// A Flow with more options on the step of a key, as a Studio edit leaves it.
const withOptions = (
  flow: FlowTemplate,
  key: string,
  options: Readonly<Record<string, unknown>>,
): FlowTemplate => ({
  ...flow,
  operations: flow.operations.map((operation) =>
    operation.key === key
      ? { ...operation, options: { ...operation.options, ...options } }
      : operation,
  ),
});

const quoted = (value: string): string => `'${value}'`;

const routeFilter = z.object({
  filter: z.object({
    claim: z.object({ domain: z.object({ _eq: z.string() }) }),
  }),
});

const step = (key: string): OperationTemplate | undefined =>
  processPendingFlow.operations.find((operation) => operation.key === key);

const keyOf = (id: null | string | undefined): string | undefined =>
  processPendingFlow.operations.find((operation) => operation.id === id)?.key;

describe('the scheduled Flow', () => {
  test('is a native 15-second schedule whose first step is the claim and whose idle path ends at once', () => {
    expect(processPendingFlow).toMatchObject({
      accountability: 'activity',
      id: '6a1d9f0e-2b3c-4d5e-8f70-000000001302',
      name: 'Data / Process pending',
      options: { cron: '*/15 * * * * *' },
      trigger: 'schedule',
    });
    expect(processPendingCron.split(' ')).toHaveLength(6);
    expect(keyOf(processPendingFlow.entry)).toBe('claim');
    expect(step('claim')?.options).toEqual({
      action: 'claim',
      domain: 'next_calculation',
    });
    expect(keyOf(step('claim')?.resolve)).toBe('claimed');
    expect(keyOf(step('claimed')?.reject)).toBe('idle');
    expect(step('idle')).toMatchObject({
      reject: null,
      resolve: null,
      type: 'transform',
    });
    expect(keyOf(step('claim')?.reject)).toBe('claim_failed');
    // The scheduler reads no collection itself and never asks for the
    // status, whose history summary aggregates over Moodle users.
    expect(
      processPendingFlow.operations.filter(
        ({ options, type }) =>
          type === 'item-read' || options['action'] === 'status',
      ),
    ).toEqual([]);
  });

  test('routes a claim to exactly one child, and releases the claim itself only when the child could not', () => {
    expect(step('route')?.options).toEqual({
      filter: { claim: { domain: { _eq: 'history_index' } } },
    });
    expect(keyOf(step('route')?.resolve)).toBe('refresh');
    expect(keyOf(step('route')?.reject)).toBe('route_enrollments');
    expect(step('route_enrollments')?.options).toEqual({
      filter: { claim: { domain: { _eq: 'enrollments' } } },
    });
    expect(keyOf(step('route_enrollments')?.resolve)).toBe('count');
    expect(step('refresh')?.options).toEqual({
      flow: historyIndexFlows[2]?.id,
      iterationMode: 'serial',
      payload: { claim: '{{ claim.token }}' },
    });
    expect(step('count')?.options).toEqual({
      flow: automaticProcessingFlows[0]?.id,
      iterationMode: 'serial',
      payload: { claim: '{{ claim.token }}', revision: '{{ claim.revision }}' },
    });

    for (const child of ['refresh', 'count']) {
      const answered = step(keyOf(step(child)?.resolve) ?? '');

      expect(answered?.options).toEqual({
        filter: { [child]: { ok: { _nnull: true } } },
      });
      expect(answered?.resolve).toBeNull();
      expect(step(keyOf(answered?.reject) ?? '')?.options).toMatchObject({
        action: 'fail',
      });
      expect(step(keyOf(step(child)?.reject) ?? '')?.options).toMatchObject({
        action: 'fail',
      });
    }
  });

  test('has one explicit route per declared calculation domain and fails a claim of any other domain', () => {
    const routes = processPendingFlow.operations.filter(
      ({ options }) => routeFilter.safeParse(options).success,
    );

    expect(
      routes.map(
        ({ options }) => routeFilter.parse(options).filter.claim.domain._eq,
      ),
    ).toEqual([...calculationDomains]);

    // The last route's reject is the unknown-domain branch: it fails the
    // claim with its own code, then answers the failure record.
    const unknown = step(keyOf(routes.at(-1)?.reject) ?? '');

    expect(unknown).toMatchObject({
      options: {
        action: 'fail',
        code: 'DOMAIN_UNKNOWN',
        token: '{{ claim.token }}',
      },
      type: coordinateOperation,
    });
    expect(String(unknown?.options['message'])).toContain('{{ claim.domain }}');
    expect(step(keyOf(unknown?.resolve) ?? '')).toMatchObject({
      options: { json: { code: 'DOMAIN_UNKNOWN', ok: false } },
      type: 'transform',
    });
  });
});

describe('the Flow-graph fingerprints', () => {
  test('partition the templates: calculation Flows, publish Flows, and neither', () => {
    const calculation = graphFlowIds(installedTemplates, 'calculation');
    const published = graphFlowIds(installedTemplates, 'publication');

    // History, mapped, legacy, the dispatcher and the schedule.
    expect(inGraph(calculation, calculationFlows)).toEqual(
      idsOf(calculationFlows),
    );
    expect(inGraph(published, calculationFlows)).toEqual([]);
    // The publish parent and the child it reaches.
    expect(inGraph(published, publishFlows)).toEqual(idsOf(publishFlows));
    expect(inGraph(calculation, publishFlows)).toEqual([]);
    // Mark pending (mark and status only), the snapshot import and the
    // readiness and preparation buttons belong to neither.
    expect(inGraph(calculation, ungraphedFlows)).toEqual([]);
    expect(inGraph(published, ungraphedFlows)).toEqual([]);
  });

  test('change as their graph changes: a dialog never, a publish step only publication, a calculation step both', () => {
    const base = templateFingerprints(installedTemplates);
    // Rewording the Mark pending dialog and its confirmation.
    const dialog = templateFingerprints(
      replaced(installedTemplates, {
        ...markPendingFlow,
        options: {
          ...markPendingFlow.options,
          confirmationDescription: 'Synthetic reworded confirmation.',
          fields: [],
        },
      }),
    );
    // A Studio edit of a publish step (the storage location).
    const publishEdit = templateFingerprints(
      replaced(
        installedTemplates,
        withOptions(publishFileFlow, 'upload', { storage: 'local' }),
      ),
    );
    // An option of a calculation step.
    const calculationEdit = templateFingerprints(
      replaced(
        installedTemplates,
        withOptions(dispatcherFlow, 'plan', { extra: true }),
      ),
    );

    expect(dialog).toEqual(base);
    expect(publishEdit.calculation).toBe(base.calculation);
    expect(publishEdit.publication).not.toBe(base.publication);
    expect(calculationEdit.calculation).not.toBe(base.calculation);
    expect(calculationEdit.publication).not.toBe(base.publication);
  });

  test('root a Flow by what its coordinate step does, and a templated claim in both graphs', () => {
    const both = ['calculation', 'publication'];

    expect(graphKindsOf({ action: 'claim', domain: next })).toEqual([
      'calculation',
    ]);
    expect(
      calculationDomains.map((domain) =>
        graphKindsOf({ action: 'claim', domain }),
      ),
    ).toEqual(calculationDomains.map(() => ['calculation']));
    expect(graphKindsOf({ action: 'claim', domain: publication })).toEqual([
      'publication',
    ]);
    expect(pageStepActions.map((action) => graphKindsOf({ action }))).toEqual(
      pageStepActions.map(() => ['calculation']),
    );
    expect(
      neutralActions.map((action) =>
        graphKindsOf({ action, domain: publication }),
      ),
    ).toEqual(neutralActions.map(() => []));
    expect(
      [
        { action: 'claim', domain: '{{ $trigger.domain }}' },
        { action: 'claim' },
        { action: '{{ $trigger.action }}' },
        {},
        null,
      ].map((options) => graphKindsOf(options)),
    ).toEqual([both, both, both, both, both]);
    // Every declared action is placed once.
    expect(
      [...neutralActions, ...pageStepActions, 'claim'].toSorted(byText),
    ).toEqual([...coordinatorActionNames].toSorted(byText));
  });

  test('are read by one query over system tables that applies the same rule', () => {
    expect(graphSql).toContain('WITH RECURSIVE "roots"');
    expect(graphSql).toContain('"managed"("graph", "flow")');
    expect(graphSql).toContain(`o."type" = 'trigger'`);
    expect(graphSql).toContain(`o."options"->>'flow'`);
    expect(graphSql).toContain(
      `WHEN o."options"->>'action' IN ('mark', 'status', 'heartbeat', 'record', 'complete', 'fail') THEN false`,
    );
    expect(graphSql).toContain(
      `WHEN o."options"->>'action' IN (${pageStepActions.map(quoted).join(', ')}) THEN kinds."graph" = 'calculation'`,
    );
    expect(graphSql).toContain(
      `o."options"->>'domain' IN ('history_index', 'enrollments', 'next_calculation')`,
    );
    expect(graphSql).toContain(
      `o."options"->>'domain' IN ('publication') THEN kinds."graph" = 'publication'`,
    );
    // It hashes no name, description, icon, colour, position, status or
    // accountability.
    expect(
      [
        'name',
        'description',
        'icon',
        'color',
        'position_x',
        'position_y',
        'status',
        'accountability',
      ].filter((column) => graphSql.includes(`."${column}"`)),
    ).toEqual([]);
    expect(tablesOf(graphSql).toSorted(byText)).toEqual([
      'directus_flows',
      'directus_operations',
      'directus_operations',
      'directus_operations',
      'managed',
      'managed',
      'roots',
    ]);
  });
});

describe('every template the scheduler reaches', () => {
  test('runs children serially, reads with $full and without events, and fails with bounded codes', () => {
    const operations = allTemplates.flatMap((flow) => flow.operations);

    expect(
      operations
        .filter(({ type }) => type === 'trigger')
        .every(({ options }) => options['iterationMode'] === 'serial'),
    ).toBeTruthy();

    const reads = operations.filter(({ type }) => type.startsWith('item-'));
    const fails = operations.filter(
      ({ options }) => options['action'] === 'fail',
    );

    expect(reads.length).toBeGreaterThan(0);

    for (const { options } of reads) {
      expect(options).toMatchObject({
        emitEvents: false,
        permissions: '$full',
      });
    }

    expect(fails.length).toBeGreaterThan(0);

    for (const { options } of fails) {
      expect(String(options['code'])).toMatch(boundedCode);
      expect(options['message']).toBeTypeOf('string');
    }
    for (const flow of allTemplates) {
      expect(flow.accountability).toBe('activity');
    }
  });
});

const dispatcherStep = (key: string): OperationTemplate | undefined =>
  dispatcherFlow.operations.find((operation) => operation.key === key);

const dispatcherKeyOf = (id: null | string | undefined): string | undefined =>
  dispatcherFlow.operations.find((operation) => operation.id === id)?.key;

const claimToken = 'c0ffee00-0000-4000-8000-000000000001';

// An enrollments plan as plan_pages source enrollments answers it: two
// mapped pages, then one legacy rule page with one history page and its
// zero page.
const plan = {
  pages: [
    { from: 1, kind: 'mapped', rows: 3, to: 4, token: 'p0001' },
    { from: 9, kind: 'mapped', rows: 1, to: 9, token: 'p0002' },
    {
      bytes: 90,
      from: 1,
      kind: 'legacy',
      rows: 2,
      rules: { bytes: 40, from: 5, rows: 2, to: 8 },
      to: 2,
      token: 'p0003',
    },
    { from: 5, kind: 'legacy_zeros', rows: 2, to: 8, token: 'p0004' },
  ],
  total: 4,
};

const mappedPayloads = [
  { claim: claimToken, from: 1, revision: 11, rows: 3, to: 4, token: 'p0001' },
  { claim: claimToken, from: 9, revision: 11, rows: 1, to: 9, token: 'p0002' },
];

describe('the enrollment dispatcher', () => {
  test('plans both families once, counts mapped pages serially, heartbeats, runs the legacy family, then completes once', () => {
    expect(dispatcherFlow).toMatchObject({
      accountability: 'activity',
      id: '6a1d9f0e-2b3c-4d5e-8f70-000000001301',
      name: 'Data / Count enrollments',
      options: { return: '$last' },
      trigger: 'operation',
    });

    const order = [];
    let key = dispatcherKeyOf(dispatcherFlow.entry);
    while (key !== undefined) {
      order.push(key);
      key = dispatcherKeyOf(dispatcherStep(key)?.resolve);
    }

    expect(order).toEqual([
      'plan',
      'mapped_pages',
      'count_mapped',
      'mapped_ok',
      'keep_alive',
      'count_legacy',
      'legacy_ok',
      'complete',
      'answer',
    ]);
    expect(dispatcherStep('plan')?.options).toEqual({
      action: 'plan_pages',
      source: 'enrollments',
      token: triggerClaim,
    });
    expect(dispatcherStep('count_mapped')?.options).toEqual({
      flow: mappedEnrollmentFlows[1]?.id,
      iterationMode: 'serial',
      payload: '{{ mapped_pages }}',
    });
    expect(dispatcherStep('keep_alive')?.options).toEqual({
      action: 'heartbeat',
      token: triggerClaim,
    });
    expect(dispatcherStep('count_legacy')?.options).toEqual({
      flow: legacyEnrollmentFlows[2]?.id,
      iterationMode: 'serial',
      payload: { claim: triggerClaim },
    });
    expect(dispatcherStep('complete')?.options).toEqual({
      action: 'complete',
      token: triggerClaim,
    });

    // One plan and one completion per claim: a second plan would discard
    // the staged candidates of the first.
    const actions = dispatcherFlow.operations
      .map(({ options }) => options['action'])
      .filter((action) => action !== undefined && action !== 'fail');

    expect(actions).toEqual(['plan_pages', 'heartbeat', 'complete']);
  });

  test('fails the claim from every step that can reject, with a bounded code and the step message', () => {
    const rejecting = dispatcherFlow.operations.filter(
      ({ reject }) => reject !== null,
    );

    expect(rejecting.map(({ key }) => key)).toEqual([
      'plan',
      'mapped_pages',
      'count_mapped',
      'mapped_ok',
      'keep_alive',
      'count_legacy',
      'legacy_ok',
      'complete',
    ]);

    for (const source of rejecting) {
      const failure = dispatcherStep(dispatcherKeyOf(source.reject) ?? '');

      expect(failure?.options).toMatchObject({
        action: 'fail',
        token: triggerClaim,
      });
      expect(
        dispatcherStep(dispatcherKeyOf(failure?.resolve) ?? '')?.options,
      ).toMatchObject({ json: { ok: false } });
    }

    expect(dispatcherStep('mapped_fail')?.options).toEqual({
      action: 'fail',
      code: 'MAPPED_COUNT_FAILED',
      message: '{{ mapped_ok.message }}',
      token: triggerClaim,
    });
  });

  test('hands the mapped pages of the plan, with the claim and revision, to the page Flow', () => {
    expect(
      runScript(mappedPagesScript, {
        $trigger: { claim: claimToken, revision: 11 },
        plan,
      }),
    ).toEqual(mappedPayloads);
    expect(
      runScript(mappedPagesScript, {
        $trigger: { claim: claimToken, revision: 11 },
        plan: { pages: [], total: 0 },
      }),
    ).toEqual([]);
    expect(
      refusalOf(() =>
        runScript(mappedPagesScript, { $trigger: { claim: claimToken }, plan }),
      ),
    ).toContain('{claim, revision}');
  });

  test('accepts a mapped page only when it staged every planned pair, zeros included', () => {
    const answers = [
      { page: 'p0001', replaced: 0, staged: 3 },
      { page: 'p0002', replaced: 0, staged: 1 },
    ];

    expect(
      runScript(mappedCheckScript, {
        count_mapped: answers,
        mapped_pages: mappedPayloads,
      }),
    ).toEqual({ pages: 2, staged: 4 });
    // A page that left out its zero rows would install fewer pairs than
    // the rules name; the check refuses it before the completion.
    expect(
      refusalOf(() =>
        runScript(mappedCheckScript, {
          count_mapped: [answers[0], { ...answers[1], staged: 0 }],
          mapped_pages: mappedPayloads,
        }),
      ),
    ).toBe(
      'Mapped page p0002 answered no valid summary; nothing was installed.',
    );
    expect(
      refusalOf(() =>
        runScript(mappedCheckScript, {
          count_mapped: [
            {
              code: 'COORDINATION_SOURCE_CHANGED',
              message: 'A source change committed during the run.',
              ok: false,
              page: 'p0001',
              stage: 'stage',
            },
            answers[1],
          ],
          mapped_pages: mappedPayloads,
        }),
      ),
    ).toBe(
      'Mapped page p0001 failed (stage: COORDINATION_SOURCE_CHANGED A source change committed during the run.); nothing was installed.',
    );
    expect(
      refusalOf(() =>
        runScript(mappedCheckScript, {
          count_mapped: [answers[0]],
          mapped_pages: mappedPayloads,
        }),
      ),
    ).toContain('count_mapped answered 1 results for 2 mapped pages');
  });
});
