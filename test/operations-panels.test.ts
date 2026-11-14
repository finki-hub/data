import { describe, expect, test, vi } from 'vitest';
import { computed, type Ref } from 'vue';
import { z } from 'zod';

import type {
  DomainStatus,
  StatusReport,
} from '../directus/extensions/directus-extension-data-operations/src/coordination/status.js';
import type { DirectusRequest } from '../src/directus-request.js';

import extensionManifest from '../directus/extensions/directus-extension-data-operations/package.json' with { type: 'json' };
import { coordinationDomains } from '../directus/extensions/directus-extension-data-operations/src/coordination/domains.js';
import {
  dataStatusPanelId,
  humanize,
  isManagedFlowName,
  managedFlowFilter,
  operationsCollection,
  runOperationPanelId,
  sectionsOf,
  statusEndpointId,
  statusSections,
} from '../directus/extensions/directus-extension-data-operations/src/managed-flows.js';
import {
  answerSummary,
  refusalOf,
} from '../directus/extensions/directus-extension-data-operations/src/panel-answers.js';
import {
  flowKeyOf,
  type ManualFlow,
  missingRequired,
  retryValues,
  runPlan,
  triggerBody,
} from '../directus/extensions/directus-extension-data-operations/src/panel-contract.js';
import { importOptionsSchema } from '../directus/extensions/directus-extension-data-operations/src/snapshot/contract.js';
import {
  domainStates,
  isBusy,
  nextReadMs,
  pollMs,
  retryCapMs,
  statusViewSchema,
} from '../directus/extensions/directus-extension-data-operations/src/status-contract.js';
import {
  lastRunText,
  retriesFacts,
  snapshotText,
} from '../directus/extensions/directus-extension-data-operations/src/status-facts.js';
import {
  ageText,
  collectionText,
  instantText,
  stateLabel,
  toneOf,
  waitingText,
} from '../directus/extensions/directus-extension-data-operations/src/status-labels.js';
import { statusView } from '../directus/extensions/directus-extension-data-operations/src/status-view.js';
import { useStudioName } from '../directus/extensions/directus-extension-data-operations/src/studio-name.js';
import {
  defaultPanels,
  installOperationsDashboard,
  operationsDashboardId,
} from '../src/data-model/operations-dashboard.js';
import { dashboardCode, flowFamilyCodes } from '../src/flows/flow-template.js';
import { snapshotImportFlow } from '../src/flows/snapshot-import.js';
import { flowTemplates } from './registry-test-helpers.js';

// Task 16: the generic Run operation and status panels (audit X14), their
// contract with the manual Flows and the status endpoint, and the default
// Data operations dashboard. The panels themselves render in Studio
// (test/operations.browser.mjs); here their decisions run as plain code.

// The app's collections store as useCollection reads it: the names Studio
// shows, by collection.
const studioNames = vi.hoisted(
  () => new Map([['course_equivalencies', 'Equivalencies']]),
);

vi.mock('@directus/extensions-sdk', () => ({
  useCollection: (key: Ref<null | string>) => ({
    info: computed(() => {
      const name = studioNames.get(key.value ?? '');
      return name === undefined ? null : { name };
    }),
  }),
}));

// A fixture Flow as added in Studio.
const fixtureFlow: ManualFlow = {
  description: 'Synthetic operation.',
  icon: 'bolt',
  id: '9e4d826c-0000-4000-8000-000000001600',
  name: 'Data / Synthetic operation',
  options: {
    async: false,
    collections: ['data_operations'],
    confirmationDescription: 'Run the synthetic operation?',
    error_on_reject: true,
    fields: [
      {
        field: 'note_text',
        meta: { interface: 'input', required: true },
        type: 'string',
      },
      {
        field: 'confirm',
        meta: { interface: 'boolean' },
        name: 'Confirm it',
        type: 'boolean',
      },
    ],
    requireConfirmation: true,
    requireSelection: false,
  },
  status: 'active',
  trigger: 'manual',
};

// The run plan of the fixture Flow on the given collections.
const on = (collections: string[]) =>
  runPlan({
    ...fixtureFlow,
    options: { ...fixtureFlow.options, collections },
  });

const runnable = (flow: ManualFlow) => {
  const plan = runPlan(flow);
  if (!plan.runnable) {
    throw new Error(plan.reason);
  }
  return plan;
};

describe('the Run operation panel contract', () => {
  test('renders a fixture Flow with its own confirmation and fields', () => {
    const plan = runnable(fixtureFlow);

    expect(plan.description).toBe('Run the synthetic operation?');
    expect(plan.confirm).toBeTruthy();
    expect(plan.collection).toBe('data_operations');
    expect(plan.fields.map(({ field, name }) => [field, name])).toEqual([
      ['note_text', 'Note text'],
      ['confirm', 'Confirm it'],
    ]);
    expect(missingRequired(plan.fields, {})).toEqual(['Note text']);
    expect(missingRequired(plan.fields, { note_text: 'x' })).toEqual([]);
  });

  test('posts only the collection and the values of the declared fields', () => {
    const plan = runnable(fixtureFlow);

    expect(
      triggerBody(plan, { confirm: true, extra: 'dropped', note_text: '' }),
    ).toEqual({ collection: 'data_operations', confirm: true });
  });

  test('refuses what a panel cannot run, and says why', () => {
    const withOptions = (options: Record<string, unknown>): ManualFlow => ({
      ...fixtureFlow,
      options: { ...fixtureFlow.options, ...options },
    });
    const reasons = [
      { ...fixtureFlow, trigger: 'webhook' },
      { ...fixtureFlow, name: 'Synthetic / Other family' },
      { ...fixtureFlow, status: 'inactive' },
      withOptions({ collections: [] }),
      { ...fixtureFlow, options: { collections: ['data_operations'] } },
    ].map((flow) => runPlan(flow));

    expect(reasons).toEqual(
      [
        'trigger not manual',
        'name without a "Data / " prefix',
        'Flow inactive',
        'no collection',
        'requires item selection',
      ].map((rule) => ({ reason: `Not runnable: ${rule}`, runnable: false })),
    );
  });

  test('runs a Flow only on data_operations', () => {
    expect(operationsCollection).toBe('data_operations');
    expect(on(['courses'])).toEqual({
      reason: `Not runnable: collections must be exactly ${operationsCollection}`,
      runnable: false,
    });
    expect(on([operationsCollection, 'courses']).runnable).toBe(false);
    expect(on([operationsCollection])).toMatchObject({
      collection: operationsCollection,
      runnable: true,
    });
  });

  test('runs only a Flow that reports its failures: synchronous, with Error on Reject', () => {
    const reason =
      'Not runnable: requires Asynchronous off and Error on Reject on';
    const plans = [
      { async: true },
      { async: true, error_on_reject: true },
      { error_on_reject: false },
      { error_on_reject: null },
    ].map((options) =>
      runPlan({
        ...fixtureFlow,
        options: { ...fixtureFlow.options, ...options },
      }),
    );

    expect(plans).toEqual(plans.map(() => ({ reason, runnable: false })));
    expect(runnable(fixtureFlow).runnable).toBeTruthy();
  });

  test('offers the inputs of a failed run again, less its acknowledgements', () => {
    const plan = runnable(fixtureFlow);

    expect(
      retryValues(plan.fields, {
        confirm: true,
        extra: 'dropped',
        note_text: 'again',
      }),
    ).toEqual({ note_text: 'again' });
    expect(retryValues(plan.fields, { confirm: false })).toEqual({});
  });

  test('can run every installed manual Flow template, all of a managed family', () => {
    const manual = flowTemplates().filter(
      ({ trigger }) => trigger === 'manual',
    );

    expect(manual.length).toBeGreaterThan(0);
    expect(
      manual.filter(
        (template) =>
          !isManagedFlowName(template.name) ||
          !runPlan({ ...template, status: 'active' }).runnable,
      ),
    ).toEqual([]);
    expect(managedFlowFilter._and[0]).toEqual({ trigger: { _eq: 'manual' } });
  });

  test('reads its Flow option as Studio stores it or as a plain id', () => {
    expect(flowKeyOf({ collection: 'directus_flows', key: 'f1' })).toBe('f1');
    expect(flowKeyOf('f2')).toBe('f2');
    expect(flowKeyOf({ collection: 'directus_files', key: 'x' })).toBeNull();
    expect(flowKeyOf(null)).toBeNull();
  });

  test('reads a refusal and a bounded answer, never a whole payload', () => {
    expect(
      refusalOf({
        response: {
          data: {
            errors: [
              { extensions: { code: 'FORBIDDEN' }, message: 'Forbidden' },
            ],
          },
          status: 403,
        },
      }),
    ).toEqual({ code: 'FORBIDDEN', message: 'Forbidden', status: 403 });
    expect(refusalOf(new Error('socket hang up'))).toEqual({
      code: 'NO_ANSWER',
      message: 'No response from Directus',
      status: null,
    });
    expect(refusalOf({ response: { status: 502 } })).toEqual({
      code: 'HTTP_502',
      message: '',
      status: 502,
    });
    expect(
      answerSummary({
        created: 3,
        files: { 'courses.json': {} },
        long: 'x'.repeat(700),
        rows: [1, 2],
      }),
    ).toEqual([
      { label: 'Created', text: '3' },
      { label: 'Files', text: '1 entry' },
      { label: 'Long', text: `${'x'.repeat(600)}…` },
      { label: 'Rows', text: '2 entries' },
    ]);
    expect(answerSummary(null)).toEqual([]);
  });
});

const idle: DomainStatus = {
  current: true,
  failed: false,
  pending: false,
  running: false,
  state: 'current',
  waitingFor: [],
};

const failedDomain: DomainStatus = {
  ...idle,
  current: false,
  failed: true,
  state: 'failed',
};

// The coordinator status of an idle project with failed enrollment counts.
const report: StatusReport = {
  candidates: 0,
  claim: null,
  dirty: ['enrollments'],
  domains: Object.fromEntries(
    coordinationDomains.map((domain) => [
      domain,
      domain === 'enrollments' ? failedDomain : idle,
    ]),
  ),
  fingerprints: {
    calculation: 'c'.repeat(64),
    current: { calculation: 'c'.repeat(64) },
  },
  historyIndex: {
    countMismatches: 0,
    entries: 2,
    indexedUsers: 1,
    memberships: 2,
    users: 1,
  },
  importState: 'completed',
  lastError: {
    at: '2026-09-24T10:00:00.000Z',
    blocking: true,
    code: 'MATCH_FAILED',
    domain: 'enrollments',
    message: 'Pattern mapping 4: invalid regular expression',
    retries: 0,
    revision: 7,
  },
  lastRun: { finishedAt: null, retries: 0, startedAt: null },
  pending: ['enrollments'],
  process: 'synthetic-process-owner',
  revisions: {
    completed: 6,
    inputs: { enrollments: 6, history_index: 6 },
    requested: 7,
    source: 7,
  },
  staleAfterMs: 60_000,
};

// When a panel reads the status again after the given failures.
const read = (failures: number, refused = false, busy = false) =>
  nextReadMs({ busy, failures, refused });

const viewOf = () => statusView({ keySources: [], report, schedule: [] });

describe('the status view', () => {
  test('lists every declared domain with its state', () => {
    const view = statusViewSchema.parse(viewOf());

    expect(view.domains.map(({ name }) => name)).toEqual(coordinationDomains);
    expect(view.domains.map(({ state }) => state)).toEqual([
      'current',
      'failed',
    ]);
    expect(view.lastError?.message).toBe(
      'Pattern mapping 4: invalid regular expression',
    );
    expect(view.lastError?.retries).toBe(0);
  });

  test('carries no token, owner, fingerprint or process', () => {
    const text = JSON.stringify(viewOf());

    for (const word of ['token', 'owner', 'fingerprint', 'process']) {
      expect(text).not.toContain(word);
    }
  });

  test('is busy while a claim is held', () => {
    const view = viewOf();

    expect(isBusy(view)).toBe(false);
    expect(
      isBusy({
        ...view,
        claim: {
          domain: 'x',
          heartbeatAt: null,
          label: 'X',
          stale: false,
          startedAt: null,
        },
      }),
    ).toBeTruthy();
  });

  test('reads a failed status again with a growing pause, but not a refusal', () => {
    expect([1, 2, 3].map((failures) => read(failures))).toEqual([
      pollMs,
      pollMs * 2,
      pollMs * 4,
    ]);
    expect(read(20)).toBe(retryCapMs);
    expect(read(1, true)).toBeNull();
    expect(read(1, true, true)).toBe(pollMs);
    expect(read(0)).toBeNull();
    expect(read(0, false, true)).toBe(pollMs);
  });

  test('polls for pending calculations and running work', () => {
    const view = viewOf();
    const withStates = (states: Readonly<Record<string, string>>) => ({
      ...view,
      claim: null,
      domains: view.domains.map((domain) => ({
        ...domain,
        state: z.enum(domainStates).parse(states[domain.name] ?? 'current'),
      })),
    });

    expect(isBusy(withStates({ enrollments: 'failed' }))).toBe(false);
    expect(isBusy(withStates({ history_index: 'pending' }))).toBeTruthy();
    expect(isBusy(withStates({ enrollments: 'running' }))).toBeTruthy();
  });
});

describe('the dashboard collection names', () => {
  test('name a collection as Studio does, else by its humanized key', () => {
    expect(collectionText('curriculum_generations', 'Generations')).toBe(
      'Generations',
    );
    expect(collectionText('curriculum_generations')).toBe(
      'Curriculum generations',
    );
  });

  test("read the Studio name from the app's collections store, none for a collection it does not list", () => {
    const listed = useStudioName(() => 'course_equivalencies');
    const unlisted = useStudioName(() => 'curriculum_generations');

    expect(listed.value).toBe('Equivalencies');
    expect(unlisted.value).toBeUndefined();
    expect(collectionText('curriculum_generations', unlisted.value)).toBe(
      'Curriculum generations',
    );
  });
});

describe('the status labels', () => {
  test('names a current domain idle and colours each state', () => {
    expect(stateLabel('current')).toBe('Idle');
    expect(stateLabel(null)).toBe('Never');
    expect(
      ['current', 'pending', 'running', 'failed', 'x'].map(toneOf),
    ).toEqual(['success', 'warning', 'info', 'danger', 'neutral']);
    expect(instantText('2026-09-24T16:20:01.123Z')).toBe(
      '2026-09-24 16:20:01 UTC',
    );
    expect([0, 1, 2].map(retriesFacts)).toEqual([
      [],
      [['Retries', 1]],
      [['Retries', 2]],
    ]);
    expect(
      lastRunText({
        finishedAt: '2026-09-24T16:21:07.000Z',
        retries: 1,
        startedAt: '2026-09-24T16:20:01.000Z',
      }),
    ).toBe(
      'Last run: 2026-09-24 16:20:01 UTC – 2026-09-24 16:21:07 UTC · Retries: 1',
    );
    expect(lastRunText({ finishedAt: null, retries: 0, startedAt: null })).toBe(
      'Last run: --',
    );
    expect([12, 300, 9_000, null].map(ageText)).toEqual([
      '12 s',
      '5 min',
      '2 h',
      '--',
    ]);
    expect(
      ['academic_years', 'previousRows', 'membershipsRemoved'].map(humanize),
    ).toEqual(['Academic years', 'Previous rows', 'Memberships removed']);
    expect(sectionsOf(['keys', 'bogus'])).toEqual(['keys']);
    expect(sectionsOf(null)).toEqual([...statusSections]);
  });

  test('writes each Moodle snapshot count as a labelled fact', () => {
    const none = {
      countMismatches: 0,
      entries: 0,
      indexedUsers: 0,
      memberships: 0,
      users: 0,
    };

    expect(
      snapshotText({
        ...none,
        countMismatches: 1,
        entries: 1,
        indexedUsers: 1,
        users: 1,
      }),
    ).toBe(
      'Users: 1 · Indexed: 1 · History lines: 1 · Course count mismatches: 1',
    );
    expect(
      snapshotText({ ...none, entries: 12, indexedUsers: 2, users: 3 }),
    ).toBe(
      'Users: 3 · Indexed: 2 · History lines: 12 · Course count mismatches: 0',
    );
  });

  test('says what Run waits for: the claim, or a run another panel of the page started', () => {
    const claim = {
      domain: 'history_index',
      heartbeatAt: null,
      label: 'Moodle history index',
      stale: false,
      startedAt: null,
    };

    expect(waitingText(null, false)).toBeNull();
    expect(waitingText(null, true)).toBe('run in progress on this page');
    expect(waitingText(claim, false)).toBe(
      'claim held by Moodle history index',
    );
    expect(waitingText({ ...claim, stale: true }, true)).toBe(
      'claim held by Moodle history index (stale)',
    );
  });
});

// The grid columns a row of panels covers, in order, a column once per
// panel covering it.
const gridColumns = (row: ReadonlyArray<{ width: number; x: number }>) =>
  row
    .flatMap(({ width, x }) =>
      Array.from({ length: width }, (_, index) => x + index),
    )
    .toSorted((left, right) => left - right);

describe('the Data operations dashboard', () => {
  test('declares the default panels once, each for an installed manual Flow or the status', () => {
    const templates = new Map(flowTemplates().map((flow) => [flow.id, flow]));
    const flows = defaultPanels.flatMap(({ options }) => {
      const key = flowKeyOf(options['flow']);
      return key === null ? [] : [templates.get(key)?.name];
    });

    expect(flows).toEqual([
      'Data / Mark pending',
      'Data / Import Moodle snapshot',
    ]);
    expect(new Set(defaultPanels.map(({ id }) => id)).size).toBe(
      defaultPanels.length,
    );
    // The installed ids stay: the code of the retired enrollment-rules
    // family, which no Flow family carries, and the panels' suffixes.
    expect(Object.values(flowFamilyCodes)).not.toContain(dashboardCode);
    expect(operationsDashboardId).toBe('6a1d9f0e-2b3c-4d5e-8f70-0000000016d0');
    expect(defaultPanels.map(({ id }) => id.slice(-4))).toEqual([
      '16d2',
      '16d3',
      '16d5',
      '16d7',
    ]);
    expect(
      defaultPanels.every(({ id }) =>
        id.startsWith(operationsDashboardId.slice(0, -2)),
      ),
    ).toBeTruthy();
    expect(new Set(defaultPanels.map(({ type }) => type))).toEqual(
      new Set([dataStatusPanelId, runOperationPanelId]),
    );
    expect(
      defaultPanels.flatMap(({ options }) =>
        options['sections'] === undefined
          ? []
          : sectionsOf(options['sections']),
      ),
    ).toEqual([...statusSections]);
  });

  test('fills each panel row from column 1 to 52, without a gap or an overlap', () => {
    const full = gridColumns([{ width: 52, x: 1 }]);

    expect(
      Map.groupBy(defaultPanels, ({ y }) => y)
        .values()
        .map((row) => gridColumns(row))
        .toArray(),
    ).toEqual([full, full, full]);
  });

  test('creates what is missing and never touches what exists', async () => {
    const present = new Set<string>([defaultPanels[0]?.id ?? '']);
    const calls: Array<{ body: unknown; method: string; path: string }> = [];
    let dashboard = false;
    const request: DirectusRequest = async (path, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (path.startsWith('/dashboards')) {
          return dashboard ? [{ id: operationsDashboardId }] : [];
        }
        return [...present].map((id) => ({ id }));
      }
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ body, method, path });
      if (path === '/dashboards') {
        dashboard = true;
        return {};
      }
      const created = z.array(z.object({ id: z.string() })).parse(body);
      for (const { id } of created) {
        present.add(id);
      }
      return {};
    };

    const first = await installOperationsDashboard(request);

    expect(first.created).toEqual([
      'Data operations',
      ...defaultPanels.slice(1).map(({ name }) => name),
    ]);
    expect(first.skipped).toEqual([defaultPanels[0]?.name]);
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /dashboards',
      'POST /panels',
    ]);

    calls.length = 0;
    const again = await installOperationsDashboard(request);

    expect(again.created).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('ships the panels and the status endpoint in the bundle manifest', () => {
    const entries = z
      .object({
        'directus:extension': z.object({
          entries: z.array(z.object({ name: z.string(), type: z.string() })),
        }),
      })
      .parse(extensionManifest)
      ['directus:extension'].entries.map(({ name, type }) => `${type} ${name}`);

    expect(entries).toEqual(
      expect.arrayContaining([
        `endpoint ${statusEndpointId}`,
        `panel ${runOperationPanelId}`,
        `panel ${dataStatusPanelId}`,
      ]),
    );
  });
});

describe('the snapshot Flow file field', () => {
  test('is an item picker of the private folder files, and the import takes the pick', () => {
    const file = z
      .object({
        fields: z.array(
          z.object({
            field: z.string(),
            meta: z.looseObject({ interface: z.string() }),
          }),
        ),
      })
      .parse(snapshotImportFlow.options)
      .fields.find(({ field }) => field === 'file');
    const id = '6a1d9f0e-2b3c-4d5e-8f70-0000000016fd';

    expect(file?.meta.interface).toBe('collection-item-dropdown');
    expect(file?.meta).toMatchObject({
      options: { selectedCollection: 'directus_files' },
    });
    expect(
      importOptionsSchema.parse({
        file: { collection: 'directus_files', key: id },
      }),
    ).toEqual({ file: id });
    expect(importOptionsSchema.parse({ file: id })).toEqual({ file: id });
    expect(
      importOptionsSchema.safeParse({
        file: { collection: 'courses', key: id },
      }).success,
    ).toBe(false);
  });
});
